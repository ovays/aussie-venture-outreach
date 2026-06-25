import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export type EmailStatus = 'pending_send' | 'sent' | 'failed' | 'bounced' | 'email_sync_failed'

export const EMAIL_STATUS = {
  PENDING_SEND:      'pending_send'      as const,
  SENT:              'sent'              as const,
  FAILED:            'failed'            as const,
  BOUNCED:           'bounced'           as const,
  EMAIL_SYNC_FAILED: 'email_sync_failed' as const,
} satisfies Record<string, EmailStatus>

/**
 * Called after an email is dispatched via Resend (or manually confirmed sent)
 * but the subsequent DB update to status='sent' fails.
 *
 * Best-efforts (in order):
 *  1. Update the email row to email_sync_failed + preserve resend_id + set sent_at
 *     so follow-up eligibility (which uses sent_at) treats it as delivered.
 *  2. Advance the lead to 'contacted' so the follow-up cadence can proceed.
 *
 * Never throws. Caller should still treat the operation as failed and surface
 * the original DB error. Designed for every send path: agent and API route.
 */
export async function handleEmailSyncFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  {
    agent,
    emailId,
    leadId,
    resendId,
    sentAt,
    context = {},
  }: {
    agent: string
    emailId: string
    leadId: string
    resendId: string | null
    /** ISO timestamp of delivery — pass the same value you tried to write to sent_at */
    sentAt: string
    context?: Record<string, unknown>
  }
): Promise<void> {
  logger.error(agent, 'EMAIL_SYNC_FAILED: email delivered but DB update failed', {
    email_id: emailId,
    lead_id: leadId,
    resend_id: resendId,
    sent_at: sentAt,
    ...context,
  })

  const { error: markErr } = await supabase
    .from('emails')
    .update({
      status:    EMAIL_STATUS.EMAIL_SYNC_FAILED,
      resend_id: resendId,
      sent_at:   sentAt,
    })
    .eq('id', emailId)

  if (markErr) {
    logger.error(agent, 'EMAIL_SYNC_FAILED: could not mark email_sync_failed — row may still be pending_send', {
      email_id:  emailId,
      resend_id: resendId,
      error:     markErr.message,
    })
  } else {
    logger.info(agent, 'EMAIL_SYNC_FAILED: email row marked email_sync_failed', {
      email_id:  emailId,
      resend_id: resendId,
    })
  }

  const { error: leadErr } = await supabase
    .from('leads')
    .update({ status: 'contacted' })
    .eq('id', leadId)

  if (leadErr) {
    logger.error(agent, 'EMAIL_SYNC_FAILED: could not advance lead to contacted', {
      lead_id: leadId,
      error:   leadErr.message,
    })
  } else {
    logger.info(agent, 'EMAIL_SYNC_FAILED: lead advanced to contacted', { lead_id: leadId })
  }
}

/**
 * Called when an email was dispatched but the DB INSERT for the email row failed
 * (followup, reactivation — no pre-existing row to update).
 *
 * Inserts a minimal recovery row with email_sync_failed + resend_id + sent_at
 * so the row appears in the log and is blocked from future automated sends.
 * sent_at is set so follow-up eligibility (isFuEmailSent) treats it as delivered.
 *
 * Never throws.
 */
export async function insertEmailSyncFailedRecovery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  {
    agent,
    leadId,
    type,
    subject,
    bodyHtml,
    bodyText,
    resendId,
    sentAt,
  }: {
    agent: string
    leadId: string
    type: string
    subject: string
    bodyHtml: string
    bodyText: string
    resendId: string
    sentAt: string
  }
): Promise<void> {
  logger.error(agent, 'EMAIL_SYNC_FAILED: email delivered but DB insert failed — inserting recovery row', {
    lead_id:   leadId,
    type,
    resend_id: resendId,
    sent_at:   sentAt,
  })

  // upsert on resend_id (UNIQUE constraint added in migration 024).
  // ignoreDuplicates:true means a second call with the same resend_id is a
  // DB-level no-op — the helper is idempotent independently of retry behaviour.
  //
  // DO NOTHING (ignoreDuplicates) rather than DO UPDATE because the first
  // successful insert already has the correct data; overwriting it on a retry
  // would be redundant at best and could silently change subject/body if the
  // caller somehow passed different values (e.g. regenerated copy).
  const { error: insertErr } = await supabase.from('emails').upsert(
    {
      lead_id:   leadId,
      type,
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      resend_id: resendId,
      status:    EMAIL_STATUS.EMAIL_SYNC_FAILED,
      sent_at:   sentAt,
    },
    { onConflict: 'resend_id', ignoreDuplicates: true }
  )

  if (insertErr) {
    logger.error(agent, 'EMAIL_SYNC_FAILED: could not insert recovery row — delivery has no DB record', {
      lead_id:   leadId,
      type,
      resend_id: resendId,
      error:     insertErr.message,
    })
  } else {
    logger.info(agent, 'EMAIL_SYNC_FAILED: recovery row inserted', {
      lead_id:   leadId,
      type,
      resend_id: resendId,
    })
  }
}
