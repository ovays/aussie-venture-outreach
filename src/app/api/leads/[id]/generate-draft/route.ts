import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readInitialEmailMode, routeInitialEmail } from '@/lib/initial-email-router'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, business_name, category_id, category_name, suburb, city, website, description, services, email, status, source, content_type')
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

  if (!['researched', 'email_ready'].includes(lead.status)) {
    return NextResponse.json({ error: `Lead is already ${lead.status}` }, { status: 400 })
  }

  const mode = await readInitialEmailMode(supabase)
  const result = await routeInitialEmail(supabase, lead, mode)
  if (!result.ok) return NextResponse.json({ error: result.error.reason, details: result.error, mode }, { status: 422 })
  return NextResponse.json({ success: true, mode, outcome: result.outcome })
}
