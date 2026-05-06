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

  // Try to reuse most recent email draft for this lead
  const { data: existingEmail } = await supabase
    .from('emails')
    .select('subject, body_html, body_text')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let subject: string
  let bodyHtml: string
  let bodyText: string

  if (existingEmail?.subject && existingEmail?.body_html) {
    subject  = existingEmail.subject
    bodyHtml = existingEmail.body_html
    bodyText = existingEmail.body_text ?? ''
  } else {
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

  await Promise.all([
    supabase.from('emails').insert({
      lead_id:   id,
      type:      'initial_pitch',
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      status:    'sent',
    }),
    supabase.from('leads').update({
      status:     'contacted',
      updated_at: new Date().toISOString(),
    }).eq('id', id),
    supabase.from('activity_log').insert({
      event_type:  'email_sent',
      lead_id:     id,
      description: `Email resent to ${lead.business_name} (${lead.email})`,
      metadata:    { subject, resend_id: result.id },
    }),
  ])

  return NextResponse.json({ success: true })
}
