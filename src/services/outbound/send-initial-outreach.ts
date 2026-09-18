import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail, UncertainEmailDeliveryError } from '@/lib/resend'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { isDeliverySuppressedForAddress } from '@/lib/delivery-suppression'
import { claimRecipientOutreach, removeLeadFromInitialOutreachQueue } from '@/lib/data-quality'
import { outboundIdempotencyKey, outboundMessageId } from '@/lib/outbound-send'
import { observability } from '@/lib/observability/service'
import { serviceFailure, type ServiceExecutionResult } from '@/services/result'

export interface SendInitialOutreachInput {
  client: SupabaseClient
  leadId: string
  decisionReason?: string
  send?: typeof sendEmail
}

/** Exact-lead deterministic delivery operation. Selection and routing stay outside. */
export async function sendInitialOutreach(input: SendInitialOutreachInput): Promise<ServiceExecutionResult> {
  const selected = await input.client.from('emails')
    .select('id,lead_id,subject,body_html,body_text,status,leads!inner(id,email,business_name,status,source,delivery_suppressed_emails)')
    .eq('lead_id', input.leadId).eq('type', 'initial_pitch').eq('status', 'pending_send')
    .order('created_at', { ascending: true }).limit(1).maybeSingle()
  if (selected.error || !selected.data) return serviceFailure(selected.error?.message ?? 'pending_initial_not_found')
  const record = selected.data as unknown as {
    id: string; subject: string; body_html: string; body_text: string
    leads: { email: string | null; status: string; source: string | null; delivery_suppressed_emails: string[] | null }
  }
  const lead = record.leads
  if (!lead.email || lead.status !== 'email_ready') return { outcome: 'skipped', changedState: false, details: { reason: 'lead_not_sendable' } }
  if (lead.source === 'manual') return { outcome: 'skipped', changedState: false, details: { reason: 'manual_source_requires_manual_send' } }
  if (isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails)) {
    await removeLeadFromInitialOutreachQueue(input.client, input.leadId, 'suppressed')
    return { outcome: 'skipped', changedState: true, details: { reason: 'delivery_suppressed' } }
  }
  const ownership = await claimRecipientOutreach(input.client, input.leadId, 'initial')
  if (!ownership.allowed) {
    await input.client.from('emails').update({ status: 'failed' }).eq('id', record.id)
    await removeLeadFromInitialOutreachQueue(input.client, input.leadId)
    return { outcome: 'skipped', changedState: true, details: { reason: ownership.reason ?? 'recipient_not_owned' } }
  }
  const already = await input.client.from('emails').select('id').eq('lead_id', input.leadId)
    .in('status', ['sent', 'email_sync_failed']).neq('id', record.id).limit(1)
  if (already.error) return serviceFailure(already.error.message, true)
  if (already.data?.length) {
    await input.client.from('emails').update({ status: 'failed' }).eq('id', record.id)
    await input.client.from('leads').update({ status: 'contacted' }).eq('id', input.leadId).eq('status', 'email_ready')
    return { outcome: 'completed', changedState: true, details: { reason: 'already_delivered' } }
  }
  try {
    const current = await input.client.from('leads').select('status,email,delivery_suppressed_emails').eq('id', input.leadId).maybeSingle()
    if (current.error || !current.data?.email || current.data.status !== 'email_ready') {
      return { outcome: 'skipped', changedState: false, details: { reason: 'send_time_lead_not_sendable' } }
    }
    if (isDeliverySuppressedForAddress(current.data.email, current.data.delivery_suppressed_emails)) {
      await removeLeadFromInitialOutreachQueue(input.client, input.leadId, 'suppressed')
      return { outcome: 'skipped', changedState: true, details: { reason: 'send_time_delivery_suppressed' } }
    }
    const send = input.send ?? sendEmail
    const delivered = await send({
      to: current.data.email, subject: record.subject, html: record.body_html, text: record.body_text,
      leadId: input.leadId, idempotencyKey: outboundIdempotencyKey(record.id), messageId: outboundMessageId(record.id),
      emailIntentId: record.id, phase: 'initial_pitch',
    })
    if (!delivered) {
      await input.client.from('emails').update({ status: 'failed' }).eq('id', record.id)
      return serviceFailure('provider_returned_no_delivery', true)
    }
    const sentAt = new Date().toISOString()
    const emailUpdate = await input.client.from('emails').update({
      status: 'sent', resend_id: delivered.id, message_id: delivered.messageId, sent_at: sentAt,
    }).eq('id', record.id)
    if (emailUpdate.error) {
      await handleEmailSyncFailure(input.client, {
        agent: 'outbound.initial', emailId: record.id, leadId: input.leadId, resendId: delivered.id, sentAt,
      })
      return serviceFailure('email_sync_failed')
    }
    const leadUpdate = await input.client.from('leads').update({ status: 'contacted', updated_at: sentAt })
      .eq('id', input.leadId).eq('status', 'email_ready')
    if (leadUpdate.error) return serviceFailure(leadUpdate.error.message, true)
    await observability().observeLeadStatusTransition({
      leadId: input.leadId, fromStatus: 'email_ready', toStatus: 'contacted',
      actor: 'outbound.initial', reasonCode: input.decisionReason ?? 'INITIAL_CONTENT_READY',
    })
    return { outcome: 'completed', changedState: true, details: { email_id: record.id, provider_accepted: true } }
  } catch (error) {
    if (error instanceof UncertainEmailDeliveryError) return serviceFailure('provider_delivery_uncertain', true)
    throw error
  }
}
