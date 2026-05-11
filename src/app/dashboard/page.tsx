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
      <div className="p-3 md:p-6 space-y-4 md:space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard label="Total Leads Found" value={totalLeads ?? 0} sub="All time" />
          <StatsCard
            label="Emails Sent This Week"
            value={analytics.emailsSentThisWeek}
            sub="Sydney calendar days"
            accent="#38bdf8"
          />
          <StatsCard
            label="Reply Rate"
            value={`${analytics.replyStats.replyRate}%`}
            sub={`${analytics.replyStats.totalReplies} of ${analytics.replyStats.totalSent} sent emails`}
            accent="#4ade80"
          />
          <StatsCard
            label="Total Revenue"
            value={formatCurrency(totalRevenue)}
            sub="All time closed deals"
            accent="#fbbf24"
          />
        </div>

        <Card>
          <h3 className="text-sm font-semibold mb-3 text-white">Pipeline</h3>
          <PipelineSummary counts={pipelineCounts} />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-4 text-white">Weekly Revenue (Last 12 Weeks)</h3>
          <ErrorBoundary label="RevenueChart">
            <RevenueChart data={weeklyRevenue} />
          </ErrorBoundary>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-3 text-white">Daily Activity (Last 7 Days)</h3>
          <DailyActivity rows={analytics.dailyRows} />
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-sm font-semibold mb-1 text-white">Recent Activity</h3>
              <ActivityFeed events={(recentActivity ?? []) as Parameters<typeof ActivityFeed>[0]['events']} />
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <h3 className="text-sm font-semibold mb-3 text-white">Quick Stats</h3>
              <div className="space-y-3">
                {[
                  { label: 'Emails sent today', value: analytics.todayEmailStats.totalSent },
                  { label: 'Follow-ups sent today', value: analytics.followupStats.sentToday },
                  { label: 'Total follow-ups sent', value: analytics.followupStats.totalSent },
                  { label: 'Pending follow-ups', value: analytics.followupStats.pending },
                  { label: 'Replies received today', value: analytics.replyStats.repliesToday },
                  { label: 'DMs in queue', value: pendingDMs?.length ?? 0 },
                  { label: 'Deals this month', value: dealsThisMonth?.length ?? 0 },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: '#94a3b8' }}>{label}</span>
                    <span className="text-sm font-semibold text-white">{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
