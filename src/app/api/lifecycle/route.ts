import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { LifecycleLead } from '@/types/lifecycle'
import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

interface EmailRow {
  type: string
  sent_at: string | null
}

interface LeadRow {
  id: string
  business_name: string
  email: string | null
  status: string
  reactivation_sent_at: string | null
  emails: EmailRow[]
}

interface Settings {
  fu1Days: number
  fu2Days: number
  deadLeadDays: number
  reactivationDelayDays: number
  deadAfterReactivationDays: number
  reactivationEnabled: boolean
}

export type { LifecycleLead }

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(isoDate).getTime() + days * 86_400_000).toISOString()
}

function computeLifecycle(lead: LeadRow, s: Settings, now = new Date()): LifecycleLead {
  const base = {
    id: lead.id,
    business_name: lead.business_name,
    email: lead.email ?? '',
  }

  const emails = lead.emails ?? []
  const initialEmail = emails.find((e) => e.type === 'initial_pitch' && e.sent_at)
  const fu1Email = emails.find((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
  const fu2Email = emails.find((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
  const fu3Email = emails.find((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

  // daysSinceInitial used only for early returns (dead / reactivation / unknown)
  // where computeFollowUpEligibility is not called.
  const daysSinceInitial = initialEmail?.sent_at
    ? Math.floor((now.getTime() - new Date(initialEmail.sent_at).getTime()) / 86_400_000)
    : null

  if (lead.status === 'dead') {
    return { ...base, stage: 'Dead', next_action: 'None', next_action_date: null, days_since_initial: daysSinceInitial, filter_key: 'dead', is_overdue: false }
  }

  if (lead.reactivation_sent_at) {
    const daysSinceReact = Math.floor((now.getTime() - new Date(lead.reactivation_sent_at).getTime()) / 86_400_000)
    const deadDate = addDays(lead.reactivation_sent_at, s.deadAfterReactivationDays)
    const isOverdue = daysSinceReact >= s.deadAfterReactivationDays
    return {
      ...base,
      stage: isOverdue ? 'Awaiting Dead' : 'Reactivated',
      next_action: 'Mark Dead',
      next_action_date: deadDate,
      days_since_initial: daysSinceInitial,
      filter_key: 'reactivation',
      is_overdue: isOverdue,
    }
  }

  if (!initialEmail?.sent_at) {
    return { ...base, stage: 'Unknown', next_action: 'None', next_action_date: null, days_since_initial: null, filter_key: 'none', is_overdue: false }
  }

  // Shared eligibility engine — same logic used by the follow-up sender agent.
  const eligibility = computeFollowUpEligibility(
    initialEmail.sent_at,
    !!fu1Email,
    !!fu2Email,
    !!fu3Email,
    { fu1Days: s.fu1Days, fu2Days: s.fu2Days, fu3Days: s.deadLeadDays },
    now
  )

  console.log('[LIFECYCLE_DEBUG]', {
    leadId:       lead.id,
    nextFuType:   eligibility.nextFuType,
    isDue:        eligibility.isDue,
    daysSince:    eligibility.daysSince,
    dueAtDays:    eligibility.dueAtDays,
    daysUntilDue: eligibility.daysUntilDue,
  })

  // FU2 already sent (nextFuType is 'follow_up_3' or null) → reactivation or dead path
  if (eligibility.nextFuType === null || eligibility.nextFuType === 'follow_up_3') {
    if (s.reactivationEnabled) {
      const reactDate = addDays(initialEmail.sent_at, s.reactivationDelayDays)
      const isOverdue = eligibility.daysSince >= s.reactivationDelayDays
      const baseStage = fu3Email ? 'Follow-up 3 Sent' : 'Follow-up 2 Sent'
      return {
        ...base,
        stage: isOverdue ? 'Reactivation Due' : baseStage,
        next_action: 'Send Reactivation',
        next_action_date: reactDate,
        days_since_initial: eligibility.daysSince,
        filter_key: 'reactivation',
        is_overdue: isOverdue,
      }
    } else {
      const deadDate = addDays(initialEmail.sent_at, s.deadLeadDays)
      const isOverdue = eligibility.daysSince >= s.deadLeadDays
      const baseStage = fu3Email ? 'Follow-up 3 Sent' : 'Follow-up 2 Sent'
      return {
        ...base,
        stage: baseStage,
        next_action: 'Mark Dead',
        next_action_date: deadDate,
        days_since_initial: eligibility.daysSince,
        filter_key: 'none',
        is_overdue: isOverdue,
      }
    }
  }

  // FU1 sent, FU2 pending
  if (eligibility.nextFuType === 'follow_up_2') {
    const fu2Date = addDays(initialEmail.sent_at, s.fu2Days)
    return {
      ...base,
      stage: 'Follow-up 1 Sent',
      next_action: 'Send Follow-up 2',
      next_action_date: fu2Date,
      days_since_initial: eligibility.daysSince,
      filter_key: 'fu2',
      is_overdue: eligibility.isDue,
    }
  }

  // No FUs sent, FU1 pending (nextFuType === 'follow_up_1')
  const fu1Date = addDays(initialEmail.sent_at, s.fu1Days)
  return {
    ...base,
    stage: 'Initial Sent',
    next_action: 'Send Follow-up 1',
    next_action_date: fu1Date,
    days_since_initial: eligibility.daysSince,
    filter_key: 'fu1',
    is_overdue: eligibility.isDue,
  }
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()

  const [{ data: settingsRows }, { data: contactedLeads }, { data: deadLeads }, { count: deadTodayCount }] =
    await Promise.all([
      supabase
        .from('settings')
        .select('key, value')
        .in('key', [
          'follow_up_1_days',
          'follow_up_2_days',
          'dead_lead_days',
          'reactivation_delay_days',
          'dead_after_reactivation_days',
          'reactivation_enabled',
        ]),
      supabase
        .from('leads')
        .select('id, business_name, email, status, reactivation_sent_at, emails(type, sent_at)')
        .eq('status', 'contacted')
        .order('created_at', { ascending: false }),
      supabase
        .from('leads')
        .select('id, business_name, email, status, reactivation_sent_at, emails(type, sent_at)')
        .eq('status', 'dead')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('activity_log')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'lead_marked_dead')
        .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ])

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const settings: Settings = {
    fu1Days: parseInt(sm['follow_up_1_days'] ?? '7', 10),
    fu2Days: parseInt(sm['follow_up_2_days'] ?? '14', 10),
    deadLeadDays: parseInt(sm['dead_lead_days'] ?? '21', 10),
    reactivationDelayDays: parseInt(sm['reactivation_delay_days'] ?? '60', 10),
    deadAfterReactivationDays: parseInt(sm['dead_after_reactivation_days'] ?? '14', 10),
    reactivationEnabled: sm['reactivation_enabled'] === 'true',
  }

  const now = new Date()
  const allLeads = [...(contactedLeads ?? []), ...(deadLeads ?? [])] as LeadRow[]
  const leads = allLeads
    .filter((l) => l.email)
    .map((l) => computeLifecycle(l, settings, now))

  const summary = {
    fu1_due: leads.filter((l) => l.filter_key === 'fu1' && l.is_overdue).length,
    fu2_due: leads.filter((l) => l.filter_key === 'fu2' && l.is_overdue).length,
    reactivation_due: leads.filter((l) => l.stage === 'Reactivation Due').length,
    awaiting_dead: leads.filter((l) => l.stage === 'Awaiting Dead').length,
    dead_today: deadTodayCount ?? 0,
  }

  return NextResponse.json({ leads, summary, settings })
}
