import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { researchOneLead } from '@/lib/research-lead'
import { writeOneLead, type DmState } from '@/lib/write-lead'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'

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

  if (lead.status !== 'researched') {
    return NextResponse.json({ error: `Lead status is ${lead.status}, not researched` }, { status: 400 })
  }

  const { count: emailCount } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('lead_id', id)

  if ((emailCount ?? 0) > 0) {
    return NextResponse.json({ error: 'Lead already has emails — retry not needed' }, { status: 400 })
  }

  const { data: latestActivity } = await supabase
    .from('activity_log')
    .select('event_type')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestActivity?.event_type !== 'agent_error') {
    return NextResponse.json(
      { error: `Latest activity is "${latestActivity?.event_type ?? 'none'}", not agent_error` },
      { status: 400 }
    )
  }

  // Re-run research. researchOneLead handles its own error logging and sets
  // status='researched' on both success and failure paths.
  const researchResult = await researchOneLead(supabase, lead)

  if (!researchResult.success) {
    return NextResponse.json({ error: `Research failed: ${researchResult.error}` }, { status: 500 })
  }

  // Fetch the lead again — researchOneLead has now written enriched fields to the DB.
  const { data: enrichedLead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (!enrichedLead) {
    return NextResponse.json({ error: 'Failed to fetch enriched lead' }, { status: 500 })
  }

  // Build DM state
  const { data: dmLimitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_dm_limit')
    .single()
  const dailyDmLimit = parseInt(dmLimitSetting?.value ?? '10', 10)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const { count: todayDmCount } = await supabase
    .from('dm_queue')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString())
  const dmState: DmState = { dmsAddedToday: todayDmCount ?? 0, dailyDmLimit }

  const dedupeIndex = await fetchPipelineDedupeIndex(supabase)

  const writeResult = await writeOneLead(supabase, enrichedLead, dedupeIndex, dmState)

  if (!writeResult.success) {
    return NextResponse.json({ error: `Draft generation failed: ${writeResult.error}` }, { status: 500 })
  }

  return NextResponse.json({ success: true, channel: writeResult.channel })
}
