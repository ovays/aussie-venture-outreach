import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { ActionQueueCard } from '@/components/dashboard/ActionQueueCard'
import { WorkflowQueue } from '@/components/dashboard/WorkflowQueue'
import { HotLeadsPanel } from '@/components/dashboard/HotLeadsPanel'
import { LiveActivityFeed } from '@/components/dashboard/LiveActivityFeed'
import { PipelineSummary } from '@/components/dashboard/PipelineSummary'
import { RevenueChart } from '@/components/dashboard/RevenueChart'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { DailyActivity } from '@/components/dashboard/DailyActivity'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { getDashboardMetrics, logAnalyticsMetrics } from '@/lib/analytics'
import { stageCount, buildStageCounts } from '@/lib/lead-status'
import type { HotLead } from '@/components/dashboard/HotLeadsPanel'
import { Send, MessageSquare, TrendingUp, RotateCcw, AlertTriangle, Flame, Zap } from 'lucide-react'

export const revalidate = 60

export default async function DashboardPage() {
  const supabase = await createClient()
  const twelveWeeksAgo = new Date(Date.now() - 84 * 86_400_000).toISOString()

  const [
    analytics,
    { data: statusCounts },
    { data: recentActivity },
    { data: pendingDMs },
    { data: dealsThisMonth },
    { data: weeklyDeals },
    { data: hotLeadsRaw },
  ] = await Promise.all([
    getDashboardMetrics(supabase),
    supabase.from('leads').select('status'),
    supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('dm_queue').select('id').eq('status', 'pending'),
    supabase.from('deals').select('deal_value').gte('closed_at', new Date(Date.now() - 30 * 86_400_000).toISOString()),
    supabase.from('deals').select('deal_value, closed_at').gte('closed_at', twelveWeeksAgo).order('closed_at'),
    supabase
      .from('leads')
      .select('id, business_name, city, status, notes, created_at, emails(id, type, sent_at, replied_at, subject)')
      .in('status', ['replied', 'negotiating', 'interested'])
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const hotLeads = (hotLeadsRaw ?? []) as HotLead[]

  logAnalyticsMetrics('[DASHBOARD_METRICS]', {
    range: analytics.todayEmailStats.range,
    totalEmails: analytics.todayEmailStats.totalSent,
    followups: analytics.followupStats.sentToday,
    replies: analytics.replyStats.repliesToday,
  })

  const statusMap: Record<string, number> = {}
  for (const { status } of statusCounts ?? []) {
    statusMap[status] = (statusMap[status] ?? 0) + 1
  }
  const pipelineCounts = Object.entries(statusMap).map(([status, count]) => ({ status, count }))

  // Use canonical stage groupings — matches Pipeline Kanban column counts exactly
  const stageCounts = buildStageCounts(statusMap)
  const negotiationsActive = stageCounts.negotiating  // negotiating + interested

  console.log('[STAGE_COUNTS_DASHBOARD]', {
    source: 'leads.status (no limit)',
    raw_status_map: statusMap,
    stage_counts: stageCounts,
    note: 'negotiating = negotiating+interested, closed = closed+closed_won+closed_manual',
  })

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
        {/* ── Today's Action Queue ── */}
        <div>
          <div className="flex items-end justify-between mb-5">
            <div>
              <h2
                className="text-xl font-bold tracking-tight leading-none"
                style={{ color: '#f1f5f9' }}
              >
                Today&apos;s Action Queue
              </h2>
              <p className="text-sm mt-1.5" style={{ color: '#475569' }}>
                What needs your attention right now
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-2 pb-0.5">
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: '#34d399' }}
              />
              <span className="text-xs font-mono" style={{ color: '#334155' }}>
                Live · Sydney
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-3.5">
            <ActionQueueCard
              icon={<Send size={18} strokeWidth={1.8} />}
              count={analytics.followupStats.fuDue}
              title="Follow-ups Due"
              subtitle="Overdue & ready to send"
              detail={`FU1 ${analytics.followupStats.fu1Due} · FU2 ${analytics.followupStats.fu2Due} · FU3 ${analytics.followupStats.fu3Due}`}
              ctaLabel="Send Follow-ups"
              ctaHref="/dashboard/lifecycle?filter=fu_due"
              accent="#8b5cf6"
              urgency="medium"
            />
            <ActionQueueCard
              icon={<MessageSquare size={18} strokeWidth={1.8} />}
              count={statusMap['replied'] ?? 0}
              title="Replies To Review"
              subtitle="Awaiting your response"
              detail={`Today: ${analytics.replyStats.repliesToday} · Rate: ${analytics.replyStats.replyRate}%`}
              ctaLabel="Review Replies"
              ctaHref="/dashboard/leads?status=replied"
              accent="#38bdf8"
              urgency="high"
            />
            <ActionQueueCard
              icon={<TrendingUp size={18} strokeWidth={1.8} />}
              count={negotiationsActive}
              title="Negotiations Active"
              subtitle="In active discussion"
              detail={`Negotiating: ${statusMap['negotiating'] ?? 0} · Interested: ${statusMap['interested'] ?? 0}`}
              ctaLabel="View Deals"
              ctaHref="/dashboard/leads?stage=negotiating"
              accent="#34d399"
              urgency="normal"
            />
            <ActionQueueCard
              icon={<RotateCcw size={18} strokeWidth={1.8} />}
              count={analytics.followupStats.reactivationTotal}
              title="Reactivation Queue"
              subtitle="Cold leads to re-engage"
              detail="DM outreach recommended"
              ctaLabel="Open DM Queue"
              ctaHref="/dashboard/lifecycle?filter=reactivation"
              accent="#fb923c"
              urgency="medium"
            />
            <ActionQueueCard
              icon={<AlertTriangle size={18} strokeWidth={1.8} />}
              count={analytics.followupStats.overdueTotal}
              title="Overdue Leads"
              subtitle="Past their due date"
              detail="Needs immediate action"
              ctaLabel="Review Overdue"
              ctaHref="/dashboard/lifecycle?filter=overdue"
              accent="#f87171"
              urgency="critical"
            />
          </div>
        </div>

        {/* ── Today's Tasks / Workflow Queue ── */}
        <WorkflowQueue
          fu1Due={analytics.followupStats.fu1Due}
          fu2Due={analytics.followupStats.fu2Due}
          fu3Overdue={analytics.followupStats.overdueTotal}
          repliesToReview={statusMap['replied'] ?? 0}
          negotiationsActive={negotiationsActive}
          reactivationQueue={analytics.followupStats.reactivationTotal}
          initialSentToday={analytics.todayEmailStats.initialSent}
          fu1SentToday={analytics.followupStats.followUp1SentToday}
          fu2SentToday={analytics.followupStats.followUp2SentToday}
          fu3SentToday={analytics.followupStats.followUp3SentToday}
          dmsToday={analytics.todayDmStats.sentToday}
          repliesToday={analytics.replyStats.repliesToday}
        />

        {/* ── Hot Leads & Recent Replies ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
          {/* Hot Leads — 2 cols */}
          <div className="lg:col-span-2 flex flex-col">
            <div
              className="flex-1 rounded-2xl overflow-hidden flex flex-col"
              style={{ background: '#161927', border: '1px solid rgba(255,255,255,0.055)' }}
            >
              {/* Header */}
              <div
                className="flex items-center justify-between px-5 py-4 flex-shrink-0"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="p-1.5 rounded-lg"
                    style={{ background: 'rgba(251,146,60,0.12)', color: '#fb923c' }}
                  >
                    <Flame size={14} strokeWidth={2} />
                  </div>
                  <span className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>
                    Hot Leads
                  </span>
                  {hotLeads.length > 0 && (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[0.6875rem] font-bold"
                      style={{ background: 'rgba(251,146,60,0.12)', color: '#fb923c' }}
                    >
                      {hotLeads.length}
                    </span>
                  )}
                </div>
                <Link
                  href="/dashboard/leads"
                  className="text-xs font-medium transition-colors duration-150 hover:opacity-80"
                  style={{ color: '#475569' }}
                >
                  View all →
                </Link>
              </div>

              {/* Rows */}
              <div className="px-4 py-2 flex-1">
                <HotLeadsPanel leads={hotLeads} />
              </div>
            </div>
          </div>

          {/* Live Activity — 1 col */}
          <div className="flex flex-col">
            <div
              className="flex-1 rounded-2xl overflow-hidden flex flex-col"
              style={{ background: '#161927', border: '1px solid rgba(255,255,255,0.055)' }}
            >
              {/* Header */}
              <div
                className="flex items-center gap-2.5 px-5 py-4 flex-shrink-0"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              >
                <div
                  className="p-1.5 rounded-lg"
                  style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}
                >
                  <Zap size={14} strokeWidth={2} />
                </div>
                <span className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>
                  Live Activity
                </span>
                <span
                  className="w-1.5 h-1.5 rounded-full ml-auto animate-pulse"
                  style={{ background: '#34d399' }}
                />
              </div>

              {/* Feed */}
              <div className="px-5 py-4 overflow-y-auto flex-1">
                <LiveActivityFeed
                  events={(recentActivity ?? []) as Parameters<typeof LiveActivityFeed>[0]['events']}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Pipeline */}
        <PipelineSummary counts={pipelineCounts} />

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
