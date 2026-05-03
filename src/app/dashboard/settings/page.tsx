import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { SystemSettings } from '@/components/settings/SystemSettings'
import { CategoriesTable } from '@/components/settings/CategoriesTable'
import { Card } from '@/components/ui/Card'

export const revalidate = 0

export interface UsageRow {
  date: string
  label: string
  runs: number
  calls: number
  cost: number
}

export interface OutscraperUsageData {
  todayCalls: number
  todayCost: number
  weekCalls: number
  weekCost: number
  monthCalls: number
  monthCost: number
  avgCallsPerRun: number
  estimatedMonthlyCost: number
  totalRuns: number
  last7Days: UsageRow[]
}

export default async function SettingsPage() {
  const supabase = await createClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const [{ data: settings }, { data: categories }, { data: usageEvents }] = await Promise.all([
    supabase.from('settings').select('*').order('key'),
    supabase.from('categories').select('*').order('name'),
    supabase
      .from('activity_log')
      .select('created_at, metadata')
      .eq('event_type', 'finder_complete')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false }),
  ])

  // Compute usage stats from raw events
  const now = Date.now()
  const todayStr  = new Date(now).toISOString().slice(0, 10)
  const weekAgo   = new Date(now - 7  * 86_400_000).toISOString()
  const monthAgo  = new Date(now - 30 * 86_400_000).toISOString()

  function callsFrom(events: typeof usageEvents, since: string) {
    return (events ?? [])
      .filter((e) => e.created_at >= since)
      .reduce((sum, e) => {
        const meta = e.metadata as Record<string, unknown>
        return sum + (typeof meta?.outscraper_calls === 'number' ? meta.outscraper_calls : 0)
      }, 0)
  }

  const todayCalls  = callsFrom(usageEvents, `${todayStr}T00:00:00.000Z`)
  const weekCalls   = callsFrom(usageEvents, weekAgo)
  const monthCalls  = callsFrom(usageEvents, monthAgo)
  const totalRuns   = (usageEvents ?? []).length
  const avgCallsPerRun = totalRuns > 0 ? Math.round(monthCalls / totalRuns) : 0
  const estimatedMonthlyCost = monthCalls * 0.002

  // Last 7 days breakdown
  const last7Days: UsageRow[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - i * 86_400_000)
    const dateStr = d.toISOString().slice(0, 10)
    const dayEvents = (usageEvents ?? []).filter((e) => e.created_at.slice(0, 10) === dateStr)
    const calls = dayEvents.reduce((sum, e) => {
      const meta = e.metadata as Record<string, unknown>
      return sum + (typeof meta?.outscraper_calls === 'number' ? meta.outscraper_calls : 0)
    }, 0)
    const label = i === 0
      ? `Today (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
      : i === 1
        ? `Yesterday (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
        : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`
    return { date: dateStr, label, runs: dayEvents.length, calls, cost: calls * 0.002 }
  })

  const usageData: OutscraperUsageData = {
    todayCalls,  todayCost:  todayCalls  * 0.002,
    weekCalls,   weekCost:   weekCalls   * 0.002,
    monthCalls,  monthCost:  monthCalls  * 0.002,
    avgCallsPerRun,
    estimatedMonthlyCost,
    totalRuns,
    last7Days,
  }

  return (
    <div>
      <TopBar title="Settings" />
      <div className="p-6 space-y-6 max-w-4xl">
        <Card>
          <SystemSettings initialSettings={settings ?? []} usageData={usageData} />
        </Card>

        <Card>
          <CategoriesTable initialCategories={categories ?? []} />
        </Card>
      </div>
    </div>
  )
}
