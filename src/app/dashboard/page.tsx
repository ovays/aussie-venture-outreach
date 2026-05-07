import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { StatsCard } from '@/components/dashboard/StatsCard'
import { PipelineSummary } from '@/components/dashboard/PipelineSummary'
import { RevenueChart } from '@/components/dashboard/RevenueChart'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { DailyActivity } from '@/components/dashboard/DailyActivity'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { formatCurrency } from '@/lib/utils'

export const revalidate = 60

export default async function DashboardPage() {
  const supabase = await createClient()

  const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const twelveWeeksAgo = new Date(Date.now() - 84 * 86_400_000).toISOString()

  const [
    { count: totalLeads },
    { data: emailsThisWeek },
    { data: allReplied },
    { data: allSent },
    { data: allDeals },
    { data: statusCounts },
    { data: recentActivity },
    { data: emailsToday },
    { data: pendingDMs },
    { data: dealsThisMonth },
    { data: weeklyDeals },
    { data: recentLeads },
    { data: recentEmails },
    { data: recentDMs },
  ] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }),
    supabase.from('emails').select('id').eq('status', 'sent').gte('sent_at', oneWeekAgo),
    supabase.from('leads').select('id').eq('status', 'replied'),
    supabase.from('emails').select('id').eq('status', 'sent'),
    supabase.from('deals').select('deal_value'),
    supabase.from('leads').select('status'),
    supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('emails').select('id').eq('status', 'sent').gte('sent_at', new Date(Date.now() - 86_400_000).toISOString()),
    supabase.from('dm_queue').select('id').eq('status', 'pending'),
    supabase.from('deals').select('deal_value').gte('closed_at', new Date(Date.now() - 30 * 86_400_000).toISOString()),
    supabase.from('deals').select('deal_value, closed_at').gte('closed_at', twelveWeeksAgo).order('closed_at'),
    supabase.from('leads').select('created_at').gte('created_at', oneWeekAgo),
    supabase.from('emails').select('sent_at').eq('status', 'sent').gte('sent_at', oneWeekAgo),
    supabase.from('dm_queue').select('created_at').gte('created_at', oneWeekAgo),
  ])

  const totalRevenue = (allDeals ?? []).reduce((s, d) => s + (d.deal_value ?? 0), 0)
  const replyRate = (allSent?.length ?? 0) > 0
    ? Math.round(((allReplied?.length ?? 0) / (allSent?.length ?? 0)) * 100)
    : 0

  // Build status counts
  const statusMap: Record<string, number> = {}
  for (const { status } of statusCounts ?? []) {
    statusMap[status] = (statusMap[status] ?? 0) + 1
  }
  const pipelineCounts = Object.entries(statusMap).map(([status, count]) => ({ status, count }))

  // Build weekly revenue chart data (last 12 weeks)
  const weeklyRevenue: Array<{ week: string; revenue: number }> = []
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(Date.now() - (i + 1) * 7 * 86_400_000)
    const weekEnd = new Date(Date.now() - i * 7 * 86_400_000)
    const revenue = (weeklyDeals ?? [])
      .filter((d) => {
        const closed = new Date(d.closed_at)
        return closed >= weekStart && closed < weekEnd
      })
      .reduce((s, d) => s + (d.deal_value ?? 0), 0)
    weeklyRevenue.push({
      week: `W${12 - i}`,
      revenue,
    })
  }

  const followUpsPending = 0 // simplified — would query follow_ups table

  // Build last-7-days activity rows (Sydney AEST = UTC+10/11, approximate with local grouping)
  const dailyRows = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - i * 86_400_000)
    const dateStr = d.toISOString().slice(0, 10) // YYYY-MM-DD in UTC

    const leadsFound = (recentLeads ?? []).filter((r) => r.created_at.slice(0, 10) === dateStr).length
    const emailsSent = (recentEmails ?? []).filter((r) => r.sent_at && r.sent_at.slice(0, 10) === dateStr).length
    const dmsQueued = (recentDMs ?? []).filter((r) => r.created_at.slice(0, 10) === dateStr).length

    const label = i === 0
      ? `Today (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
      : i === 1
        ? `Yesterday (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
        : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`

    return { date: dateStr, label, leadsFound, emailsSent, dmsQueued }
  })

  return (
    <div>
      <TopBar title="Dashboard" />
      <div className="p-3 md:p-6 space-y-4 md:space-y-6">
        {/* Stats Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard label="Total Leads Found" value={totalLeads ?? 0} sub="All time" />
          <StatsCard
            label="Emails Sent This Week"
            value={emailsThisWeek?.length ?? 0}
            sub="Last 7 days"
            accent="#38bdf8"
          />
          <StatsCard
            label="Reply Rate"
            value={`${replyRate}%`}
            sub={`${allReplied?.length ?? 0} of ${allSent?.length ?? 0} emails`}
            accent="#4ade80"
          />
          <StatsCard
            label="Total Revenue"
            value={formatCurrency(totalRevenue)}
            sub="All time closed deals"
            accent="#fbbf24"
          />
        </div>

        {/* Pipeline Summary */}
        <Card>
          <h3 className="text-sm font-semibold mb-3 text-white">Pipeline</h3>
          <PipelineSummary counts={pipelineCounts} />
        </Card>

        {/* Revenue Chart */}
        <Card>
          <h3 className="text-sm font-semibold mb-4 text-white">Weekly Revenue (Last 12 Weeks)</h3>
          <ErrorBoundary label="RevenueChart">
            <RevenueChart data={weeklyRevenue} />
          </ErrorBoundary>
        </Card>

        {/* Daily Activity */}
        <Card>
          <h3 className="text-sm font-semibold mb-3 text-white">Daily Activity (Last 7 Days)</h3>
          <DailyActivity rows={dailyRows} />
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Activity Feed */}
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-sm font-semibold mb-1 text-white">Recent Activity</h3>
              <ActivityFeed events={(recentActivity ?? []) as Parameters<typeof ActivityFeed>[0]['events']} />
            </Card>
          </div>

          {/* Quick Stats */}
          <div className="space-y-4">
            <Card>
              <h3 className="text-sm font-semibold mb-3 text-white">Quick Stats</h3>
              <div className="space-y-3">
                {[
                  { label: 'Emails sent today', value: emailsToday?.length ?? 0 },
                  { label: 'Follow-ups pending', value: followUpsPending },
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
