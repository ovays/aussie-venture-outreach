const ANALYTICS_TIMEZONE = 'Australia/Sydney'
const DAY_MS = 86_400_000

type QueryClient = {
  from: (table: string) => any
}

type EmailType = 'initial_pitch' | 'follow_up_1' | 'follow_up_2'

interface EmailAnalyticsRow {
  id: string
  lead_id: string | null
  type: EmailType
  sent_at: string | null
  replied_at: string | null
  leads?: { business_name: string } | { business_name: string }[] | null
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
}

export interface ReplyStats {
  totalSent: number
  totalReplies: number
  repliesToday: number
  replyRate: number
}

export interface FollowupStats {
  sentToday: number
  totalSent: number
  pending: number
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
  replyStats: ReplyStats
  followupStats: FollowupStats
  dailyRows: DailyActivityRow[]
  emailsSentThisWeek: number
}

const FOLLOW_UP_TYPES: EmailType[] = ['follow_up_1', 'follow_up_2']

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
  const followupsSent = followUp1Sent + followUp2Sent

  return {
    range,
    emails,
    totalSent: emails.length,
    initialSent: emails.filter((email) => email.type === 'initial_pitch').length,
    followupsSent,
    followUp1Sent,
    followUp2Sent,
  }
}

export async function getReplyStats(supabase: QueryClient, date = new Date()): Promise<ReplyStats> {
  const range = getAnalyticsDayRange(date)
  const [{ count: totalSent }, { count: totalReplies }, { count: repliesToday }] = await Promise.all([
    supabase.from('emails').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
    supabase.from('emails').select('*', { count: 'exact', head: true }).not('replied_at', 'is', null),
    supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .not('replied_at', 'is', null)
      .gte('replied_at', range.start)
      .lt('replied_at', range.end),
  ])

  const sent = totalSent ?? 0
  const replies = totalReplies ?? 0

  return {
    totalSent: sent,
    totalReplies: replies,
    repliesToday: repliesToday ?? 0,
    replyRate: sent > 0 ? Math.round((replies / sent) * 100) : 0,
  }
}

export async function getFollowupStats(supabase: QueryClient, date = new Date()): Promise<FollowupStats> {
  const range = getAnalyticsDayRange(date)
  const [{ count: sentToday }, { count: totalSent }, { count: pending }] = await Promise.all([
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
    supabase.from('follow_ups').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
  ])

  return {
    sentToday: sentToday ?? 0,
    totalSent: totalSent ?? 0,
    pending: pending ?? 0,
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

  const [todayEmailStats, replyStats, followupStats, dailyRows, { count: emailsSentThisWeek }] = await Promise.all([
    getTodayEmailStats(supabase, date),
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
