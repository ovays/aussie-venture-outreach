import type { SupabaseClient } from '@supabase/supabase-js'
import { sendFollowUp as deliverFollowUp } from '../../../agents/followup'
import type { FollowUpType } from '@/lib/followup-eligibility'
import { serviceFailure, type ServiceExecutionResult } from '@/services/result'

export interface SendFollowUpInput {
  client: SupabaseClient
  leadId: string
  type: FollowUpType
  daysSinceInitial?: number
}

/** Executes one explicitly requested follow-up stage for one exact lead. */
export async function sendFollowUp(input: SendFollowUpInput): Promise<ServiceExecutionResult> {
  const selected = await input.client.from('leads')
    .select('id,business_name,email,category_id,category_name,content_type,suburb,city,website,description,services,notes,delivery_suppressed_emails,reactivation_sent_at,emails(id,type,subject,body_text,sent_at,status,message_id)')
    .eq('id', input.leadId).eq('status', 'contacted').maybeSingle()
  if (selected.error || !selected.data) return serviceFailure(selected.error?.message ?? 'contacted_lead_not_found')
  const lead = selected.data as any
  const initialEmail = (lead.emails ?? []).find((email: any) => email.type === 'initial_pitch' && email.sent_at)
  if (!initialEmail) return serviceFailure('sent_initial_not_found')
  const alreadyDelivered = (lead.emails ?? []).some((email: any) =>
    email.type === input.type && (email.status === 'sent' || email.status === 'email_sync_failed'))
  if (alreadyDelivered) return { outcome: 'completed', changedState: true, details: { reason: 'already_delivered' } }

  const delivered = await deliverFollowUp(
    input.client as Parameters<typeof deliverFollowUp>[0],
    { lead, initialEmail, daysSince: input.daysSinceInitial ?? 0 },
    input.type,
  )
  if (delivered) return { outcome: 'completed', changedState: true, details: { follow_up_type: input.type } }
  const after = await input.client.from('emails').select('id').eq('lead_id', input.leadId)
    .eq('type', input.type).in('status', ['sent', 'email_sync_failed']).limit(1)
  if (after.error) return serviceFailure(after.error.message, true)
  return after.data?.length
    ? { outcome: 'completed', changedState: true, details: { follow_up_type: input.type, reason: 'concurrent_delivery_observed' } }
    : { outcome: 'skipped', changedState: false, details: { follow_up_type: input.type, reason: 'send_recheck_blocked' } }
}
