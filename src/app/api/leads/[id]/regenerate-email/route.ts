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
    .select('id, business_name, category_name, suburb, city, website, description, services, status')
    .eq('id', id)
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  if (lead.status !== 'email_ready') {
    return NextResponse.json({ error: 'Lead must be in email_ready status' }, { status: 400 })
  }

  const { data: pending, error: emailErr } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', id)
    .eq('type', 'initial_pitch')
    .eq('status', 'pending_send')
    .limit(1)
    .maybeSingle()

  if (emailErr || !pending) {
    return NextResponse.json({ error: 'No pending email found for this lead' }, { status: 404 })
  }

  const isSydney = lead.city?.toLowerCase() === 'sydney'
  const contentType = (isSydney && VISIT_ELIGIBLE.includes(lead.category_name)) ? 'visit' : 'remote'

  const result = await writeOutreachEmail({
    business_name: lead.business_name,
    category: lead.category_name,
    suburb: lead.suburb ?? '',
    city: lead.city,
    website: lead.website ?? '',
    description: lead.description ?? '',
    services: lead.services ?? '',
    content_type: contentType,
  })

  const { data: updated, error: updateErr } = await supabase
    .from('emails')
    .update({
      subject: result.subject,
      body_text: result.body,
      body_html: emailBodyToHtml(result.body),
      edited_at: null,
      edited_by_user: false,
    })
    .eq('id', pending.id)
    .select()
    .single()

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ data: updated })
}
