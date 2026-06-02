const ANALYTICS_TIMEZONE = 'Australia/Sydney'
const DAY_MS = 86_400_000

type QueryClient = {
  from: (table: string) => any
}

type EmailType = 'initial_pitch' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3'

interface EmailAnalyticsRow {
  id: string
  lead_id: string | null
  type: EmailType
  status?: string | null
  sent_at: string | null
  replied_at: string | null
  leads?: { business_name: string } | { business_name: string }[] | null
}

interface ContactedFollowupLead {
  id: string
  status: string
  email?: string | null
  reactivation_sent_at?: string | null
  emails?: EmailAnalyticsRow[] | null
}

export interface AnalyticsRange {
  timezone: string
  start: string
  end: string
  dateKey: string
}

export interface TodayEmailStats {
  range: AnalyticsRange
  emails: EmailAnalyticsRow[]
  totalSent: number
  initialSent: number
  followupsSent: number
  followUp1Sent: number
  followUp2Sent: number
  followUp3Sent: number
}

export interface TodayDmStats {
  sentToday: number
}

export interface ReplyStats {
  totalContactedLeads: number
  positiveResponseLeads: number
  repliesToday: number
  replyRate: number
  statusesCounted: string[]
}

export interface FollowupStats {
  sentToday: number
  totalSent: number
  pending: number
  followUp1SentToday: number
  followUp2SentToday: number
  followUp3SentToday: number
  pendingFollowUp1: number
  pendingFollowUp2: number
  pendingFollowUp3: number
  // Lifecycle-aligned counts (match destination filter counts)
  fu1Due: number
  fu2Due: number
  fu3Due: number
  fuDue: number
  reactivationTotal: number
  overdueTotal: number
}

export interface DailyActivityRow {
  date: string
  label: string
  leadsFound: number
  emailsSent: number
  dmsQueued: number
  followupsSent: number
}

export interface DashboardMetrics {
  todayEmailStats: TodayEmailStats
  todayDmStats: TodayDmStats
  replyStats: ReplyStats
  followupStats: FollowupStats
  dailyRows: DailyActivityRow[]
  emailsSentThisWeek: number
}

import {
  POSITIVE_RESPONSE_STATUSES as POSITIVE_RESPONSE_STATUSES_CANONICAL,
  PITCHED_STATUSES,
} from './lead-status'
import { computeFollowUpEligibility, isFuEmailSent } from './followup-eligibility'

const FOLLOW_UP_TYPES: EmailType[] = ['follow_up_1', 'follow_up_2', 'follow_up_3']
const POSITIVE_RESPONSE_STATUSES: string[] = [...POSITIVE_RESPONSE_STATUSES_CANONICAL]
const CONTACTED_LEAD_STATUSES: string[] = [...PITCHED_STATUSES]
const FOLLOWUP_PENDING_LEAD_STATUSES = ['contacted']

function getZonedParts(date: Date, timeZone = ANALYTICS_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = ANALYTICS_TIMEZONE
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const parts = getZonedParts(new Date(utcGuess), timeZone)
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = zonedAsUtc - utcGuess
  return new Date(utcGuess - offset)
}

