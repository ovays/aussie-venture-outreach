import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail } from '@/lib/claude'
import { sendEmail } from '@/lib/resend'
import { emailBodyToHtml } from '@/lib/utils'

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
    const isSydney = lead.city?.toLowerCase() === 'sydney'
    const VISIT_ELIGIBLE = [
      'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
      'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
      'Spas / Massage Studios', 'Hotels / Resorts',
    ]
    const contentType = (isSydney && VISIT_ELIGIBLE.includes(lead.category_name)) ? 'visit' : 'remote'

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
    await supabase.from('emails').update({
      status:    'sent',
      resend_id: result.id,
      sent_at:   sentAt,
    }).eq('id', emailRowId)
  } else {
    // No pre-existing draft — insert the single sent record.
    const { data: inserted } = await supabase.from('emails').insert({
      lead_id:   id,
      type:      'initial_pitch',
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      status:    'sent',
      resend_id: result.id,
      sent_at:   sentAt,
    }).select('id').single()
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
