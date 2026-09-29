import { createServiceClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { SystemSettings } from '@/components/settings/SystemSettings'
import { CategoriesTable } from '@/components/settings/CategoriesTable'
import { CitySuburbs } from '@/components/settings/CitySuburbs'
import { LeadFiltering } from '@/components/settings/LeadFiltering'
import { Card } from '@/components/ui/Card'
import { SETTINGS_DEFAULTS, withDefaultSettings } from '@/lib/settingsDefaults'
import { getTemplateModeBlockers, hydrateCategoryTemplates } from '@/lib/category-email-templates'
import { requireWorkspacePage } from '@/lib/page-access'
import { getPlatformSettings, getWorkspaceSettings } from '@/lib/workspace-settings'
import { Tabs } from '@/components/ui/Tabs'
import { getOnboardingState } from '@/lib/onboarding-server'
import { timezoneOptions } from '@/lib/onboarding'
import { WorkspaceProfileSettings } from '@/components/settings/WorkspaceProfileSettings'
import { MailboxSettings } from '@/components/settings/MailboxSettings'
import { UsageLimits } from '@/components/settings/UsageLimits'
import { BillingSettings } from '@/components/settings/BillingSettings'
import Link from 'next/link'

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

interface SettingsPerformanceSummary {
  today_calls?: number
  week_calls?: number
  month_calls?: number
  total_runs?: number
  dead_letter_count?: number
  search_cache_count?: number
  last_7_days?: Array<{ date: string; runs: number; calls: number }>
}

export default async function SettingsPage() {
  const { workspace } = await requireWorkspacePage()
  const onboardingState = await getOnboardingState(workspace.workspaceId)
  const canManageWorkspace = workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin'

  if (!workspace.isPlatformAdmin) {
    return (
      <div>
        <TopBar title="Settings" />
        <div className="page-content page-stack max-w-4xl">
          <Tabs label="Settings sections" items={[
            { label: 'Business', href: '/dashboard/settings' },
            { label: 'Mailbox', href: '#mailbox' },
            { label: 'Personalisation', href: '#personalisation' },
            { label: 'Team', href: '#team' },
            { label: 'Usage', href: '#usage' },
            { label: 'Outreach', href: '#outreach' },
          ]} />
          <Card>
            <WorkspaceProfileSettings
              initialState={onboardingState}
              timezones={timezoneOptions()}
              canEdit={canManageWorkspace}
            />
          </Card>
          <Card><div id="mailbox" className="scroll-mt-28"><MailboxSettings /></div></Card>
          <Card>
            <section id="personalisation" className="scroll-mt-28">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Personalisation</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">Customer-friendly message and personalisation controls are coming in the next phase.</p>
            </section>
          </Card>
          <Card>
            <section id="team" className="scroll-mt-28">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Team</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">Workspace member management is coming in a later phase.</p>
            </section>
          </Card>
          <Card><div id="usage" className="scroll-mt-28"><UsageLimits /></div></Card>
          <Card>
            <section id="outreach" className="scroll-mt-28">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Outreach</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">Targeting and schedule controls will be managed from the Outreach page.</p>
              <Link href="/dashboard/outreach" className="mt-3 inline-flex text-sm font-medium text-[var(--primary)] hover:underline">Open Outreach</Link>
            </section>
          </Card>
        </div>
      </div>
    )
  }

  const supabase = createServiceClient()
  const settingsKeys = Object.keys(SETTINGS_DEFAULTS) as Array<keyof typeof SETTINGS_DEFAULTS>
  const asOf = new Date()
  const [
    { data: categories },
    { data: categoryTemplates },
    { data: suburbRows },
    { data: rawPerformance, error: performanceError },
    platform,
    tenant,
  ] = await Promise.all([
    supabase.from('categories').select(`
      id, name, status, cities, city_content_types, content_type, custom_cities,
      custom_policy_instructions, dm_template, exclude_alcohol_focused,
      exclude_gambling, exclude_pork, exclude_religious_institutions,
      exclude_shisha, halal_filter, pitch_template, search_keywords,
      use_priority_suburbs
    `).eq('workspace_id', workspace.workspaceId).order('name'),
    supabase.from('category_email_templates').select('category_id, template_type, subject_template, body_template').eq('workspace_id', workspace.workspaceId),
    supabase
      .from('city_suburbs')
      .select('id, city, suburb, active, priority')
      .eq('workspace_id', workspace.workspaceId)
      .order('city')
      .order('suburb'),
    supabase.rpc('get_settings_performance_summary', {
      p_workspace_id: workspace.workspaceId,
      p_as_of: asOf.toISOString(),
    }),
    getPlatformSettings(settingsKeys),
    getWorkspaceSettings(workspace.workspaceId, settingsKeys),
  ])
  if (performanceError) throw new Error(`Settings summary failed: ${performanceError.message}`)
  const performance = (rawPerformance ?? {}) as SettingsPerformanceSummary
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

  const todayCalls = Number(performance.today_calls ?? 0)
  const weekCalls = Number(performance.week_calls ?? 0)
  const monthCalls = Number(performance.month_calls ?? 0)
  const totalRuns = Number(performance.total_runs ?? 0)
  const avgCallsPerRun = totalRuns > 0 ? Math.round(monthCalls / totalRuns) : 0
  const estimatedMonthlyCost = monthCalls * 0.002

  const last7Days: UsageRow[] = (performance.last_7_days ?? []).map((row, i) => {
    const d = new Date(`${row.date}T00:00:00.000Z`)
    const dateStr = row.date
    const calls = Number(row.calls ?? 0)
    const label = i === 0
      ? `Today (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
      : i === 1
        ? `Yesterday (${d.getDate()} ${d.toLocaleString('en', { month: 'short' })})`
        : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`
    return { date: dateStr, label, runs: Number(row.runs ?? 0), calls, cost: calls * 0.002 }
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
           { label: 'Billing', href: '#billing' },
           { label: 'Mailboxes', href: '#mailboxes' },
           { label: 'Usage & Limits', href: '#usage' },
          { label: 'Sequences', href: '#sequences' },
          { label: 'Suburbs', href: '#suburbs' },
          { label: 'Targeting', href: '#targeting' },
          { label: 'Categories & templates', href: '#categories' },
        ]} />
        {Number(performance.dead_letter_count ?? 0) > 0 && (
          <Card>
            <div role="alert" className="notice notice--warning">
              ⚠ {Number(performance.dead_letter_count)} failed operation{Number(performance.dead_letter_count) === 1 ? '' : 's'} in dead-letter queue (last 24h). Check pipeline logs for details.
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
        <Card><MailboxSettings /></Card>
        <Card><BillingSettings canManage={workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin'} /></Card>
        <Card><UsageLimits /></Card>
        <Card>
          <div id="sequences" className="scroll-mt-28"><SystemSettings initialSettings={settingsWithDefaults} initialTemplateModeBlockers={templateModeBlockers} usageData={usageData} hasGoogleMapsKey={hasGoogleMapsKey} searchCacheCount={Number(performance.search_cache_count ?? 0)} cities={Object.keys(suburbsByCity).sort()} /></div>
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
            <CategoriesTable
              initialCategories={categoriesWithTemplates}
              canEdit={workspace.isPlatformAdmin || workspace.role === 'owner' || workspace.role === 'admin'}
            />
          </div>
        </Card>
      </div>
    </div>
  )
}