export function getAnalyticsDateKey(date: string | Date, timeZone = ANALYTICS_TIMEZONE): string {
  const parts = getZonedParts(new Date(date), timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function getAnalyticsDayRange(date = new Date(), timeZone = ANALYTICS_TIMEZONE): AnalyticsRange {
  const parts = getZonedParts(date, timeZone)
  const start = zonedLocalToUtc(parts.year, parts.month, parts.day, 0, 0, 0, 0, timeZone)
  const end = zonedLocalToUtc(parts.year, parts.month, parts.day + 1, 0, 0, 0, 0, timeZone)

  return {
    timezone: timeZone,
    start: start.toISOString(),
    end: end.toISOString(),
    dateKey: getAnalyticsDateKey(date, timeZone),
  }
}

function rangeForDateKey(dateKey: string): AnalyticsRange {
  const [year, month, day] = dateKey.split('-').map(Number)
  const start = zonedLocalToUtc(year, month, day)
  const end = zonedLocalToUtc(year, month, day + 1)

  return {
    timezone: ANALYTICS_TIMEZONE,
    start: start.toISOString(),
    end: end.toISOString(),
    dateKey,
  }
}

function shiftedSydneyDateKey(daysBack: number, from = new Date()) {
  const range = getAnalyticsDayRange(from)
  return getAnalyticsDateKey(new Date(new Date(range.start).getTime() - daysBack * DAY_MS))
}

function formatSydneyDayLabel(dateKey: string, index: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const localNoonUtc = zonedLocalToUtc(year, month, day, 12)
  const dayMonth = new Intl.DateTimeFormat('en-AU', {
    timeZone: ANALYTICS_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(localNoonUtc)

  if (index === 0) return `Today (${dayMonth})`
  if (index === 1) return `Yesterday (${dayMonth})`
  return dayMonth
}

export async function getTodayEmailStats(supabase: QueryClient, date = new Date()): Promise<TodayEmailStats> {
  const range = getAnalyticsDayRange(date)
  const { data } = await supabase
    .from('emails')
    .select('id, lead_id, type, sent_at, replied_at, leads(business_name)')
    .eq('status', 'sent')
    .gte('sent_at', range.start)
    .lt('sent_at', range.end)

  const emails = (data ?? []) as EmailAnalyticsRow[]
  const followUp1Sent = emails.filter((email) => email.type === 'follow_up_1').length
  const followUp2Sent = emails.filter((email) => email.type === 'follow_up_2').length
  const followUp3Sent = emails.filter((email) => email.type === 'follow_up_3').length
  const followupsSent = followUp1Sent + followUp2Sent + followUp3Sent

  return {
    range,
    emails,
    totalSent: emails.length,
    initialSent: emails.filter((email) => email.type === 'initial_pitch').length,
    followupsSent,
    followUp1Sent,
    followUp2Sent,
    followUp3Sent,
  }
}

export async function getTodayDmStats(supabase: QueryClient, date = new Date()): Promise<TodayDmStats> {
  const range = getAnalyticsDayRange(date)
  const { count } = await supabase
    .from('dm_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('sent_at', range.start)
    .lt('sent_at', range.end)

  return {
    sentToday: count ?? 0,
  }
}

export async function getReplyStats(supabase: QueryClient, date = new Date()): Promise<ReplyStats> {
  const range = getAnalyticsDayRange(date)
  const [{ count: totalContactedLeads }, { count: positiveResponseLeads }, { count: repliesToday }] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }).in('status', CONTACTED_LEAD_STATUSES),
    supabase.from('leads').select('*', { count: 'exact', head: true }).in('status', POSITIVE_RESPONSE_STATUSES),
    supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .not('replied_at', 'is', null)
      .gte('replied_at', range.start)
      .lt('replied_at', range.end),
  ])

  const contacted = totalContactedLeads ?? 0
  const positive = positiveResponseLeads ?? 0
  const replyRate = contacted > 0 ? Math.round((positive / contacted) * 100) : 0

  console.log('[REPLY_RATE_DEBUG]', {
    total_contacted_leads: contacted,
    positive_response_leads: positive,
    statuses_counted: POSITIVE_RESPONSE_STATUSES,
    final_percentage: replyRate,
  })

  return {
    totalContactedLeads: contacted,
    positiveResponseLeads: positive,
    repliesToday: repliesToday ?? 0,
    replyRate,
    statusesCounted: POSITIVE_RESPONSE_STATUSES,
  }
}

export async function getFollowupStats(supabase: QueryClient, date = new Date()): Promise<FollowupStats> {
  const range = getAnalyticsDayRange(date)
  const [
    { count: sentToday },
    { count: totalSent },
    { data: sentTodayByType },
    { data: settingsRows },
  ] = await Promise.all([
    supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .in('type', FOLLOW_UP_TYPES)
      .gte('sent_at', range.start)
      .lt('sent_at', range.end),
    supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .in('type', FOLLOW_UP_TYPES),
    supabase
      .from('emails')
      .select('type')
      .eq('status', 'sent')
      .in('type', FOLLOW_UP_TYPES)
      .gte('sent_at', range.start)
      .lt('sent_at', range.end),
    supabase
      .from('settings')
      .select('key, value')
      .in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled']),
  ])

  const FU_STATS_BATCH_SIZE = 1000
  const contactedLeads: ContactedFollowupLead[] = []
  let fuStatsOffset = 0
  while (true) {
    const { data: batch } = await supabase
      .from('leads')
      .select('id, status, email, reactivation_sent_at, emails(id, lead_id, type, status, sent_at, replied_at)')
      .in('status', FOLLOWUP_PENDING_LEAD_STATUSES)
      .range(fuStatsOffset, fuStatsOffset + FU_STATS_BATCH_SIZE - 1)
    if (!batch?.length) break
    contactedLeads.push(...(batch as ContactedFollowupLead[]))
    if (batch.length < FU_STATS_BATCH_SIZE) break
    fuStatsOffset += FU_STATS_BATCH_SIZE
  }

  console.log('[DASHBOARD_CONTACTED_LEADS_TOTAL]', contactedLeads.length)

  const settingsMap: Record<string, string> = {}
  for (const row of settingsRows ?? []) {
    settingsMap[row.key] = row.value
  }

  const followUp1Days = parseInt(settingsMap['follow_up_1_days'] ?? '7', 10)
  const followUp2Days = parseInt(settingsMap['follow_up_2_days'] ?? '14', 10)
  const followUp3Days = parseInt(settingsMap['follow_up_3_days'] ?? '21', 10)
  const reactivationDelayDays = parseInt(settingsMap['reactivation_delay_days'] ?? '60', 10)
  const deadAfterReactivationDays = parseInt(settingsMap['dead_after_reactivation_days'] ?? '14', 10)
  const reactivationEnabled = settingsMap['reactivation_enabled'] === 'true'

  let pendingFollowUp1 = 0
  let pendingFollowUp2 = 0
  let pendingFollowUp3 = 0

  for (const lead of contactedLeads) {
    if (!lead.email) continue
    const emailsList = lead.emails ?? []
    const initialEmail = emailsList.find((email) => email.type === 'initial_pitch' && email.sent_at)
    if (!initialEmail?.sent_at) continue

    const hasFollowUp1 = emailsList.some((email) => email.type === 'follow_up_1' && isFuEmailSent(email))
    const hasFollowUp2 = emailsList.some((email) => email.type === 'follow_up_2' && isFuEmailSent(email))
    const hasFollowUp3 = emailsList.some((email) => email.type === 'follow_up_3' && isFuEmailSent(email))

    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at,
      hasFollowUp1,
      hasFollowUp2,
      hasFollowUp3,
      { fu1Days: followUp1Days, fu2Days: followUp2Days, fu3Days: followUp3Days },
      date
    )

    if (eligibility.isDue) {
      if (eligibility.nextFuType === 'follow_up_3') pendingFollowUp3++
      else if (eligibility.nextFuType === 'follow_up_2') pendingFollowUp2++
      else if (eligibility.nextFuType === 'follow_up_1') pendingFollowUp1++
    }
  }

  // Lifecycle-aligned counts — same logic as computeLifecycle() in /api/lifecycle
  let fu1Due = 0
  let fu2Due = 0
  let fu3Due = 0
  let reactivationNotAwaitingDead = 0
  let awaitingDead = 0
  let overdueTotal = 0

  for (const lead of contactedLeads) {
    if (!lead.email) continue
    const emailsList = lead.emails ?? []
    const initialEmail = emailsList.find((e) => e.type === 'initial_pitch' && e.sent_at)
    if (!initialEmail?.sent_at) continue

    const fu1Sent = emailsList.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const fu2Sent = emailsList.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
    const fu3Sent = emailsList.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at,
      fu1Sent,
      fu2Sent,
      fu3Sent,
      { fu1Days: followUp1Days, fu2Days: followUp2Days, fu3Days: followUp3Days },
      date
    )

    if (lead.reactivation_sent_at) {
      const daysSinceReact = Math.floor((date.getTime() - new Date(lead.reactivation_sent_at).getTime()) / DAY_MS)
      if (daysSinceReact >= deadAfterReactivationDays) {
        awaitingDead++
        overdueTotal++
      } else {
        reactivationNotAwaitingDead++
      }
      continue
    }

    // FU2 sent, FU3 pending
    if (eligibility.nextFuType === 'follow_up_3') {
      if (eligibility.isDue) {
        fu3Due++
        overdueTotal++
      }
      continue
    }

    // All FUs sent (nextFuType === null) → reactivation or dead path
    if (eligibility.nextFuType === null) {
      if (reactivationEnabled) {
        reactivationNotAwaitingDead++
        if (eligibility.daysSince >= reactivationDelayDays) overdueTotal++
      } else if (eligibility.daysSince >= followUp3Days) {
        overdueTotal++
      }
      continue
    }

    if (eligibility.nextFuType === 'follow_up_2' && eligibility.isDue) {
      fu2Due++
      overdueTotal++
      continue
    }

    if (eligibility.nextFuType === 'follow_up_1' && eligibility.isDue) {
      fu1Due++
      overdueTotal++
    }
  }

  const fuDue = fu1Due + fu2Due + fu3Due
  const reactivationTotal = reactivationNotAwaitingDead

  const followUp1SentToday = ((sentTodayByType ?? []) as Array<{ type: EmailType }>).filter(
    (email) => email.type === 'follow_up_1'
  ).length
  const followUp2SentToday = ((sentTodayByType ?? []) as Array<{ type: EmailType }>).filter(
    (email) => email.type === 'follow_up_2'
  ).length
  const followUp3SentToday = ((sentTodayByType ?? []) as Array<{ type: EmailType }>).filter(
    (email) => email.type === 'follow_up_3'
  ).length
  const pending = pendingFollowUp1 + pendingFollowUp2 + pendingFollowUp3

  console.log('[DASHBOARD_FOLLOWUP_METRICS]', {
    legacy_pending_fu1: pendingFollowUp1,
    legacy_pending_fu2: pendingFollowUp2,
    legacy_pending_fu3: pendingFollowUp3,
    fu1_sent_today: followUp1SentToday,
    fu2_sent_today: followUp2SentToday,
    fu3_sent_today: followUp3SentToday,
  })

  console.log('[LIFECYCLE_ALIGNED_METRICS]', {
    filter: 'fu_due → (fu1||fu2||fu3) && is_overdue',
    fu1_due: fu1Due,
    fu2_due: fu2Due,
    fu3_due: fu3Due,
    fu_due_total: fuDue,
    filter_reactivation: 'filter_key=reactivation && stage!=AwaitingDead',
    reactivation_total: reactivationTotal,
    awaiting_dead: awaitingDead,
    filter_overdue: 'is_overdue=true',
    overdue_total: overdueTotal,
    settings: { followUp1Days, followUp2Days, followUp3Days, reactivationDelayDays, deadAfterReactivationDays, reactivationEnabled },
  })

  console.log('[ANALYTICS_FU_DEBUG]', { fu1Due, fu2Due, fu3Due, fuDue })

  return {
    sentToday: sentToday ?? 0,
    totalSent: totalSent ?? 0,
    pending,
    followUp1SentToday,
    followUp2SentToday,
    followUp3SentToday,
    pendingFollowUp1,
    pendingFollowUp2,
    pendingFollowUp3,
    fu1Due,
    fu2Due,
    fu3Due,
    fuDue,
    reactivationTotal,
    overdueTotal,
  }
}

