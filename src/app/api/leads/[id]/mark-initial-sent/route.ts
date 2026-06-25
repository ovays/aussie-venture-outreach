import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, business_name, email, status')
    .eq('id', id)
    .single()

  if (leadErr || !lead) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  }

  if (lead.status !== 'email_ready') {
    return NextResponse.json({ error: 'Lead must be in email_ready status' }, { status: 400 })
  }

  const now = new Date().toISOString()

  const { data: pending } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', id)
    .eq('type', 'initial_pitch')
    .eq('status', 'pending_send')
    .limit(1)
    .maybeSingle()

  if (!pending) {
    return NextResponse.json(
      { error: 'No pending email found. Run the writer pipeline first so it can generate an email for this lead.' },
      { status: 400 }
    )
  }

  const { error: emailUpdateErr } = await supabase
    .from('emails')
    .update({ status: 'sent', sent_at: now })
    .eq('id', pending.id)

  if (emailUpdateErr) {
    return NextResponse.json({ error: 'Failed to update email record' }, { status: 500 })
  }

  await Promise.all([
    supabase
      .from('leads')
      .update({ status: 'contacted', updated_at: now })
      .eq('id', id),
    supabase.from('activity_log').insert({
      event_type:  'email_sent',
      lead_id:     id,
      description: `Initial email marked as sent for ${lead.business_name} (${lead.email ?? 'no email'})`,
      metadata:    { manual_initial_sent: true },
    }),
  ])

  return NextResponse.json({ success: true })
}
