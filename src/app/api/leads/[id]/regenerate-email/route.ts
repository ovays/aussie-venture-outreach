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
    .select('id, business_name, category_id, category_name, suburb, city, website, description, services, status, content_type')
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

  const mode = await readInitialEmailMode(supabase)
  const result = await routeInitialEmail(supabase, lead, mode, { operation: 'regenerate', pendingEmailId: pending.id })
  if (!result.ok) return NextResponse.json({ error: result.error.reason, details: result.error, mode }, { status: 422 })
  return NextResponse.json({ data: { id: result.emailId }, mode, outcome: result.outcome })
}
