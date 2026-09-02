import Link from 'next/link'
import { AI_WORKFLOWS } from '@/ai/configuration/AIConfiguration'
import type { AIAnalyticsData, AIRanking } from '@/ai/observability/analytics-types'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireAdmin } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'

export const revalidate = 0

interface PageProps {
  searchParams: Promise<{
    start?: string
    end?: string
    workflow?: string
    provider?: string
    status?: string
  }>
}

const SYDNEY_TIME_ZONE = 'Australia/Sydney'

function parseCalendarDate(value?: string): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? date
    : null
}

function sydneyMidnight(date: Date): string {
  const wallClockUtc = date.getTime()
  let instant = wallClockUtc
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: SYDNEY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value])
    )
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    )
    instant = wallClockUtc - (representedAsUtc - instant)
  }

  return new Date(instant).toISOString()
}

function startTimestamp(value?: string): string | null {
  const date = parseCalendarDate(value)
  return date ? sydneyMidnight(date) : null
}

function endTimestamp(value?: string): string | null {
  const date = parseCalendarDate(value)
  if (!date) return null
  date.setUTCDate(date.getUTCDate() + 1)
  return sydneyMidnight(date)
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function number(value: number): string {
  return new Intl.NumberFormat('en-AU').format(value)
}

function latency(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} s` : `${Math.round(value)} ms`
}

function cost(value: number | null): string {
  return value === null ? 'Unavailable' : `$${value.toFixed(6)}`
}

function RankingList({ rows }: { rows: AIRanking[] }) {
  if (rows.length === 0) {
    return <p className="text-sm" style={{ color: '#64748b' }}>No requests match these filters.</p>
  }

  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center justify-between gap-4 text-sm">
          <span className="truncate text-slate-300" title={row.name}>{titleCase(row.name)}</span>
          <span className="font-medium text-white">{number(row.count)}</span>
        </li>
      ))}
    </ol>
  )
}

export default async function AIAnalyticsPage({ searchParams }: PageProps) {
  await requireAdmin()
  const filters = await searchParams
  const supabase = createServiceClient()

  const [{ data, error }, { data: providerRows }] = await Promise.all([
    supabase.rpc('get_ai_request_analytics', {
      p_start_at: startTimestamp(filters.start),
      p_end_at: endTimestamp(filters.end),
      p_workflow: filters.workflow || null,
      p_provider: filters.provider || null,
      p_status: filters.status || null,
      p_recent_limit: 50,
    }),
    supabase.from('ai_providers').select('provider_key, display_name').order('display_name'),
  ])

  if (error) throw new Error(`Unable to load AI analytics: ${error.message}`)
  const analytics = data as AIAnalyticsData
  const summaryCards = [
    ['Total Requests', number(analytics.summary.totalRequests)],
    ['Successful Requests', number(analytics.summary.successfulRequests)],
    ['Failed Requests', number(analytics.summary.failedRequests)],
    ['Success Rate', `${analytics.summary.successRate.toFixed(2)}%`],
    ['Average Latency', latency(analytics.summary.averageLatencyMs)],
    ['Average Cost', cost(analytics.summary.averageCostUsd)],
    ['Requests Today', number(analytics.summary.requestsToday)],
    ['Requests This Month', number(analytics.summary.requestsThisMonth)],
  ]

  return (
    <div>
      <TopBar title="AI Analytics" />
      <div className="page-content page-stack">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: '#64748b' }}>
              <Link href="/dashboard/settings" className="hover:text-sky-400">Settings</Link>
              <span>/</span>
              <Link href="/dashboard/settings/ai" className="hover:text-sky-400">AI</Link>
              <span>/</span>
              <span className="text-slate-300">Analytics</span>
            </div>
            <h1 className="text-xl font-semibold text-white">AI observability</h1>
            <p className="mt-1 text-sm" style={{ color: '#94a3b8' }}>
              Provider-independent request volume, reliability, latency, token use, and estimated cost.
            </p>
          </div>
          <Link
            href="/dashboard/settings/ai"
            className="rounded-lg border px-3 py-2 text-sm text-slate-300 hover:text-white"
            style={{ borderColor: '#2a2d3e', background: '#11141d' }}
          >
            AI Settings
          </Link>
        </div>

        <Card>
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
            <label className="space-y-1.5 text-sm text-slate-400">
              <span>From</span>
              <input name="start" type="date" defaultValue={filters.start} className="w-full rounded-lg border px-3 py-2 text-white" style={{ background: '#0f1117', borderColor: '#2a2d3e' }} />
            </label>
            <label className="space-y-1.5 text-sm text-slate-400">
              <span>To</span>
              <input name="end" type="date" defaultValue={filters.end} className="w-full rounded-lg border px-3 py-2 text-white" style={{ background: '#0f1117', borderColor: '#2a2d3e' }} />
            </label>
            <label className="space-y-1.5 text-sm text-slate-400">
              <span>Workflow</span>
              <select name="workflow" defaultValue={filters.workflow ?? ''} className="w-full rounded-lg border px-3 py-2 text-white" style={{ background: '#0f1117', borderColor: '#2a2d3e' }}>
                <option value="">All workflows</option>
                {AI_WORKFLOWS.map((workflow) => <option key={workflow} value={workflow}>{titleCase(workflow)}</option>)}
                <option value="provider_connection_test">Provider Connection Test</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm text-slate-400">
              <span>Provider</span>
              <select name="provider" defaultValue={filters.provider ?? ''} className="w-full rounded-lg border px-3 py-2 text-white" style={{ background: '#0f1117', borderColor: '#2a2d3e' }}>
                <option value="">All providers</option>
                {(providerRows ?? []).map((provider) => <option key={provider.provider_key} value={provider.provider_key}>{provider.display_name}</option>)}
              </select>
            </label>
            <label className="space-y-1.5 text-sm text-slate-400">
              <span>Status</span>
              <select name="status" defaultValue={filters.status ?? ''} className="w-full rounded-lg border px-3 py-2 text-white" style={{ background: '#0f1117', borderColor: '#2a2d3e' }}>
                <option value="">All statuses</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <div className="flex gap-2">
              <button type="submit" className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500">Filter</button>
              <Link href="/dashboard/settings/ai/analytics" className="rounded-lg border px-3 py-2 text-sm text-slate-300 hover:text-white" style={{ borderColor: '#2a2d3e' }}>Clear</Link>
            </div>
          </form>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summaryCards.map(([label, value]) => (
            <Card key={label}>
              <p className="text-xs uppercase tracking-wide" style={{ color: '#64748b' }}>{label}</p>
              <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
            </Card>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <Card title="Top Workflows"><RankingList rows={analytics.topWorkflows} /></Card>
          <Card title="Top Models"><RankingList rows={analytics.topModels} /></Card>
          <Card title="Top Providers"><RankingList rows={analytics.topProviders} /></Card>
        </div>

        <Card title="Recent Requests" noPadding>
          <div className="data-table-shell desktop-data-table">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide" style={{ borderColor: '#2a2d3e', color: '#64748b' }}>
                  {['Timestamp', 'Workflow', 'Provider / Model', 'Status', 'Latency', 'Tokens', 'Cost', 'Retries', 'Source', 'Error'].map((header) => (
                    <th key={header} className="px-4 py-3 font-medium">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: '#2a2d3e' }}>
                {analytics.recentRequests.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-500">No requests match these filters.</td></tr>
                ) : analytics.recentRequests.map((request) => (
                  <tr key={request.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">{new Date(request.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</td>
                    <td className="px-4 py-3 text-slate-200">{titleCase(request.workflow)}</td>
                    <td className="px-4 py-3"><div className="text-slate-200">{request.provider ?? 'Unavailable'}</div><div className="text-xs text-slate-500">{request.model ?? 'Unavailable'}</div></td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs ${request.status === 'succeeded' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{titleCase(request.status)}</span></td>
                    <td className="px-4 py-3 text-slate-300">{latency(request.durationMs)}</td>
                    <td className="px-4 py-3 text-slate-300" title={`Input: ${request.inputTokens ?? 'unknown'}; Output: ${request.outputTokens ?? 'unknown'}`}>{request.totalTokens === null ? 'Unavailable' : number(request.totalTokens)}</td>
                    <td className="px-4 py-3 text-slate-300">{cost(request.estimatedCostUsd)}</td>
                    <td className="px-4 py-3 text-slate-300">{request.retryCount}</td>
                    <td className="px-4 py-3 text-slate-400">{request.requestSource}</td>
                    <td className="max-w-64 truncate px-4 py-3 text-red-300" title={request.errorMessage ?? undefined}>{request.errorMessage ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-data-list" data-testid="ai-analytics-mobile-cards">
            {analytics.recentRequests.length === 0 ? (
              <div className="data-state data-state--compact"><p className="data-state__title">No requests match these filters.</p></div>
            ) : analytics.recentRequests.map((request) => (
              <article key={request.id} className="responsive-data-card">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-[var(--text-primary)]">{titleCase(request.workflow)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{new Date(request.createdAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p></div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${request.status === 'succeeded' ? 'bg-[var(--success-muted)] text-[var(--success)]' : 'bg-[var(--error-muted)] text-[var(--error)]'}`}>{titleCase(request.status)}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div><dt className="text-[var(--text-muted)]">Provider / Model</dt><dd className="mt-1 break-words text-[var(--text-secondary)]">{request.provider ?? 'Unavailable'} · {request.model ?? 'Unavailable'}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Latency</dt><dd className="mt-1 text-[var(--text-secondary)]">{latency(request.durationMs)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Tokens</dt><dd className="mt-1 text-[var(--text-secondary)]">{request.totalTokens === null ? 'Unavailable' : number(request.totalTokens)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Cost</dt><dd className="mt-1 text-[var(--text-secondary)]">{cost(request.estimatedCostUsd)}</dd></div>
                </dl>
                {request.errorMessage && <p className="mt-3 line-clamp-3 text-xs text-[var(--error)]" title={request.errorMessage}>{request.errorMessage}</p>}
              </article>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
