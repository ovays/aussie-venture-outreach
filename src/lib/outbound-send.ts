import type { SupabaseClient } from '@supabase/supabase-js'
import { workspaceRow } from '@/lib/supabase/workspace-service'

export type OutboundEmailType = 'initial_pitch' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3' | 'reactivation'

export interface OutboundIntentContent {
  leadId: string
  type: OutboundEmailType
  subject: string
  bodyHtml: string
  bodyText: string
}

export interface OutboundEmailIntent {
  id: string
  status: string
  resend_id: string | null
  message_id: string | null
  subject: string
  body_html: string
  body_text: string
}

export interface OutboundSendEnvelope {
  content_hash: string
  sender_identity: string
  recipient_fingerprint: string | null
  idempotency_key: string
  correlation_id: string | null
  approval_reference: string | null
}

export interface ClaimedOutboundEmailIntent extends OutboundEmailIntent {
  claimed_at: string | null
  send_envelope: OutboundSendEnvelope | null
}

/**
 * Atomic conditional claim. Only the worker whose single UPDATE transitions one
 * row from `pending_send` to `sending` may call the provider. The envelope is
 * persisted before provider submission and never contains message content.
 */
export async function claimOutboundEmailIntent(
  supabase: SupabaseClient,
  params: {
    leadId: string
    emailId: string
    messageId: string
    envelope: OutboundSendEnvelope
  },
): Promise<{ claimed: boolean; intent: ClaimedOutboundEmailIntent | null }> {
  const result = await supabase
    .from('emails')
    .update({
      status: 'sending',
      claimed_at: new Date().toISOString(),
      message_id: params.messageId,
      send_envelope: params.envelope as unknown as Record<string, unknown>,
    })
    .eq('id', params.emailId)
    .eq('lead_id', params.leadId)
    .eq('type', 'initial_pitch')
    .eq('status', 'pending_send')
    .select('id,status,resend_id,message_id,subject,body_html,body_text,claimed_at,send_envelope')
    .maybeSingle()
  if (result.error) throw new Error(`Atomic initial send claim failed: ${result.error.message}`)
  return {
    claimed: !!result.data,
    intent: result.data as unknown as ClaimedOutboundEmailIntent | null,
  }
}

export function outboundIdempotencyKey(emailId: string): string {
  return `reachagent-email-${emailId}`
}

export function outboundMessageId(emailId: string): string {
  return `<${emailId}@aussieventure.com>`
}

/**
 * Persists the irreversible-send intent first. A partial unique index permits
 * only one pending/delivered intent for a lead and phase. Concurrent workers
 * converge on the same row and therefore the same provider idempotency key.
 */
export async function ensureOutboundEmailIntent(
  supabase: SupabaseClient,
  content: OutboundIntentContent,
): Promise<{ intent: OutboundEmailIntent; created: boolean }> {
  const inserted = await supabase
    .from('emails')
    .insert(workspaceRow(supabase, {
      lead_id: content.leadId,
      type: content.type,
      subject: content.subject,
      body_html: content.bodyHtml,
      body_text: content.bodyText,
      status: 'pending_send',
    }))
    .select('id,status,resend_id,message_id,subject,body_html,body_text')
    .single()

  if (!inserted.error && inserted.data) {
    return { intent: inserted.data as OutboundEmailIntent, created: true }
  }
  if (inserted.error?.code !== '23505') {
    throw new Error(`Unable to persist outbound send intent: ${inserted.error?.message ?? 'unknown error'}`)
  }

  const existing = await supabase
    .from('emails')
    .select('id,status,resend_id,message_id,subject,body_html,body_text')
    .eq('lead_id', content.leadId)
    .eq('type', content.type)
    .in('status', ['pending_send', 'sending', 'sent', 'delivery_uncertain', 'email_sync_failed'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing.error || !existing.data) {
    throw new Error(`Unable to recover concurrent outbound send intent: ${existing.error?.message ?? 'missing intent'}`)
  }
  return { intent: existing.data as OutboundEmailIntent, created: false }
}
