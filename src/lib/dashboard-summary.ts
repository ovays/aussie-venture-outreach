import type { HotLead } from '@/components/dashboard/HotLeadsPanel'
import type { DashboardMetrics, DailyActivityRow } from '@/lib/analytics'
import { POSITIVE_RESPONSE_STATUSES } from '@/lib/lead-status'

export interface DashboardActivityEvent {
  id: string
  event_type: string
  description: string
  created_at: string
  lead_id: string | null
}

export interface WeeklyRevenueRow {
  week: string
  revenue: number
}

export interface DashboardSummary {
  analytics: DashboardMetrics
  statusMap: Record<string, number>
  recentActivity: DashboardActivityEvent[]
  pendingDMCount: number
  dealsRolling30DayCount: number
  weeklyRevenue: WeeklyRevenueRow[]
  hotLeads: HotLead[]
}

interface DashboardSummaryWire {
  as_of: string
  today_range: {
    timezone: string
    start: string
    end: string
    date_key: string
  }
  status_counts: Record<string, number>
  today_email_stats: {
    total_sent: number
    initial_sent: number
    followups_sent: number
    follow_up_1_sent: number
    follow_up_2_sent: number
    follow_up_3_sent: number
  }
  today_dm_stats: { sent_today: number }
  reply_stats: {
    total_contacted_leads: number
    positive_response_leads: number
    replies_today: number
    reply_rate: number
  }
  followup_stats: {
    sent_today: number
    total_sent: number
    pending: number
    follow_up_1_sent_today: number
    follow_up_2_sent_today: number
    follow_up_3_sent_today: number
    pending_follow_up_1: number
    pending_follow_up_2: number
    pending_follow_up_3: number
    fu1_due: number
    fu2_due: number
    fu3_due: number
    fu_due: number
    reactivation_total: number
    overdue_total: number
  }
  daily_activity: Array<{
    date: string
    label: string
    leads_found: number
    emails_sent: number
    dms_queued: number
    followups_sent: number
  }>
  emails_sent_this_week: number
  dms_queued: number
  deals_rolling_30_days: number
  weekly_revenue: Array<{ week: string; revenue: number }>
  recent_activity: Array<{
    id: string
    event_type: string
    description: string
    created_at: string
  }>
  hot_leads: Array<{
    id: string
    business_name: string
    city: string
    status: string
    emails: Array<{
      type: string
      sent_at: string | null
      replied_at: string | null
      subject: string | null
    }>
  }>
}

type DashboardRpcClient = {
  rpc: (
    functionName: string,
    args: { p_as_of: string }
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

function iso(value: string): string {
  return new Date(value).toISOString()
}

function requireWireSummary(value: unknown): DashboardSummaryWire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Dashboard summary RPC returned an invalid payload')
  }
  return value as DashboardSummaryWire
}

export function adaptDashboardSummary(data: unknown): DashboardSummary {
  const wire = requireWireSummary(data)
  const dailyRows: DailyActivityRow[] = wire.daily_activity.map((row) => ({
    date: row.date,
    label: row.label,
    leadsFound: Number(row.leads_found),
    emailsSent: Number(row.emails_sent),
    dmsQueued: Number(row.dms_queued),
    followupsSent: Number(row.followups_sent),
  }))

  return {
    analytics: {
      todayEmailStats: {
        range: {
          timezone: wire.today_range.timezone,
          start: iso(wire.today_range.start),
          end: iso(wire.today_range.end),
          dateKey: wire.today_range.date_key,
        },
        emails: [],
        totalSent: Number(wire.today_email_stats.total_sent),
        initialSent: Number(wire.today_email_stats.initial_sent),
        followupsSent: Number(wire.today_email_stats.followups_sent),
        followUp1Sent: Number(wire.today_email_stats.follow_up_1_sent),
        followUp2Sent: Number(wire.today_email_stats.follow_up_2_sent),
        followUp3Sent: Number(wire.today_email_stats.follow_up_3_sent),
      },
      todayDmStats: {
        sentToday: Number(wire.today_dm_stats.sent_today),
      },
      replyStats: {
        totalContactedLeads: Number(wire.reply_stats.total_contacted_leads),
        positiveResponseLeads: Number(wire.reply_stats.positive_response_leads),
        repliesToday: Number(wire.reply_stats.replies_today),
        replyRate: Number(wire.reply_stats.reply_rate),
        statusesCounted: [...POSITIVE_RESPONSE_STATUSES],
      },
      followupStats: {
        sentToday: Number(wire.followup_stats.sent_today),
        totalSent: Number(wire.followup_stats.total_sent),
        pending: Number(wire.followup_stats.pending),
        followUp1SentToday: Number(wire.followup_stats.follow_up_1_sent_today),
        followUp2SentToday: Number(wire.followup_stats.follow_up_2_sent_today),
        followUp3SentToday: Number(wire.followup_stats.follow_up_3_sent_today),
        pendingFollowUp1: Number(wire.followup_stats.pending_follow_up_1),
        pendingFollowUp2: Number(wire.followup_stats.pending_follow_up_2),
        pendingFollowUp3: Number(wire.followup_stats.pending_follow_up_3),
        fu1Due: Number(wire.followup_stats.fu1_due),
        fu2Due: Number(wire.followup_stats.fu2_due),
        fu3Due: Number(wire.followup_stats.fu3_due),
        fuDue: Number(wire.followup_stats.fu_due),
        reactivationTotal: Number(wire.followup_stats.reactivation_total),
        overdueTotal: Number(wire.followup_stats.overdue_total),
      },
      dailyRows,
      emailsSentThisWeek: Number(wire.emails_sent_this_week),
    },
    statusMap: Object.fromEntries(
      Object.entries(wire.status_counts ?? {}).map(([status, count]) => [status, Number(count)])
    ),
    recentActivity: wire.recent_activity.map((event) => ({
      ...event,
      created_at: iso(event.created_at),
      lead_id: null,
    })),
    pendingDMCount: Number(wire.dms_queued),
    dealsRolling30DayCount: Number(wire.deals_rolling_30_days),
    weeklyRevenue: wire.weekly_revenue.map((row) => ({
      week: row.week,
      revenue: Number(row.revenue),
    })),
    hotLeads: wire.hot_leads.map((lead) => ({
      ...lead,
      notes: null,
      created_at: '',
      emails: lead.emails.map((email) => ({ ...email, id: '' })),
    })),
  }
}

export async function getDashboardSummary(
  supabase: DashboardRpcClient,
  asOf = new Date()
): Promise<DashboardSummary> {
  const { data, error } = await supabase.rpc('get_dashboard_summary', {
    p_as_of: asOf.toISOString(),
  })

  if (error) {
    throw new Error(`Dashboard summary RPC failed: ${error.message}`)
  }

  return adaptDashboardSummary(data)
}
