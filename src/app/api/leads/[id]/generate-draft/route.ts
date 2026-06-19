import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { writeOutreachEmail } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'

const VISIT_ELIGIBLE = [
  'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
  'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
  'Spas / Massage Studios', 'Hotels / Resorts',
]

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, business_name, category_name, suburb, city, website, description, services, email, status, source')
    .eq('id', id)
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  if (lead.source !== 'manual') {
    return NextResponse.json({ error: 'Only manual leads can use on-demand draft generation' }, { status: 400 })
  }

  if (!lead.email) {
    return NextResponse.json({ error: 'Lead has no email address' }, { status: 400 })
  }

  if (lead.status !== 'researched') {
    return NextResponse.json({ error: `Lead is already ${lead.status}` }, { status: 400 })
  }

  // Idempotency: if a pending draft already exists, return success without re-generating
  const { data: existing } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', id)
    .eq('type', 'initial_pitch')
    .eq('status', 'pending_send')
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ success: true })
  }

  const isSydney = lead.city?.toLowerCase() === 'sydney'
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

  const { error: insertErr } = await supabase.from('emails').insert({
    lead_id:   id,
    type:      'initial_pitch',
    subject:   emailResult.subject,
    body_html: emailBodyToHtml(emailResult.body),
    body_text: emailResult.body,
    status:    'pending_send',
  })

  if (insertErr) {
    return NextResponse.json({ error: 'Failed to save draft' }, { status: 500 })
  }

  await supabase.from('leads').update({ status: 'email_ready' }).eq('id', id)

  return NextResponse.json({ success: true })
}
