import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireWorkspacePage } from '@/lib/page-access'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { getCustomerAnalytics } from '@/lib/customer-analytics'
import { StatsCard } from '@/components/dashboard/StatsCard'
import { Mail, MessageSquare, ThumbsDown, ThumbsUp, Users } from 'lucide-react'

export default async function AnalyticsPage() {
  const { workspace } = await requireWorkspacePage()
  const analytics = await getCustomerAnalytics(createWorkspaceServiceClient(workspace.workspaceId), workspace.workspaceId)

  return (
    <div>
      <TopBar title="Analytics" />
      <div className="page-content page-stack max-w-5xl">
        <section>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Outreach performance</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Workspace results based on sent outreach, stored replies, and business outcomes.</p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatsCard label="Total leads" value={analytics.total_leads} icon={<Users size={19} />} />
            <StatsCard label="Contacted" value={analytics.contacted} icon={<Mail size={19} />} tone="accent" />
            <StatsCard label="Replies" value={analytics.replies} sub={`${analytics.reply_rate}% reply rate`} icon={<MessageSquare size={19} />} tone="success" />
            <StatsCard label="Interested" value={analytics.interested} sub={`${analytics.interested_rate}% of contacted`} icon={<ThumbsUp size={19} />} tone="warning" />
          </div>
        </section>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Recent activity — 14 days">
            <div className="space-y-2">{analytics.trend.map((row) => <div key={row.date} className="grid grid-cols-[1fr_auto_auto] gap-5 text-sm"><span className="text-[var(--text-muted)]">{new Date(`${row.date}T00:00:00`).toLocaleDateString('en-AU',{day:'numeric',month:'short'})}</span><span className="text-[var(--text-secondary)]">{row.contacted} contacted</span><span className="text-[var(--text-secondary)]">{row.replies} replies</span></div>)}</div>
          </Card>
          <Card title="Business outcomes">
            <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-[var(--background-subtle)] p-4"><ThumbsUp size={18} className="text-[var(--success)]"/><p className="mt-3 text-2xl font-semibold">{analytics.interested.toLocaleString()}</p><p className="text-sm text-[var(--text-muted)]">Interested</p></div><div className="rounded-lg bg-[var(--background-subtle)] p-4"><ThumbsDown size={18} className="text-[var(--text-muted)]"/><p className="mt-3 text-2xl font-semibold">{analytics.not_interested.toLocaleString()}</p><p className="text-sm text-[var(--text-muted)]">Not interested</p></div></div>
          </Card>
        </div>
        {analytics.categories.length > 0 && <Card title="Category performance"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]"><th className="py-3 font-medium">Category</th><th className="py-3 text-right font-medium">Leads</th><th className="py-3 text-right font-medium">Contacted</th><th className="py-3 text-right font-medium">Replies</th><th className="py-3 text-right font-medium">Interested</th><th className="py-3 text-right font-medium">Reply rate</th></tr></thead><tbody>{analytics.categories.map(row=><tr key={row.category} className="border-b border-[var(--border-subtle)]"><td className="py-3 text-[var(--text-primary)]">{row.category}</td><td className="py-3 text-right">{row.total_leads}</td><td className="py-3 text-right">{row.contacted}</td><td className="py-3 text-right">{row.replies}</td><td className="py-3 text-right">{row.interested}</td><td className="py-3 text-right">{row.reply_rate}%</td></tr>)}</tbody></table></div></Card>}
      </div>
    </div>
  )
}
