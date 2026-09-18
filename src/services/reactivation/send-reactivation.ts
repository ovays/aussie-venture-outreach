import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/resend'
import { insertEmailSyncFailedRecovery } from '@/lib/email-status'
import { isDeliverySuppressedForAddress } from '@/lib/delivery-suppression'
import { claimRecipientOutreach } from '@/lib/data-quality'
import { ensureOutboundEmailIntent, outboundIdempotencyKey, outboundMessageId } from '@/lib/outbound-send'
import { generateStoredReactivation } from '@/lib/stored-sequence-templates'
import { serviceFailure, type ServiceExecutionResult } from '@/services/result'

export interface SendReactivationInput {
  client: SupabaseClient
  leadId: string
  send?: typeof sendEmail
}

/** Materializes and delivers reactivation for one exact lead; it never selects candidates. */
export async function sendReactivation(input: SendReactivationInput): Promise<ServiceExecutionResult> {
  const selected = await input.client.from('leads')
    .select('id,business_name,email,status,category_id,category_name,content_type,delivery_suppressed_emails,reactivation_sent_at')
    .eq('id', input.leadId).maybeSingle()
  if (selected.error || !selected.data) return serviceFailure(selected.error?.message ?? 'lead_not_found')
  const lead = selected.data
  if (!lead.email || lead.status !== 'contacted' || lead.reactivation_sent_at) {
    return { outcome: 'skipped', changedState: !!lead.reactivation_sent_at, details: { reason: 'reactivation_recheck_blocked' } }
  }
  if (isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails)) {
    return { outcome: 'skipped', changedState: false, details: { reason: 'delivery_suppressed' } }
  }
  const ownership = await claimRecipientOutreach(input.client, input.leadId, 'reactivation')
  if (!ownership.allowed) return { outcome: 'skipped', changedState: false, details: { reason: ownership.reason ?? 'recipient_not_owned' } }
  const content = await generateStoredReactivation(
    input.client, lead.category_id, lead.business_name, lead.category_name ?? 'local business', lead.content_type ?? 'remote',
  )
  const current = await input.client.from('leads').select('status,email,delivery_suppressed_emails,reactivation_sent_at')
    .eq('id', input.leadId).maybeSingle()
  if (current.error || !current.data?.email || current.data.status !== 'contacted' || current.data.reactivation_sent_at) {
    return { outcome: 'skipped', changedState: !!current.data?.reactivation_sent_at, details: { reason: 'send_time_reactivation_blocked' } }
  }
  if (isDeliverySuppressedForAddress(current.data.email, current.data.delivery_suppressed_emails)) {
    return { outcome: 'skipped', changedState: false, details: { reason: 'send_time_delivery_suppressed' } }
  }
  const { intent } = await ensureOutboundEmailIntent(input.client, {
    leadId: input.leadId, type: 'reactivation', subject: content.subject, bodyHtml: content.html, bodyText: content.body,
  })
  if (intent.status === 'sent' || intent.status === 'email_sync_failed') {
    return { outcome: 'completed', changedState: true, details: { reason: 'already_delivered' } }
  }
  const send = input.send ?? sendEmail
  const delivered = await send({
    to: current.data.email, subject: intent.subject, html: intent.body_html, text: intent.body_text,
    leadId: input.leadId, idempotencyKey: outboundIdempotencyKey(intent.id), messageId: outboundMessageId(intent.id),
    emailIntentId: intent.id, phase: 'reactivation',
  })
  if (!delivered) return serviceFailure('provider_returned_no_delivery', true)
  const sentAt = new Date().toISOString()
  const emailUpdate = await input.client.from('emails').update({
    status: 'sent', resend_id: delivered.id, message_id: delivered.messageId, sent_at: sentAt,
  }).eq('id', intent.id)
  if (emailUpdate.error) {
    await insertEmailSyncFailedRecovery(input.client, {
      agent: 'reactivation', leadId: input.leadId, type: 'reactivation', subject: intent.subject,
      bodyHtml: intent.body_html, bodyText: intent.body_text, resendId: delivered.id,
      messageId: delivered.messageId, sentAt,
    })
    return serviceFailure('email_sync_failed')
  }
  const leadUpdate = await input.client.from('leads').update({ reactivation_sent_at: sentAt })
    .eq('id', input.leadId).eq('status', 'contacted')
  if (leadUpdate.error) return serviceFailure(leadUpdate.error.message, true)
  return { outcome: 'completed', changedState: true, details: { provider_accepted: true, email_id: intent.id } }
}