export async function getDailyActivityRows(supabase: QueryClient, days = 7, date = new Date()): Promise<DailyActivityRow[]> {
  const dateKeys = Array.from({ length: days }, (_, index) => shiftedSydneyDateKey(index, date))
  const ranges = dateKeys.map(rangeForDateKey)
  const oldest = ranges[ranges.length - 1]
  const newest = ranges[0]

  const [{ data: leads }, { data: emails }, { data: dms }] = await Promise.all([
    supabase.from('leads').select('created_at').gte('created_at', oldest.start).lt('created_at', newest.end),
    supabase
      .from('emails')
      .select('type, sent_at')
      .eq('status', 'sent')
      .gte('sent_at', oldest.start)
      .lt('sent_at', newest.end),
    supabase.from('dm_queue').select('created_at').gte('created_at', oldest.start).lt('created_at', newest.end),
  ])

  return dateKeys.map((dateKey, index) => {
    const emailsForDay = ((emails ?? []) as Array<{ type: EmailType; sent_at: string | null }>).filter(
      (email) => email.sent_at && getAnalyticsDateKey(email.sent_at) === dateKey
    )

    return {
      date: dateKey,
      label: formatSydneyDayLabel(dateKey, index),
      leadsFound: ((leads ?? []) as Array<{ created_at: string }>).filter(
        (lead) => getAnalyticsDateKey(lead.created_at) === dateKey
      ).length,
      emailsSent: emailsForDay.length,
      dmsQueued: ((dms ?? []) as Array<{ created_at: string }>).filter((dm) => getAnalyticsDateKey(dm.created_at) === dateKey)
        .length,
      followupsSent: emailsForDay.filter((email) => FOLLOW_UP_TYPES.includes(email.type)).length,
    }
  })
}

