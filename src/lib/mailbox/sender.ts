import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { ensureFreshAccessToken, listMailboxConnections } from './connections'
import { MailboxProviderError } from './errors'
import { getMailboxProvider } from './registry'
import type { MailboxSendRequest, MailboxSendResult } from './types'
import { assertOutreachSendEnabled } from '@/lib/side-effect-safety'
import { assertCanaryProviderBoundary, isV2CanaryEnabled } from '@/lib/v2-canary-safety'
import { requireWorkspaceIdForServiceClient } from '@/lib/supabase/workspace-service'
import { consumeOutboundEmailQuota } from '@/lib/quota/gate'

function validateSendEnvelope(request: MailboxSendRequest): void {
  const headers: Array<[string, string]> = [
    ['recipient', request.to],
    ['subject', request.subject],
    ['message id', request.messageId],
    ...((request.references ?? []).map((value): [string, string] => ['reference', value])),
  ]
  for (const [field, value] of headers) {
    if (!value || /[\r\n]/.test(value)) {
      throw new MailboxProviderError('DELIVERY_REJECTED', `Invalid outbound ${field}`)
    }
  }
  if (request.subject.length > 500 || request.html.length > 100_000 || request.text.length > 50_000) {
    throw new MailboxProviderError('DELIVERY_REJECTED', 'Outbound message exceeds the allowed size')
  }
}

export async function sendThroughWorkspaceMailbox(supabase: SupabaseClient<Database>, request: MailboxSendRequest): Promise<MailboxSendResult> {
  assertOutreachSendEnabled('Mailbox provider delivery')
  assertCanaryProviderBoundary({ leadId: request.leadId, phase: request.phase })
  try {
    const workspaceId = requireWorkspaceIdForServiceClient(supabase)
    const claimed = await supabase.rpc('claim_outbound_email_for_send' as never, {
      p_workspace_id: workspaceId,
      p_email_id: request.emailIntentId,
      p_lead_id: request.leadId,
      p_message_id: request.messageId,
    } as never)
    if (claimed.error) throw new MailboxProviderError('UNKNOWN_PROVIDER_ERROR', 'Unable to verify outbound send authority')
    const authority = claimed.data as unknown as { claimed?: boolean; recipient?: string; reason?: string } | null
    if (!authority?.claimed || !authority.recipient) {
      const reason = authority?.reason ?? 'send authority denied'
      if (reason === 'recipient_suppressed' || reason === 'workspace_inactive' || reason === 'recipient_not_owned') {
        throw new MailboxProviderError('DELIVERY_REJECTED', `Outbound send blocked: ${reason}`)
      }
      throw new MailboxProviderError('SEND_INTENT_CONFLICT', `Outbound send blocked: ${reason}`)
    }

    const authoritativeRequest = { ...request, to: authority.recipient }
    try {
      validateSendEnvelope(authoritativeRequest)
      await consumeOutboundEmailQuota(workspaceId, request.emailIntentId)
    } catch (error) {
      // No provider call occurred. Release only our still-unresolved claim so
      // corrected content or entitlement/quota remediation can be retried.
      await supabase.from('emails').update({ status: 'pending_send', claimed_at: null })
        .eq('id', request.emailIntentId).eq('lead_id', request.leadId)
        .eq('status', 'sending').eq('message_id', request.messageId)
      throw error
    }
    // P16/P17 canary approval hashes and the dedicated canary credential are
    // bound to the existing Resend sender identity. Never substitute an OAuth
    // mailbox while canary mode is active.
    if (isV2CanaryEnabled()) return await getMailboxProvider('resend').send!(null, authoritativeRequest)

    const connections = await listMailboxConnections(supabase)
    const selected = connections.find((row) => row.is_default_sender && row.status === 'connected' && row.capabilities.canSend)
    if (!selected) return await getMailboxProvider('resend').send!(null, authoritativeRequest)
    const connection = await ensureFreshAccessToken(supabase, selected)
    return await getMailboxProvider(connection.provider).send!(connection, authoritativeRequest)
  } catch (error) {
    if (error instanceof MailboxProviderError && error.code === 'DELIVERY_UNCERTAIN') {
      await supabase.from('emails').update({ status: 'delivery_uncertain' }).eq('id', request.emailIntentId)
    }
    throw error
  }
}
