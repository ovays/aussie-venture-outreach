import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail } from '@/lib/claude'
import { sendEmail } from '@/lib/resend'
import { emailBodyToHtml } from '@/lib/utils'
import { handleEmailSyncFailure } from '@/lib/email-status'

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

  // Block re-sends for leads with an email_sync_failed record — the email was
  // already delivered (Resend accepted it) but DB sync failed. Re-sending would
  // cause a duplicate delivery. Use the repair script to resolve these first.
  const { data: syncFailed } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', id)
    .eq('type', 'initial_pitch')
    .eq('status', 'email_sync_failed')
    .limit(1)
    .maybeSingle()

  if (syncFailed) {
    return NextResponse.json(
      { error: 'A previous send attempt was delivered but not recorded cleanly. Run the repair script before re-sending to avoid a duplicate.' },
      { status: 409 }
    )
  }

  // Look for the existing pending_send draft — the same record we will mark sent.
  const { data: pendingEmail } = await supabase
    .from('emails')
    .select('id, subject, body_html, body_text')
    .eq('lead_id', id)
    .eq('type', 'initial_pitch')
    .eq('status', 'pending_send')
    .limit(1)
    .maybeSingle()

  let emailRowId: string | null = pendingEmail?.id ?? null
  let subject: string
  let bodyHtml: string
  let bodyText: string

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

  const result = await sendEmail({
    to:      lead.email,
    subject,
    html:    bodyHtml,
    text:    bodyText,
    leadId:  id,
  })

  if (!result) {
    return NextResponse.json({ error: 'Failed to send email — check Resend API key' }, { status: 500 })
  }

  const sentAt = new Date().toISOString()

  if (emailRowId) {
    // Update the existing pending_send row in place — same record, now sent.
    const { error: emailUpdateErr } = await supabase.from('emails').update({
      status:    'sent',
      resend_id: result.id,
      sent_at:   sentAt,
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
      lead_id:   id,
      type:      'initial_pitch',
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      status:    'sent',
      resend_id: result.id,
      sent_at:   sentAt,
    }).select('id').single()

    if (insertErr) {
      // Email delivered but no row to update — insert a recovery row directly.
      console.error('[resend] DB error inserting email row:', insertErr.message, { lead_id: id, resend_id: result.id })
      await supabase.from('emails').insert({
        lead_id:   id,
        type:      'initial_pitch',
        subject,
        body_html: bodyHtml,
        body_text: bodyText,
        status:    'email_sync_failed',
        resend_id: result.id,
        sent_at:   sentAt,
      })
      await supabase.from('leads').update({ status: 'contacted', updated_at: sentAt }).eq('id', id)
      return NextResponse.json(
        { error: 'Email delivered but database record could not be created — marked as Sync Failed. No re-send needed.' },
        { status: 500 }
      )
    }
    emailRowId = inserted?.id ?? null
  }

  await Promise.all([
    supabase.from('leads').update({
      status:     'contacted',
      updated_at: sentAt,
    }).eq('id', id),
    supabase.from('activity_log').insert({
      event_type:  'email_sent',
      lead_id:     id,
      description: `Email sent to ${lead.business_name} (${lead.email})`,
      metadata:    { subject, resend_id: result.id },
    }),
  ])

  return NextResponse.json({ success: true })
}
