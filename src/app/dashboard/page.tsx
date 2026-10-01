import Link from 'next/link'
import { AlertTriangle, ArrowRight, CircleDollarSign, Mail, MessageSquare, RefreshCcw, Send, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { HotLeadsPanel } from '@/components/dashboard/HotLeadsPanel'
import { StatsCard } from '@/components/dashboard/StatsCard'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { DailyActivity } from '@/components/dashboard/DailyActivity'
import { Card } from '@/components/ui/Card'
import { logAnalyticsMetrics } from '@/lib/analytics'
import { getDashboardSummary } from '@/lib/dashboard-summary'
import { buildStageCounts } from '@/lib/lead-status'
import { requireWorkspacePage } from '@/lib/page-access'
import { getWorkspaceStatusDisplay } from '@/lib/workspace-display-server'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { CUSTOMER_LEAD_STATUS_LABELS, formatCustomerActivity, type CustomerLeadFilter } from '@/lib/customer-lead'

export const revalidate = 60

export default async function DashboardPage() {
  const { workspace } = await requireWorkspacePage()
  const supabase = await createClient()
  const customerOverviewPromise: PromiseLike<{ data: unknown; error: { message: string } | null }> = workspace.isPlatformAdmin
    ? Promise.resolve({ data: null, error: null })
    : createWorkspaceServiceClient(workspace.workspaceId).rpc('get_customer_leads_page' as never, {
      p_workspace_id: workspace.workspaceId, p_status: 'all', p_search: '', p_page: 1, p_page_size: 1, p_as_of: new Date().toISOString(),
    } as never)
  const [{ analytics, statusMap, recentActivity, pendingDMCount, dealsRolling30DayCount, hotLeads }, workspaceStatus, customerResult] = await Promise.all([
    getDashboardSummary(supabase, workspace.workspaceId),
    getWorkspaceStatusDisplay(workspace.workspaceId),
    customerOverviewPromise,
  ])
  logAnalyticsMetrics('[DASHBOARD_METRICS]', { range: analytics.todayEmailStats.range, totalEmails: analytics.todayEmailStats.totalSent, followups: analytics.followupStats.sentToday, replies: analytics.replyStats.repliesToday })
  const stageCounts = buildStageCounts(statusMap)
  const totalLeads = Object.values(statusMap).reduce((sum, count) => sum + count, 0)
  if (!workspace.isPlatformAdmin) {
    const overview = customerResult.data && typeof customerResult.data === 'object' && !Array.isArray(customerResult.data)
      ? customerResult.data as { counts?: Partial<Record<CustomerLeadFilter, number>>; recent_activity?: Array<{ id: string; event_type: string; business_name?: string; created_at: string }> }
      : {}
    const counts = overview.counts ?? {}
    const customerActivity = (overview.recent_activity ?? []).flatMap((event) => {
      const formatted = formatCustomerActivity(event)
      return formatted ? [{ id: event.id, event_type: formatted.kind, description: formatted.text, created_at: event.created_at, lead_id: null }] : []
    })
    const customerTotal = counts.all ?? totalLeads
    const attention = (counts.replied ?? 0) + (counts.reactivation_due ?? 0)
    return <div>
      <TopBar title="Dashboard" />
      <div className="page-content page-stack">
        <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-base font-semibold text-[var(--text-primary)]">Workspace overview</h2><p className="mt-0.5 text-sm text-[var(--text-muted)]">Your outreach at a glance</p></div><span className="hidden items-center gap-2 text-xs text-[var(--text-muted)] sm:flex"><span className={`h-2 w-2 rounded-full ${workspaceStatus.label === 'Live' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}`} />{workspaceStatus.label}{workspaceStatus.city ? ` · ${workspaceStatus.city}` : ''}</span></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatsCard label="Total leads" value={customerTotal} sub={`${counts.new ?? 0} new`} icon={<Users size={19} />} />
            <StatsCard label="Contacted" value={counts.contacted ?? 0} sub={`${analytics.todayEmailStats.totalSent} emails sent today`} icon={<Mail size={19} />} tone="accent" />
            <StatsCard label="Replies" value={counts.replied ?? 0} sub={`${analytics.replyStats.repliesToday} received today`} icon={<MessageSquare size={19} />} tone="success" />
            <StatsCard label="Interested" value={counts.interested ?? 0} sub="Positive business outcomes" icon={<CircleDollarSign size={19} />} tone="warning" />
          </div>
        </section>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
          <Card noPadding><div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4"><div><h2 className="text-sm font-semibold text-[var(--text-primary)]">Leads needing attention</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Replies and businesses ready to reconnect</p></div><span className="text-lg font-semibold text-[var(--text-primary)]">{attention}</span></div>
            <div className="divide-y divide-[var(--border-subtle)]">{([
              ['Replies to review', counts.replied ?? 0, '/dashboard/leads?status=replied', MessageSquare],
              ['Reconnect due', counts.reactivation_due ?? 0, '/dashboard/leads?status=reactivation_due', RefreshCcw],
            ] as const).map(([label, value, href, Icon]) => <Link key={label} href={href} className="flex items-center gap-3 px-5 py-4 hover:bg-[var(--surface-hover)]"><Icon size={17} className="text-[var(--primary)]" /><span className="flex-1 text-sm text-[var(--text-secondary)]">{label}</span><strong className="text-[var(--text-primary)]">{value}</strong><ArrowRight size={14} className="text-[var(--text-muted)]" /></Link>)}</div>
          </Card>
          <Card noPadding><div className="border-b border-[var(--border-subtle)] px-5 py-4"><h2 className="text-sm font-semibold text-[var(--text-primary)]">Lead status</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Where your businesses are now</p></div><div className="space-y-3 p-5">{(['new','email_ready','contacted','replied','interested','not_interested','dead'] as CustomerLeadFilter[]).map((status) => <Link key={status} href={`/dashboard/leads?status=${status}`} className="flex items-center justify-between text-sm"><span className="text-[var(--text-secondary)]">{CUSTOMER_LEAD_STATUS_LABELS[status]}</span><strong className="text-[var(--text-primary)]">{counts[status] ?? 0}</strong></Link>)}</div></Card>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3"><div className="lg:col-span-2"><Card title="Recent activity"><ActivityFeed events={customerActivity.slice(0, 8)} /></Card></div><Card noPadding><div className="p-5"><h2 className="text-sm font-semibold text-[var(--text-primary)]">Your leads</h2><p className="mt-1 text-sm text-[var(--text-muted)]">Review businesses, replies, outcomes and team notes.</p><Link href="/dashboard/leads" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--primary)]">Open Leads <ArrowRight size={14} /></Link></div></Card></div>
        <Card title="Outreach activity — last 7 days"><DailyActivity rows={analytics.dailyRows} /></Card>
      </div>
    </div>
  }
  const actionItems = [
    { label: 'Follow-ups due', value: analytics.followupStats.fuDue, detail: `${analytics.followupStats.overdueTotal} overdue`, href: '/dashboard/inbox?view=follow-ups', icon: Send, tone: 'var(--primary)' },
    { label: 'Replies to review', value: statusMap.replied ?? 0, detail: `${analytics.replyStats.repliesToday} received today`, href: '/dashboard/leads?status=replied', icon: MessageSquare, tone: 'var(--accent)' },
    { label: 'Reactivation queue', value: analytics.followupStats.reactivationTotal, detail: 'Ready for re-engagement', href: '/dashboard/leads?status=reactivation_due', icon: RefreshCcw, tone: 'var(--warning)' },
    { label: 'Delivery attention', value: analytics.followupStats.overdueTotal, detail: 'Past due date', href: '/dashboard/inbox?view=failed', icon: AlertTriangle, tone: 'var(--error)' },
  ]

  return <div>
    <TopBar title="Dashboard" />
    <div className="page-content page-stack">
      <section aria-labelledby="overview-heading">
        <div className="mb-3 flex items-end justify-between"><div><h2 id="overview-heading" className="text-base font-semibold text-[var(--text-primary)]">Workspace overview</h2><p className="mt-0.5 text-sm text-[var(--text-muted)]">Today&apos;s performance at a glance</p></div><span className="hidden items-center gap-2 text-xs text-[var(--text-muted)] sm:flex"><span className={`h-2 w-2 rounded-full ${workspaceStatus.label === 'Live' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}`} />{workspaceStatus.label}{workspaceStatus.city ? ` · ${workspaceStatus.city}` : ''}</span></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatsCard label="Total leads" value={totalLeads} sub={`${stageCounts.contacted} contacted`} icon={<Users size={19} />} />
          <StatsCard label="Emails sent today" value={analytics.todayEmailStats.totalSent} sub={`${analytics.followupStats.sentToday} follow-ups`} icon={<Mail size={19} />} tone="accent" />
          <StatsCard label="Replies today" value={analytics.replyStats.repliesToday} sub={`${analytics.replyStats.replyRate}% reply rate`} icon={<MessageSquare size={19} />} tone="success" />
          <StatsCard label="Deals this month" value={dealsRolling30DayCount} sub={`${stageCounts.negotiating} active negotiations`} icon={<CircleDollarSign size={19} />} tone="warning" />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,.65fr)]">
        <Card noPadding>
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4"><div><h2 className="text-sm font-semibold text-[var(--text-primary)]">Needs attention</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Prioritised outreach work</p></div><Link href="/dashboard/leads" className="text-xs font-medium text-[var(--primary)] hover:underline">View leads</Link></div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {actionItems.map(({ label, value, detail, href, icon: Icon, tone }) => <Link key={label} href={href} className="group flex items-center gap-3 px-5 py-3.5 hover:bg-[var(--surface-hover)]"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ color: tone, background: `color-mix(in srgb, ${tone} 10%, transparent)` }}><Icon size={17} /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-[var(--text-primary)]">{label}</span><span className="block truncate text-xs text-[var(--text-muted)]">{detail}</span></span><span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{value.toLocaleString()}</span><ArrowRight size={15} className="text-[var(--text-muted)] group-hover:translate-x-0.5 group-hover:text-[var(--primary)]" /></Link>)}
          </div>
        </Card>
        <Card noPadding>
          <div className="border-b border-[var(--border-subtle)] px-5 py-4"><h2 className="text-sm font-semibold text-[var(--text-primary)]">Lead summary</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Current lifecycle distribution</p></div>
          <div className="space-y-4 p-5">{[
            ['New & researching', (statusMap.new ?? 0) + (statusMap.researched ?? 0) + (statusMap.email_ready ?? 0), 'var(--primary)'],
            ['Contacted', stageCounts.contacted, 'var(--accent)'],
            ['Replied', stageCounts.replied, 'var(--success)'],
            ['Negotiating', stageCounts.negotiating, 'var(--warning)'],
            ['Closed', stageCounts.closed, 'var(--success)'],
          ].map(([label, value, color]) => { const numeric = Number(value); const pct = Math.max(totalLeads ? (numeric / totalLeads) * 100 : 0, numeric ? 3 : 0); return <div key={String(label)}><div className="mb-1.5 flex justify-between text-xs"><span className="text-[var(--text-secondary)]">{label}</span><span className="font-semibold text-[var(--text-primary)]">{numeric.toLocaleString()}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[var(--background-subtle)]"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: String(color) }} /></div></div> })}</div>
          <div className="border-t border-[var(--border-subtle)] px-5 py-3"><Link href="/dashboard/leads" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--primary)]">Explore all leads <ArrowRight size={13} /></Link></div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><Card noPadding><div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4"><div><h2 className="text-sm font-semibold text-[var(--text-primary)]">Priority leads</h2><p className="mt-0.5 text-xs text-[var(--text-muted)]">Replies, interest, and active negotiations</p></div><Link href="/dashboard/leads" className="text-xs font-medium text-[var(--primary)]">View all</Link></div><div className="px-3 py-2"><HotLeadsPanel leads={hotLeads} /></div></Card></div>
        <Card title="Recent activity"><ActivityFeed events={recentActivity.slice(0, 8)} /></Card>
      </div>

      <Card title="Last 7 days"><DailyActivity rows={analytics.dailyRows} /></Card>
      {pendingDMCount > 0 && <div className="flex flex-col gap-3 rounded-xl border border-[var(--info-border)] bg-[var(--info-muted)] p-4 sm:flex-row sm:items-center"><MessageSquare size={19} className="shrink-0 text-[var(--info)]" /><div className="flex-1"><p className="text-sm font-medium text-[var(--text-primary)]">{pendingDMCount.toLocaleString()} direct messages are ready for review</p><p className="text-xs text-[var(--text-muted)]">Review your outreach before taking action.</p></div><Link href="/dashboard/outreach" className="text-sm font-semibold text-[var(--info)]">Open Outreach</Link></div>}
    </div>
  </div>
}