export async function getDashboardMetrics(supabase: QueryClient, date = new Date()): Promise<DashboardMetrics> {
  const today = getAnalyticsDayRange(date)
  const oldestWeekDateKey = shiftedSydneyDateKey(6, date)
  const weekStart = rangeForDateKey(oldestWeekDateKey).start

  const [todayEmailStats, todayDmStats, replyStats, followupStats, dailyRows, { count: emailsSentThisWeek }] = await Promise.all([
    getTodayEmailStats(supabase, date),
    getTodayDmStats(supabase, date),
    getReplyStats(supabase, date),
    getFollowupStats(supabase, date),
    getDailyActivityRows(supabase, 7, date),
    supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', weekStart)
      .lt('sent_at', today.end),
  ])

  return {
    todayEmailStats,
    todayDmStats,
    replyStats,
    followupStats,
    dailyRows,
    emailsSentThisWeek: emailsSentThisWeek ?? 0,
  }
}

export function getLeadName(email: EmailAnalyticsRow): string {
  if (Array.isArray(email.leads)) return email.leads[0]?.business_name ?? 'Unknown'
  return email.leads?.business_name ?? 'Unknown'
}

export function logAnalyticsMetrics(label: string, metrics: {
  range: AnalyticsRange
  totalEmails: number
  followups: number
  replies: number
}) {
  console.log(label, {
    timezone: metrics.range.timezone,
    today_range: {
      start: metrics.range.start,
      end: metrics.range.end,
    },
    total_emails: metrics.totalEmails,
    followups: metrics.followups,
    replies: metrics.replies,
  })
}
