import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail } from '@/lib/claude'
import { sendEmail } from '@/lib/resend'
import { emailBodyToHtml } from '@/lib/utils'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { generateFollowUpEmail } from '@/lib/followup-generation'
import { determineNextEmailType, buildEmailHistory, buildReferenceChain } from '@/lib/email-sequence'
import { FOLLOW_UP_NUMBER } from '@/lib/stage-import'

// Generation + send + DB write normally completes in a few seconds; 3 minutes
// gives ample headroom before a stale lock is reclaimed from a crashed request.
const RESEND_LOCK_TTL_MS = 3 * 60 * 1000

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = createServiceClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  if (!lead.email) {
    return NextResponse.json({ error: 'Lead has no email address' }, { status: 400 })
  }

  // Serializes the entire check-then-send sequence below per lead, so two
  // concurrent/duplicate resend requests (double-click, client retry) can
  // never both pass the checks and both call the Resend API for this lead.
  const lockKey = `resend:${id}`
  const lockToken = await acquireLock(supabase, lockKey, RESEND_LOCK_TTL_MS)
  if (!lockToken) {
    return NextResponse.json(
      { error: 'A resend is already in progress for this lead. Please wait a moment and try again.' },
      { status: 409 }
    )
  }

  try {

  // Decide which email actually comes next for this lead — the initial
  // pitch, the next unsent follow-up stage, or nothing (sequence complete).
  // This must be re-derived from the emails table every time (not assumed
  // to be "initial" just because this is a manual click) — a lead can reach
  // this route already having a delivered initial_pitch, e.g. via the
  // automated sender, a prior manual send, or a backdated staged import.
  const { data: leadEmails } = await supabase
    .from('emails')
    .select('id, type, subject, body_text, body_html, sent_at, status, message_id')
    .eq('lead_id', id)

  const emails = leadEmails ?? []
  const decision = determineNextEmailType(emails)

  if (decision.kind === 'all_sent') {
    return NextResponse.json(
      { error: 'All emails (initial pitch + follow-ups 1-3) have already been sent to this lead.' },
      { status: 409 }
    )
  }

  const emailType = decision.kind === 'initial' ? 'initial_pitch' : decision.type

  // Block re-sends of this exact stage when a previous attempt was delivered
  // but not recorded cleanly. Re-sending would cause a duplicate delivery.
  // Use the repair script to resolve these first.
  const { data: syncFailed } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', id)
    .eq('type', emailType)
    .eq('status', 'email_sync_failed')
    .limit(1)
    .maybeSingle()

  if (syncFailed) {
    return NextResponse.json(
      { error: 'A previous send attempt was delivered but not recorded cleanly. Run the repair script before re-sending to avoid a duplicate.' },
      { status: 409 }
    )
  }

  let emailRowId: string | null = null
  let subject: string
  let bodyHtml: string
  let bodyText: string
  let references: string[] = []

  if (decision.kind === 'initial') {
    // Look for the existing pending_send draft — the same record we will mark sent.
    const { data: pendingEmail } = await supabase
      .from('emails')
      .select('id, subject, body_html, body_text')
      .eq('lead_id', id)
      .eq('type', 'initial_pitch')
      .eq('status', 'pending_send')
      .limit(1)
      .maybeSingle()

    emailRowId = pendingEmail?.id ?? null

    if (pendingEmail?.subject && pendingEmail?.body_html) {
      subject  = pendingEmail.subject
      bodyHtml = pendingEmail.body_html
      bodyText = pendingEmail.body_text ?? ''
    } else {
      // No draft yet (lead is new/researched) — generate content on the fly.
      const contentType = lead.content_type ?? 'remote'

      const emailResult = await writeOutreachEmail({
        business_name: lead.business_name,
        category:      lead.category_name,
        suburb:        lead.suburb ?? '',
        city:          lead.city,
        website:       lead.website ?? '',
        description:   lead.description ?? '',
        services:      lead.services ?? '',
        content_type:  contentType,
      })

      subject  = emailResult.subject
      bodyText = emailResult.body
      bodyHtml = emailBodyToHtml(emailResult.body)
    }
  } else {
    // Next stage is a follow-up — generate it from the full thread history,
    // the same writer (generateFollowUpEmail) the automated daily cron uses,
    // so manual and automated follow-ups are worded identically per stage.
    const contentType = lead.content_type ?? 'remote'
    const history = buildEmailHistory(emails)
    references = buildReferenceChain(emails)

    const generated = await generateFollowUpEmail(
      decision.type,
      {
        businessName: lead.business_name,
        category:     lead.category_name ?? '',
        suburb:       lead.suburb ?? '',
        city:         lead.city ?? '',
        website:      lead.website ?? '',
        description:  lead.description ?? '',
        services:     lead.services ?? '',
        notes:        lead.notes ?? '',
        contentType,
      },
      decision.initialEmail.subject,
      history
    )

    subject  = generated.subject
    bodyText = generated.body
    bodyHtml = generated.html
  }

  const result = await sendEmail({
    to:      lead.email,
    subject,
    html:    bodyHtml,
    text:    bodyText,
    leadId:  id,
    references: references.length ? references : undefined,
  })

  if (!result) {
    return NextResponse.json({ error: 'Failed to send email — check Resend API key' }, { status: 500 })
  }

  const sentAt = new Date().toISOString()

  if (emailRowId) {
    // Update the existing pending_send row in place — same record, now sent.
    const { error: emailUpdateErr } = await supabase.from('emails').update({
      status:     'sent',
      resend_id:  result.id,
      message_id: result.messageId,
      sent_at:    sentAt,
    }).eq('id', emailRowId)

    if (emailUpdateErr) {
      await handleEmailSyncFailure(supabase, {
        agent:    'resend-route',
        emailId:  emailRowId,
        leadId:   id,
        resendId: result.id,
        sentAt,
        context: { original_db_error: emailUpdateErr.message },
      })
      return NextResponse.json(
        { error: 'Email delivered but database record could not be updated — marked as Sync Failed. No re-send needed.' },
        { status: 500 }
      )
    }
  } else {
    // No pre-existing draft — insert the single sent record.
    const { data: inserted, error: insertErr } = await supabase.from('emails').insert({
      lead_id:    id,
      type:       emailType,
      subject,
      body_html:  bodyHtml,
      body_text:  bodyText,
      status:     'sent',
      resend_id:  result.id,
      message_id: result.messageId,
      sent_at:    sentAt,
    }).select('id').single()

    if (insertErr) {
      // Email delivered but no row to update — insert a recovery row directly.
      console.error('[resend] DB error inserting email row:', insertErr.message, { lead_id: id, resend_id: result.id })
      await supabase.from('emails').insert({
        lead_id:    id,
        type:       emailType,
        subject,
        body_html:  bodyHtml,
        body_text:  bodyText,
        status:     'email_sync_failed',
        resend_id:  result.id,
        message_id: result.messageId,
        sent_at:    sentAt,
      })
      await supabase.from('leads').update({ status: 'contacted', updated_at: sentAt }).eq('id', id)
      return NextResponse.json(
        { error: 'Email delivered but database record could not be created — marked as Sync Failed. No re-send needed.' },
        { status: 500 }
      )
    }
    emailRowId = inserted?.id ?? null
  }

  if (decision.kind === 'follow_up' && emailRowId) {
    await supabase.from('follow_ups').insert({
      lead_id:           id,
      follow_up_number:  FOLLOW_UP_NUMBER[decision.type],
      scheduled_at:      sentAt,
      sent_at:           sentAt,
      email_id:          emailRowId,
      status:            'sent',
    })
  }

  await Promise.all([
    supabase.from('leads').update({
      status:     'contacted',
      updated_at: sentAt,
    }).eq('id', id),
    supabase.from('activity_log').insert({
      event_type:  decision.kind === 'initial' ? 'email_sent' : `${decision.type}_sent`,
      lead_id:     id,
      description: decision.kind === 'initial'
        ? `Email sent to ${lead.business_name} (${lead.email})`
        : `Follow-up ${FOLLOW_UP_NUMBER[decision.type]} sent to ${lead.business_name} (${lead.email})`,
      metadata:    { subject, resend_id: result.id },
    }),
  ])

  return NextResponse.json({ success: true })

  } finally {
    await releaseLock(supabase, lockKey, lockToken)
  }
}
