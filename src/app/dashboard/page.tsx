import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { StatsCard } from '@/components/dashboard/StatsCard'
import { PipelineSummary } from '@/components/dashboard/PipelineSummary'
import { RevenueChart } from '@/components/dashboard/RevenueChart'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { DailyActivity } from '@/components/dashboard/DailyActivity'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { getDashboardMetrics, logAnalyticsMetrics } from '@/lib/analytics'
import { formatCurrency } from '@/lib/utils'

export const revalidate = 60

export default async function DashboardPage() {
  const supabase = await createClient()
  const twelveWeeksAgo = new Date(Date.now() - 84 * 86_400_000).toISOString()

  const [
    analytics,
    { count: totalLeads },
    { data: allDeals },
    { data: statusCounts },
    { data: recentActivity },
    { data: pendingDMs },
    { data: dealsThisMonth },
    { data: weeklyDeals },
  ] = await Promise.all([
    getDashboardMetrics(supabase),
    supabase.from('leads').select('*', { count: 'exact', head: true }),
    supabase.from('deals').select('deal_value'),
    supabase.from('leads').select('status'),
    supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('dm_queue').select('id').eq('status', 'pending'),
    supabase.from('deals').select('deal_value').gte('closed_at', new Date(Date.now() - 30 * 86_400_000).toISOString()),
    supabase.from('deals').select('deal_value, closed_at').gte('closed_at', twelveWeeksAgo).order('closed_at'),
  ])

  logAnalyticsMetrics('[DASHBOARD_METRICS]', {
    range: analytics.todayEmailStats.range,
    totalEmails: analytics.todayEmailStats.totalSent,
    followups: analytics.followupStats.sentToday,
    replies: analytics.replyStats.repliesToday,
  })

  const totalRevenue = (allDeals ?? []).reduce((sum, deal) => sum + (deal.deal_value ?? 0), 0)

  const statusMap: Record<string, number> = {}
  for (const { status } of statusCounts ?? []) {
    statusMap[status] = (statusMap[status] ?? 0) + 1
  }
  const pipelineCounts = Object.entries(statusMap).map(([status, count]) => ({ status, count }))

  const weeklyRevenue: Array<{ week: string; revenue: number }> = []
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(Date.now() - (i + 1) * 7 * 86_400_000)
    const weekEnd = new Date(Date.now() - i * 7 * 86_400_000)
    const revenue = (weeklyDeals ?? [])
      .filter((deal) => {
        const closed = new Date(deal.closed_at)
        return closed >= weekStart && closed < weekEnd
      })
      .reduce((sum, deal) => sum + (deal.deal_value ?? 0), 0)

    weeklyRevenue.push({
      week: `W${12 - i}`,
      revenue,
    })
  }

  return (
    <div>
      <TopBar title="Dashboard" />
      <div className="p-3 md:p-5 space-y-4 md:space-y-5">
        {/* Primary KPI row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatsCard label="Total Leads Found" value={totalLeads ?? 0} sub="All time" accent="#e2e8f0" />
          <StatsCard
            label="Emails Sent This Week"
            value={analytics.emailsSentThisWeek}
            sub="Sydney calendar days"
            accent="#38bdf8"
          />
          <StatsCard
            label="Reply Rate"
            value={`${analytics.replyStats.replyRate}%`}
            sub={`${analytics.replyStats.positiveResponseLeads} of ${analytics.replyStats.totalContactedLeads} contacted`}
            accent="#4ade80"
          />
          <StatsCard
            label="Total Revenue"
            value={formatCurrency(totalRevenue)}
            sub="All time closed deals"
            accent="#fbbf24"
          />
        </div>

        {/* Today's activity */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatsCard label="Emails Today" value={analytics.todayEmailStats.initialSent} sub="Initial pitches" accent="#38bdf8" />
          <StatsCard label="DMs Today"    value={analytics.todayDmStats.sentToday}      sub="Marked sent"    accent="#f472b6" />
          <StatsCard label="FU1 Today"    value={analytics.followupStats.followUp1SentToday} sub="Follow-up 1" accent="#a78bfa" />
          <StatsCard label="FU2 Today"    value={analytics.followupStats.followUp2SentToday} sub="Follow-up 2" accent="#c084fc" />
          <StatsCard label="FU3 Today"    value={analytics.followupStats.followUp3SentToday} sub="Follow-up 3" accent="#d8b4fe" />
        </div>

        {/* Pending follow-ups */}
        <div className="grid grid-cols-3 gap-3">
          <StatsCard label="Pending FU1" value={analytics.followupStats.pendingFollowUp1} sub="Awaiting follow-up 1" accent="#a78bfa" />
          <StatsCard label="Pending FU2" value={analytics.followupStats.pendingFollowUp2} sub="Awaiting follow-up 2" accent="#c084fc" />
          <StatsCard label="Pending FU3" value={analytics.followupStats.pendingFollowUp3} sub="Awaiting follow-up 3" accent="#d8b4fe" />
        </div>

        {/* Pipeline */}
        <Card title="Pipeline">
          <PipelineSummary counts={pipelineCounts} />
        </Card>

        {/* Revenue chart */}
        <Card title="Weekly Revenue — Last 12 Weeks">
          <ErrorBoundary label="RevenueChart">
            <RevenueChart data={weeklyRevenue} />
          </ErrorBoundary>
        </Card>

        {/* Daily activity */}
        <Card title="Daily Activity — Last 7 Days">
          <DailyActivity rows={analytics.dailyRows} />
        </Card>

        {/* Activity feed + quick stats */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Card title="Recent Activity">
              <ActivityFeed events={(recentActivity ?? []) as Parameters<typeof ActivityFeed>[0]['events']} />
            </Card>
          </div>

          <Card title="Quick Stats">
            <div className="space-y-3">
              {[
                { label: 'New outreach emails today',  value: analytics.todayEmailStats.initialSent },
                { label: 'New DMs sent today',         value: analytics.todayDmStats.sentToday },
                { label: 'Follow-ups sent today',      value: analytics.followupStats.sentToday },
                { label: 'FU1 / FU2 / FU3 today',     value: `${analytics.followupStats.followUp1SentToday} / ${analytics.followupStats.followUp2SentToday} / ${analytics.followupStats.followUp3SentToday}` },
                { label: 'Total follow-ups sent',      value: analytics.followupStats.totalSent },
                { label: 'Pending follow-ups',         value: analytics.followupStats.pending },
                { label: 'Pending FU1 / FU2 / FU3',   value: `${analytics.followupStats.pendingFollowUp1} / ${analytics.followupStats.pendingFollowUp2} / ${analytics.followupStats.pendingFollowUp3}` },
                { label: 'Replies today',              value: analytics.replyStats.repliesToday },
                { label: 'DMs in queue',               value: pendingDMs?.length ?? 0 },
                { label: 'Deals this month',           value: dealsThisMonth?.length ?? 0 },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between gap-2">
                  <span className="text-sm min-w-0 truncate" style={{ color: '#94a3b8' }}>{label}</span>
                  <span className="text-sm font-semibold text-white shrink-0">{value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
