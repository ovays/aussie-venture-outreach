/**
 * Read-only Dashboard baseline/parity check.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/verify-dashboard-summary.ts [asOf ISO]
 *
 * Until migration 039 is applied, the script prints RPC PENDING after capturing
 * the privacy-safe legacy baseline. It never writes to the database.
 */
import { createClient } from '@supabase/supabase-js'
import { getDashboardMetrics } from '../src/lib/analytics'
import { adaptDashboardSummary } from '../src/lib/dashboard-summary'

const DAY_MS = 86_400_000
const HOT_STATUS_PRIORITY = ['replied', 'negotiating', 'interested', 'contacted']

interface QueryMeasurements {
  requests: number
  rowsDownloaded: number
  payloadBytes: number
  summedQueryDurationMs: number
}

function nestedRowCount(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.length + value.reduce((total, row) => {
    if (!row || typeof row !== 'object') return total
    return total + Object.values(row as Record<string, unknown>).reduce<number>(
      (nestedTotal, child) => nestedTotal + nestedRowCount(child),
      0
    )
  }, 0)
}

function instrumentFromQueries<T extends { from: (...args: any[]) => any }>(client: T) {
  const measurements: QueryMeasurements = {
    requests: 0,
    rowsDownloaded: 0,
    payloadBytes: 0,
    summedQueryDurationMs: 0,
  }
  const proxyCache = new WeakMap<object, any>()

  const wrap = (builder: any): any => {
    if (!builder || typeof builder !== 'object') return builder
    const cached = proxyCache.get(builder)
    if (cached) return cached

    const proxy = new Proxy(builder, {
      get(target, property) {
        if (property === 'then') {
          return (resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) => {
            const started = performance.now()
            measurements.requests++
            return target.then(
              (result: any) => {
                measurements.summedQueryDurationMs += performance.now() - started
                measurements.rowsDownloaded += nestedRowCount(result.data)
                measurements.payloadBytes += Buffer.byteLength(JSON.stringify(result.data ?? null))
                return resolve(result)
              },
              reject
            )
          }
        }

        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: any[]) => wrap(value.apply(target, args))
      },
    })
    proxyCache.set(builder, proxy)
    return proxy
  }

  return {
    client: new Proxy(client, {
      get(target, property) {
        if (property === 'from') {
          return (...args: any[]) => wrap(target.from(...args))
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
    measurements,
  }
}

async function getAllLeadStatuses(supabase: any) {
  const rows: Array<{ status: string | null }> = []
  const pageSize = 1000
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('leads')
      .select('status')
      .range(from, from + pageSize - 1)
    if (error) throw error
    if (!data?.length) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return rows
}

function buildWeeklyRevenue(
  deals: Array<{ deal_value: number | null; closed_at: string }>,
  asOf: Date
) {
  const rows: Array<{ week: string; revenue: number }> = []
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(asOf.getTime() - (i + 1) * 7 * DAY_MS)
    const weekEnd = new Date(asOf.getTime() - i * 7 * DAY_MS)
    rows.push({
      week: `W${12 - i}`,
      revenue: deals
        .filter((deal) => {
          const closed = new Date(deal.closed_at)
          return closed >= weekStart && closed < weekEnd
        })
        .reduce((sum, deal) => sum + (deal.deal_value ?? 0), 0),
    })
  }
  return rows
}

async function captureLegacy(supabase: any, asOf: Date) {
  const twelveWeeksAgo = new Date(asOf.getTime() - 84 * DAY_MS).toISOString()
  const thirtyDaysAgo = new Date(asOf.getTime() - 30 * DAY_MS).toISOString()
  const started = performance.now()
  const [
    analytics,
    statusRows,
    { data: recentActivity, error: activityError },
    { data: pendingDMs, error: dmError },
    { data: dealsThisMonth, error: monthlyDealsError },
    { data: weeklyDeals, error: weeklyDealsError },
    { data: hotLeads, error: hotLeadsError },
  ] = await Promise.all([
    getDashboardMetrics(supabase, asOf),
    getAllLeadStatuses(supabase),
    supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('dm_queue').select('id').eq('status', 'pending'),
    supabase.from('deals').select('deal_value').gte('closed_at', thirtyDaysAgo),
    supabase.from('deals').select('deal_value, closed_at').gte('closed_at', twelveWeeksAgo).order('closed_at'),
    supabase
      .from('leads')
      .select('id, business_name, city, status, notes, created_at, emails(id, type, sent_at, replied_at, subject)')
      .in('status', ['replied', 'negotiating', 'interested'])
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const error = activityError ?? dmError ?? monthlyDealsError ?? weeklyDealsError ?? hotLeadsError
  if (error) throw error

  const statusMap: Record<string, number> = {}
  for (const row of statusRows) {
    if (row.status !== null) statusMap[row.status] = (statusMap[row.status] ?? 0) + 1
  }

  const sortedHotLeads = [...(hotLeads ?? [])].sort(
    (a, b) => HOT_STATUS_PRIORITY.indexOf(a.status) - HOT_STATUS_PRIORITY.indexOf(b.status)
  )

  return {
    wallDurationMs: performance.now() - started,
    summary: {
      analytics,
      statusMap,
      recentActivity: (recentActivity ?? []).map((event: any) => ({
        id: event.id,
        event_type: event.event_type,
        description: event.description,
        created_at: new Date(event.created_at).toISOString(),
      })),
      pendingDMCount: pendingDMs?.length ?? 0,
      dealsRolling30DayCount: dealsThisMonth?.length ?? 0,
      weeklyRevenue: buildWeeklyRevenue(weeklyDeals ?? [], asOf),
      hotLeads: sortedHotLeads.map((lead: any) => ({
        id: lead.id,
        business_name: lead.business_name,
        city: lead.city,
        status: lead.status,
        emails: (lead.emails ?? []).map((email: any) => ({
          type: email.type,
          sent_at: email.sent_at ? new Date(email.sent_at).toISOString() : null,
          replied_at: email.replied_at ? new Date(email.replied_at).toISOString() : null,
          subject: email.subject,
        })),
      })),
    },
  }
}

function parityContract(summary: any) {
  const analytics = summary.analytics
  return {
    statusCounts: Object.fromEntries(Object.entries(summary.statusMap).sort(([a], [b]) => a.localeCompare(b))),
    metrics: {
      followUpsDue: analytics.followupStats.fuDue,
      followUp1Due: analytics.followupStats.fu1Due,
      followUp2Due: analytics.followupStats.fu2Due,
      followUp3Due: analytics.followupStats.fu3Due,
      repliesToReview: summary.statusMap.replied ?? 0,
      negotiationsActive: (summary.statusMap.negotiating ?? 0) + (summary.statusMap.interested ?? 0),
      reactivationQueue: analytics.followupStats.reactivationTotal,
      overdueLeads: analytics.followupStats.overdueTotal,
      totalContacted: analytics.replyStats.totalContactedLeads,
      positiveReplies: analytics.replyStats.positiveResponseLeads,
      replyRate: analytics.replyStats.replyRate,
      repliesToday: analytics.replyStats.repliesToday,
      emailsSentToday: analytics.todayEmailStats.totalSent,
      initialEmailsSentToday: analytics.todayEmailStats.initialSent,
      followupsSentToday: analytics.followupStats.sentToday,
      followUp1SentToday: analytics.followupStats.followUp1SentToday,
      followUp2SentToday: analytics.followupStats.followUp2SentToday,
      followUp3SentToday: analytics.followupStats.followUp3SentToday,
      totalFollowupsSent: analytics.followupStats.totalSent,
      pendingFollowups: analytics.followupStats.pending,
      pendingFollowUp1: analytics.followupStats.pendingFollowUp1,
      pendingFollowUp2: analytics.followupStats.pendingFollowUp2,
      pendingFollowUp3: analytics.followupStats.pendingFollowUp3,
      dmsToday: analytics.todayDmStats.sentToday,
      dmsQueued: summary.pendingDMCount,
      rolling30DayDeals: summary.dealsRolling30DayCount,
      emailsSentThisWeek: analytics.emailsSentThisWeek,
    },
    todayRange: analytics.todayEmailStats.range,
    dailyActivity: analytics.dailyRows,
    weeklyRevenue: summary.weeklyRevenue,
    recentActivity: summary.recentActivity.map((event: any) => ({
      id: event.id,
      event_type: event.event_type,
      description: event.description,
      created_at: new Date(event.created_at).toISOString(),
    })),
    hotLeads: summary.hotLeads.map((lead: any) => ({
      id: lead.id,
      business_name: lead.business_name,
      city: lead.city,
      status: lead.status,
      emails: (lead.emails ?? []).map((email: any) => ({
        type: email.type,
        sent_at: email.sent_at ? new Date(email.sent_at).toISOString() : null,
        replied_at: email.replied_at ? new Date(email.replied_at).toISOString() : null,
        subject: email.subject,
      })),
    })),
  }
}

function findMismatch(left: unknown, right: unknown, path = 'summary'): string | null {
  if (Object.is(left, right)) return null
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`
    for (let index = 0; index < left.length; index++) {
      const mismatch = findMismatch(left[index], right[index], `${path}[${index}]`)
      if (mismatch) return mismatch
    }
    return null
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as object).sort()
    const rightKeys = Object.keys(right as object).sort()
    if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) return `${path}.keys`
    for (const key of leftKeys) {
      const mismatch = findMismatch(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`
      )
      if (mismatch) return mismatch
    }
    return null
  }
  return path
}

function privacySafeBaseline(summary: any) {
  const contract = parityContract(summary)
  return {
    metrics: contract.metrics,
    statusCounts: contract.statusCounts,
    dailyActivity: contract.dailyActivity,
    weeklyRevenue: contract.weeklyRevenue,
    recentActivityCount: contract.recentActivity.length,
    hotLeadCount: contract.hotLeads.length,
  }
}

async function main() {
  const asOf = new Date(process.argv[2] ?? new Date().toISOString())
  if (Number.isNaN(asOf.getTime())) throw new Error('asOf must be a valid ISO timestamp')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new Error('Supabase environment variables are required')

  const rawClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const instrumented = instrumentFromQueries(rawClient)
  const legacy = await captureLegacy(instrumented.client, asOf)

  console.log('DASHBOARD LEGACY BASELINE')
  console.log(JSON.stringify({
    asOf: asOf.toISOString(),
    values: privacySafeBaseline(legacy.summary),
    performance: {
      requestCount: instrumented.measurements.requests,
      rowsDownloaded: instrumented.measurements.rowsDownloaded,
      payloadBytes: instrumented.measurements.payloadBytes,
      summedQueryDurationMs: Math.round(instrumented.measurements.summedQueryDurationMs),
      wallDurationMs: Math.round(legacy.wallDurationMs),
    },
  }, null, 2))

  const rpcStarted = performance.now()
  const rpcResult = await rawClient.rpc('get_dashboard_summary', { p_as_of: asOf.toISOString() })
  const rpcDurationMs = performance.now() - rpcStarted
  if (rpcResult.error) {
    const missingRpc = rpcResult.error.code === 'PGRST202'
      || /could not find.*get_dashboard_summary|schema cache.*get_dashboard_summary/i.test(rpcResult.error.message)
    if (missingRpc) {
      console.log('RPC PENDING: migration 039 has not been applied; live parity/performance verification is pending.')
      return
    }
    throw rpcResult.error
  }

  const rpcPayloadBytes = Buffer.byteLength(JSON.stringify(rpcResult.data))
  const rpcSummary = adaptDashboardSummary(rpcResult.data)
  const mismatch = findMismatch(parityContract(legacy.summary), parityContract(rpcSummary))
  if (mismatch) throw new Error(`Dashboard summary parity mismatch at ${mismatch}; values suppressed for privacy.`)

  console.log('PARITY PASS')
  console.log(JSON.stringify({
    rpcRequestCount: 1,
    rpcDurationMs: Math.round(rpcDurationMs),
    rpcPayloadBytes,
    recentActivityCount: rpcSummary.recentActivity.length,
    hotLeadIdsInOrder: rpcSummary.hotLeads.map((lead) => lead.id),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
