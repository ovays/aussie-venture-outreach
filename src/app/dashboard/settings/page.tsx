import { createServiceClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { SystemSettings } from '@/components/settings/SystemSettings'
import { CategoriesTable } from '@/components/settings/CategoriesTable'
import { CitySuburbs } from '@/components/settings/CitySuburbs'
import { LeadFiltering } from '@/components/settings/LeadFiltering'
import { Card } from '@/components/ui/Card'
import { SETTINGS_DEFAULTS, withDefaultSettings } from '@/lib/settingsDefaults'
import { getTemplateModeBlockers, hydrateCategoryTemplates } from '@/lib/category-email-templates'
import { requireUser } from '@/lib/auth'
import { requireWorkspaceContext } from '@/lib/workspace-context'
import { getPlatformSettings, getWorkspaceSettings } from '@/lib/workspace-settings'
import { Tabs } from '@/components/ui/Tabs'
import { getOnboardingState } from '@/lib/onboarding-server'
import { timezoneOptions } from '@/lib/onboarding'
import { WorkspaceProfileSettings } from '@/components/settings/WorkspaceProfileSettings'

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
  const auth = await requireUser()
  const workspace = await requireWorkspaceContext(auth)
  const supabase = createServiceClient()
  const onboardingState = await getOnboardingState(workspace.workspaceId)

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString()

  const [{ data: categories }, { data: categoryTemplates }, { data: usageEvents }, { data: suburbRows }, { count: dlqCount }, { count: searchCacheCount }] = await Promise.all([
    supabase.from('categories').select('*').eq('workspace_id', workspace.workspaceId).order('name'),
    supabase.from('category_email_templates').select('category_id, template_type, subject_template, body_template').eq('workspace_id', workspace.workspaceId),
    supabase
      .from('activity_log')
      .select('created_at, metadata')
      .eq('workspace_id', workspace.workspaceId)
      .eq('event_type', 'finder_complete')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false }),
    supabase
      .from('city_suburbs')
      .select('id, city, suburb, active, priority')
      .eq('workspace_id', workspace.workspaceId)
      .order('city')
      .order('suburb'),
    supabase
      .from('dead_letter_queue')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.workspaceId)
      .eq('resolved', false)
      .gte('created_at', since24h),
    supabase
      .from('search_cache')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspace.workspaceId)
      .gt('expires_at', new Date().toISOString()),
  ])

  const settingsKeys = Object.keys(SETTINGS_DEFAULTS) as Array<keyof typeof SETTINGS_DEFAULTS>
  const [platform, tenant] = await Promise.all([
    getPlatformSettings(settingsKeys),
    getWorkspaceSettings(workspace.workspaceId, settingsKeys),
  ])
  const settings = settingsKeys.map((key) => ({
    key,
    value: platform.get(key) ?? tenant.get(key) ?? SETTINGS_DEFAULTS[key].value,
    description: SETTINGS_DEFAULTS[key].description,
  }))

  // Group suburbs by city
  const suburbsByCity: Record<string, { id: string; suburb: string; active: boolean; priority: number }[]> = {}
  for (const row of suburbRows ?? []) {
    if (!suburbsByCity[row.city]) suburbsByCity[row.city] = []
    const r = row as typeof row & { priority?: number | null }
    suburbsByCity[row.city].push({ id: row.id, suburb: row.suburb, active: row.active, priority: r.priority ?? 1 })
  }

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

  const hasGoogleMapsKey = !!process.env.GOOGLE_MAPS_API_KEY
  const settingsWithDefaults = withDefaultSettings(settings ?? [])

  const settingsByKey = Object.fromEntries(settingsWithDefaults.map((s) => [s.key, s.value]))
  const categoriesWithTemplates = hydrateCategoryTemplates(categories ?? [], categoryTemplates ?? [])
  const templateModeBlockers = getTemplateModeBlockers(categoriesWithTemplates.map((category) => ({
    name: category.name,
    status: category.status as 'active' | 'paused',
    initialTemplate: category.initialTemplateReadiness.status === 'missing' ? null : category.templates.initial_pitch,
  })))

  function parseJsonArray(raw: string): string[] {
    try { return JSON.parse(raw) as string[] } catch { return [] }
  }

  const filterEnabled = settingsByKey['enable_lead_filtering'] === 'true'
  const filterKeywords = parseJsonArray(settingsByKey['blocked_business_keywords'] ?? '[]')

  console.log('[SETTINGS_FETCH]', {
    keys: settingsWithDefaults.map((setting) => setting.key),
    values: Object.fromEntries(settingsWithDefaults.map((setting) => [setting.key, setting.value])),
  })

  return (
    <div>
      <TopBar title="Settings" />
      <div className="page-content page-stack max-w-4xl">
        <Tabs label="Settings sections" items={[
          { label: 'Workspace', href: '/dashboard/settings' },
          { label: 'Sequences', href: '#sequences' },
          { label: 'Suburbs', href: '#suburbs' },
          { label: 'Targeting', href: '#targeting' },
          { label: 'Categories & templates', href: '#categories' },
        ]} />
        {(dlqCount ?? 0) > 0 && (
          <Card>
            <div style={{ color: '#fbbf24', fontSize: '14px' }}>
              ⚠ {dlqCount} failed operation{dlqCount === 1 ? '' : 's'} in dead-letter queue (last 24h). Check pipeline logs for details.
            </div>
          </Card>
        )}
        <Card>
          <WorkspaceProfileSettings
            initialState={onboardingState}
            timezones={timezoneOptions()}
            canEdit={workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin'}
          />
        </Card>
        <Card>
          <div id="sequences" className="scroll-mt-28"><SystemSettings initialSettings={settingsWithDefaults} initialTemplateModeBlockers={templateModeBlockers} usageData={usageData} hasGoogleMapsKey={hasGoogleMapsKey} searchCacheCount={searchCacheCount ?? 0} cities={Object.keys(suburbsByCity).sort()} /></div>
        </Card>

        <Card>
          <div id="suburbs" className="scroll-mt-28"><CitySuburbs
            initialData={suburbsByCity}
            initialCategories={(categories ?? []).map((category) => ({
              id: category.id,
              name: category.name,
              status: category.status,
            }))}
          /></div>
        </Card>

        <Card>
          <div id="targeting" className="scroll-mt-28"><LeadFiltering
            initialEnabled={filterEnabled}
            initialKeywords={filterKeywords}
          /></div>
        </Card>

        <Card>
          <div id="categories" className="scroll-mt-28">
            <span id="email-templates" className="scroll-mt-28" />
            <CategoriesTable initialCategories={categoriesWithTemplates} />
          </div>
        </Card>
      </div>
    </div>
  )
}
