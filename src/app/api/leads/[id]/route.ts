import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { deleteLeads, LeadIdsValidationError, normalizeLeadIds } from '@/lib/delete-leads'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const [
    { data: lead, error },
    { data: emails },
    { data: activityLog },
    { data: deals },
    { data: dmQueue },
  ] = await Promise.all([
    supabase.from('leads').select('*').eq('id', id).single(),
    supabase
      .from('emails')
      .select('id, type, subject, body_text, status, sent_at, replied_at, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('activity_log')
      .select('id, event_type, description, metadata, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('deals')
      .select('id, deal_value, deal_type, content_created, payment_received, notes, closed_at')
      .eq('lead_id', id)
      .order('closed_at', { ascending: false }),
    supabase
      .from('dm_queue')
      .select('id, platform, status, sent_at, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  if (error || !lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    data: {
      ...lead,
      emails: emails ?? [],
      activity_log: activityLog ?? [],
      deals: deals ?? [],
      dm_queue: dmQueue ?? [],
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const updates = await request.json() as Record<string, unknown>

  const { data, error } = await supabase
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (updates.status === 'closed_manual') {
    await supabase.from('dm_queue').update({ status: 'skipped' }).eq('lead_id', id).eq('status', 'pending')
    await supabase.from('follow_ups').update({ status: 'cancelled' }).eq('lead_id', id).eq('status', 'scheduled')
  }

  return NextResponse.json({ data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  const { id } = await params
  const supabase = await createClient()

  try {
    const [leadId] = normalizeLeadIds([id])
    const result = await deleteLeads(supabase, [leadId])
    if (result.deleted === 0) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof LeadIdsValidationError) {
      return NextResponse.json({ error: 'Invalid lead ID' }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not delete lead' },
      { status: 500 },
    )
  }
}
