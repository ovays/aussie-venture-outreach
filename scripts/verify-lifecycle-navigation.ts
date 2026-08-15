/**
 * Read-only baseline and bounded-loading verification for migration 040.
 * Run with a fixed instant:
 *   npx tsx --env-file=.env.local scripts/verify-lifecycle-navigation.ts 2026-08-15T00:00:00.000Z
 *
 * Focused checks (neither runs Pipeline or Email Log pagination):
 *   npx tsx --env-file=.env.local scripts/verify-lifecycle-navigation.ts --lifecycle-benchmark
 *   npx tsx --env-file=.env.local scripts/verify-lifecycle-navigation.ts --health
 *
 * The script never writes.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { computeFollowUpEligibility, isFuEmailSent } from '../src/lib/followup-eligibility'
import { STAGE_STATUSES } from '../src/lib/lead-status'

const FIXED_AS_OF = '2026-08-15T00:00:00.000Z'
const mode = process.argv.find((argument) => argument.startsWith('--')) ?? '--full'
const asOfArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const asOf = new Date(asOfArgument ?? FIXED_AS_OF)
if (Number.isNaN(asOf.getTime())) throw new Error('Pass a valid fixed asOf ISO instant')

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface Measurement { requests: number; rows: number; bytes: number; durationMs: number }
const blank = (): Measurement => ({ requests: 0, rows: 0, bytes: 0, durationMs: 0 })

async function measured<T>(metrics: Measurement, operation: () => PromiseLike<{ data: T; error: { message: string } | null; count?: number | null }>) {
  const started = performance.now()
  const result = await operation()
  metrics.requests++
  metrics.durationMs += performance.now() - started
  if (result.error) throw new Error(result.error.message)
  const data = result.data
  metrics.rows += Array.isArray(data) ? data.length : data == null ? 0 : 1
  metrics.bytes += Buffer.byteLength(JSON.stringify(data ?? null))
  return result
}

async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, metrics: Measurement, size = 1000) {
  const rows: T[] = []
  for (let from = 0; ; from += size) {
    const { data } = await measured(metrics, () => build(from, from + size - 1))
    rows.push(...(data ?? []))
    if (!data || data.length < size) return rows
  }
}

type EmailEvent = { type: string; sent_at: string | null }
type LegacyLead = { id: string; business_name: string; email: string | null; status: string; reactivation_sent_at: string | null; emails: EmailEvent[] }

function legacyReactivationState(reactivationSentAt: string, deadAfterReactivationDays: number, current: Date) {
  const deadline = new Date(new Date(reactivationSentAt).getTime() + deadAfterReactivationDays * 86_400_000).toISOString()
  const daysSinceReactivation = Math.floor((current.getTime() - new Date(reactivationSentAt).getTime()) / 86_400_000)
  const overdue = daysSinceReactivation >= deadAfterReactivationDays
  return { stage: overdue ? 'Awaiting Dead' : 'Reactivated', action: 'Mark Dead', deadline, overdue }
}

function verifyReactivationWithoutInitial() {
  const lead: LegacyLead = {
    id: 'reactivated-without-initial', business_name: 'Fixture', email: 'fixture@example.com', status: 'contacted',
    reactivation_sent_at: '2026-08-01T00:00:00.000Z', emails: [],
  }
  assert.equal(lead.emails.some((email) => email.type === 'initial_pitch' && email.sent_at), false)
  const deadAfterReactivationDays = 14
  const expectedDeadline = '2026-08-15T00:00:00.000Z'
  assert.deepEqual(
    legacyReactivationState(lead.reactivation_sent_at!, deadAfterReactivationDays, new Date('2026-08-14T23:59:59.999Z')),
    { stage: 'Reactivated', action: 'Mark Dead', deadline: expectedDeadline, overdue: false },
  )
  assert.deepEqual(
    legacyReactivationState(lead.reactivation_sent_at!, deadAfterReactivationDays, new Date('2026-08-15T00:00:00.001Z')),
    { stage: 'Awaiting Dead', action: 'Mark Dead', deadline: expectedDeadline, overdue: true },
  )
}

function classify(lead: LegacyLead, settings: Record<string, string>) {
  const emails = lead.emails ?? []
  const initial = emails.find((email) => email.type === 'initial_pitch' && email.sent_at)
  const fu1 = emails.find((email) => email.type === 'follow_up_1' && isFuEmailSent(email))
  const fu2 = emails.find((email) => email.type === 'follow_up_2' && isFuEmailSent(email))
  const fu3 = emails.find((email) => email.type === 'follow_up_3' && isFuEmailSent(email))
  const days = initial?.sent_at ? Math.floor((asOf.getTime() - new Date(initial.sent_at).getTime()) / 86_400_000) : null
  if (lead.status === 'dead') return { stage: 'Dead', filter: 'dead', overdue: false }
  if (lead.reactivation_sent_at) {
    const result = legacyReactivationState(lead.reactivation_sent_at, Number(settings.dead_after_reactivation_days ?? 14), asOf)
    return { stage: result.stage, filter: 'reactivation', overdue: result.overdue }
  }
  if (!initial?.sent_at) return { stage: 'Unknown', filter: 'none', overdue: false }
  const eligibility = computeFollowUpEligibility(initial.sent_at, !!fu1, !!fu2, !!fu3, {
    fu1Days: Number(settings.follow_up_1_days ?? 7),
    fu2Days: Number(settings.follow_up_2_days ?? 14),
    fu3Days: Number(settings.follow_up_3_days ?? 21),
  }, asOf)
  if (eligibility.nextFuType === 'follow_up_3') return { stage: 'Follow-up 2 Sent', filter: 'fu3', overdue: eligibility.isDue }
  if (eligibility.nextFuType === null) {
    if (settings.reactivation_enabled === 'true') {
      const overdue = (days ?? 0) >= Number(settings.reactivation_delay_days ?? 60)
      return { stage: overdue ? 'Reactivation Due' : 'Follow-up 3 Sent', filter: 'reactivation', overdue }
    }
    return { stage: 'Follow-up 3 Sent', filter: 'none', overdue: (days ?? 0) >= Number(settings.dead_lead_days ?? 21) }
  }
  if (eligibility.nextFuType === 'follow_up_2') return { stage: 'Follow-up 1 Sent', filter: 'fu2', overdue: eligibility.isDue }
  return { stage: 'Initial Sent', filter: 'fu1', overdue: eligibility.isDue }
}

function lifecycleCounts(classified: ReturnType<typeof classify>[]) {
  const count = (predicate: (row: ReturnType<typeof classify>) => boolean) => classified.filter(predicate).length
  return {
    all: classified.length,
    fu_due: count((row) => ['fu1', 'fu2', 'fu3'].includes(row.filter) && row.overdue),
    fu1_due: count((row) => row.filter === 'fu1' && row.overdue),
    fu2_due: count((row) => row.filter === 'fu2' && row.overdue),
    fu3_due: count((row) => row.filter === 'fu3' && row.overdue),
    fu1: count((row) => row.filter === 'fu1'), fu2: count((row) => row.filter === 'fu2'), fu3: count((row) => row.filter === 'fu3'),
    overdue: count((row) => row.overdue),
    reactivation: count((row) => row.filter === 'reactivation' && row.stage !== 'Awaiting Dead'),
    awaiting_dead: count((row) => row.stage === 'Awaiting Dead'), dead: count((row) => row.filter === 'dead'),
  }
}

async function baselineLifecycle() {
  const metrics = blank()
  const settingsResult = await measured(metrics, () => supabase.from('settings').select('key, value').in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled']))
  const deadResult = await measured(metrics, () => supabase.from('leads').select('id, business_name, email, status, reactivation_sent_at, emails(type, sent_at)').eq('status', 'dead').order('created_at', { ascending: false }).limit(200))
  await measured(metrics, () => supabase.from('activity_log').select('id', { count: 'exact', head: true }).eq('event_type', 'lead_marked_dead').gte('created_at', asOf.toISOString().slice(0, 10)))
  const contacted = await readAll<LegacyLead>((from, to) => supabase.from('leads').select('id, business_name, email, status, reactivation_sent_at, emails(type, sent_at)').eq('status', 'contacted').order('created_at', { ascending: false }).range(from, to), metrics)
  const settings = Object.fromEntries((settingsResult.data ?? []).map((row: { key: string; value: string }) => [row.key, row.value]))
  const leads = [...contacted, ...((deadResult.data ?? []) as LegacyLead[])].filter((lead) => lead.email)
  return { metrics, counts: lifecycleCounts(leads.map((lead) => classify(lead, settings))), rows: leads.length }
}

const PIPELINE_STAGES = { new: ['new'], ...STAGE_STATUSES } as Record<string, readonly string[]>
async function verifyPipeline() {
  const baseline = blank()
  const baselineResult = await measured(baseline, () => supabase.from('leads').select('*').not('status', 'in', '("researched","email_ready")').order('created_at', { ascending: false }).limit(2000))
  const initial = blank()
  const initialStarted = performance.now()
  await Promise.all(Object.values(PIPELINE_STAGES).map((statuses) => measured(initial, () => supabase.from('leads').select('id, business_name, category_name, city, suburb, status, deal_value, created_at', { count: 'exact' }).in('status', [...statuses]).order('created_at', { ascending: false }).order('id', { ascending: true }).range(0, 49))))
  const initialWallMs = performance.now() - initialStarted
  const optimized = blank()
  const totals: Record<string, number> = {}
  for (const [stage, statuses] of Object.entries(PIPELINE_STAGES)) {
    const ids: string[] = []
    let expected = Infinity
    for (let page = 0; ids.length < expected; page++) {
      const { data, count } = await measured(optimized, () => supabase.from('leads').select('id, business_name, category_name, city, suburb, status, deal_value, created_at', { count: 'exact' }).in('status', [...statuses]).order('created_at', { ascending: false }).order('id', { ascending: true }).range(page * 100, page * 100 + 99))
      expected = count ?? 0
      ids.push(...(data ?? []).map((row: { id: string }) => row.id))
    }
    assert.equal(new Set(ids).size, ids.length, `${stage} pagination duplicated an id`)
    assert.equal(ids.length, expected, `${stage} pagination omitted an id`)
    totals[stage] = expected
  }
  return { baseline: { ...baseline, returned: baselineResult.data?.length ?? 0 }, initial: { ...initial, wallMs: initialWallMs }, exhaustivePagination: optimized, totals }
}

async function verifyEmailLog() {
  const baseline = blank()
  const legacy = await measured(baseline, () => supabase.from('emails').select('*, leads(business_name, category_name, city)', { count: 'exact' }).order('created_at', { ascending: false }).limit(500))
  const initial = blank()
  await measured(initial, () => supabase.from('emails').select('id, type, subject, status, sent_at, replied_at, created_at, leads(business_name, category_name, city)', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: true }).range(0, 49))
  const optimized = blank()
  const ids: string[] = []
  let expected = Infinity
  for (let page = 0; ids.length < expected; page++) {
    const result = await measured(optimized, () => supabase.from('emails').select('id, type, subject, status, sent_at, replied_at, created_at, leads(business_name, category_name, city)', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: true }).range(page * 100, page * 100 + 99))
    expected = result.count ?? 0
    ids.push(...(result.data ?? []).map((row: { id: string }) => row.id))
    for (const row of result.data ?? []) {
      assert(!('body_html' in row) && !('body_text' in row), 'Email list leaked a body field')
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'Email pagination duplicated an id')
  assert.equal(ids.length, expected, 'Email pagination omitted an id')
  const representativeSubject = legacy.data?.find((row: { subject?: string | null }) => row.subject?.trim())?.subject?.trim() ?? ''
  const search = representativeSubject.slice(0, Math.min(12, representativeSubject.length))
  const rpc = await checkEmailLogRpc(search)
  return { baseline: { ...baseline, returned: legacy.data?.length ?? 0, exactTotal: legacy.count ?? 0 }, initial, exhaustivePagination: optimized, exactTotal: expected, rpc }
}

async function expectedEmailSummary(search: string) {
  const contactedStatuses = ['contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead']
  const positiveStatuses = ['replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual']
  const [contacted, positive] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).in('status', contactedStatuses),
    supabase.from('leads').select('id', { count: 'exact', head: true }).in('status', positiveStatuses),
  ])
  if (contacted.error) throw contacted.error
  if (positive.error) throw positive.error
  let emailQuery = supabase.from('emails').select('status').order('created_at', { ascending: false }).order('id', { ascending: true }).limit(500)
  if (search) emailQuery = emailQuery.ilike('subject', `%${search}%`)
  const emails = await emailQuery
  if (emails.error) throw emails.error
  const totalContacted = contacted.count ?? 0
  const positiveResponses = positive.count ?? 0
  return {
    total_contacted_leads: totalContacted,
    positive_response_leads: positiveResponses,
    reply_rate: totalContacted > 0 ? Math.round(positiveResponses / totalContacted * 100) : 0,
    matching_bounced: (emails.data ?? []).filter((email) => email.status === 'bounced').length,
  }
}

async function checkEmailLogRpc(representativeSearch: string) {
  const cases = [{ name: 'unsearched', search: '' }]
  if (representativeSearch) cases.push({ name: 'searched', search: representativeSearch })
  const results: Record<string, unknown> = {}
  for (const testCase of cases) {
    const expected = await expectedEmailSummary(testCase.search)
    const { data, error } = await supabase.rpc('get_email_log_summary', { p_type: null, p_status: null, p_search: testCase.search })
    if (error?.message.includes('Could not find the function') || error?.message.includes('schema cache')) {
      results[testCase.name] = { status: 'PENDING', reason: error.message }
      continue
    }
    if (error) throw error
    assert.deepEqual(data, expected, `Email Log ${testCase.name} summary differs`)
    results[testCase.name] = { status: 'PASS', search: testCase.search }
  }
  return results
}

async function measureLegacyHealth() {
  const metrics = blank()
  const since24h = new Date(asOf.getTime() - 24 * 3_600_000).toISOString()
  const since2h = new Date(asOf.getTime() - 2 * 3_600_000).toISOString()
  const since25h = new Date(asOf.getTime() - 25 * 3_600_000).toISOString()
  await measured(metrics, () => supabase.from('leads').select('id').limit(1))
  const systemActive = await measured(metrics, () => supabase.from('settings').select('value').eq('key', 'system_active').single())
  const lastPipelineRun = await measured(metrics, () => supabase.from('activity_log').select('created_at').eq('event_type', 'finder_complete').order('created_at', { ascending: false }).limit(1).maybeSingle())
  const outscraperError = await measured(metrics, () => supabase.from('activity_log').select('id').gte('created_at', since24h).or('description.ilike.%402%,description.ilike.%quota exhausted%,description.ilike.%balance%').limit(1))
  const bounceCount = await measured(metrics, () => supabase.from('emails').select('id', { count: 'exact', head: true }).eq('status', 'bounced').gte('sent_at', since24h))
  const costGuard = await measured(metrics, () => supabase.from('activity_log').select('created_at, metadata').eq('event_type', 'cost_guard_triggered').gte('created_at', since2h).order('created_at', { ascending: false }).limit(1).maybeSingle())
  const agentErrors = await measured(metrics, () => supabase.from('activity_log').select('description, metadata, created_at').eq('event_type', 'agent_error').gte('created_at', since25h).order('created_at', { ascending: false }).limit(5))
  const deadLetterCount = await measured(metrics, () => supabase.from('dead_letter_queue').select('id', { count: 'exact', head: true }).eq('resolved', false).gte('created_at', since24h))
  return {
    metrics,
    values: {
      system_active: systemActive.data?.value ?? null,
      last_pipeline_run: lastPipelineRun.data?.created_at ?? null,
      outscraper_error: (outscraperError.data?.length ?? 0) > 0,
      bounce_count: bounceCount.count ?? 0,
      cost_guard: costGuard.data ?? null,
      agent_errors: agentErrors.data ?? [],
      dead_letter_count: deadLetterCount.count ?? 0,
    },
  }
}

function collectMismatches(expected: unknown, actual: unknown, path = 'health'): string[] {
  if (Object.is(expected, actual)) return []
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const mismatches: string[] = []
    if (expected.length !== actual.length) mismatches.push(`${path}.length: legacy=${expected.length} rpc=${actual.length}`)
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      mismatches.push(...collectMismatches(expected[index], actual[index], `${path}[${index}]`))
    }
    return mismatches
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const expectedRecord = expected as Record<string, unknown>
    const actualRecord = actual as Record<string, unknown>
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])
    return [...keys].flatMap((key) => collectMismatches(expectedRecord[key], actualRecord[key], `${path}.${key}`))
  }
  return [`${path}: legacy=${JSON.stringify(expected)} rpc=${JSON.stringify(actual)}`]
}

async function checkHealthRpc(legacy: Awaited<ReturnType<typeof measureLegacyHealth>>) {
  const metrics = blank()
  let result
  try {
    result = await measured(metrics, () => supabase.rpc('get_health_summary', { p_as_of: asOf.toISOString() }))
  } catch (error) {
    throw new Error(`Health RPC failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert.equal(metrics.requests, 1, 'Health RPC must use exactly one request')
  const mismatches = collectMismatches(legacy.values, result.data)
  return {
    status: mismatches.length === 0 ? 'PASS' : 'FAIL',
    requests: metrics.requests,
    durationMs: metrics.durationMs,
    rows: result.data == null ? 0 : 1,
    bytes: metrics.bytes,
    legacy: legacy.values,
    rpc: result.data,
    mismatches,
  }
}

async function staticContracts() {
  const paths = {
    lifecycle: 'src/app/api/lifecycle/route.ts', pipelinePage: 'src/app/dashboard/pipeline/page.tsx', pipelineApi: 'src/app/api/pipeline/route.ts',
    pipelineUi: 'src/components/pipeline/KanbanBoard.tsx', emailApi: 'src/app/api/email-log/route.ts', health: 'src/app/api/health/route.ts', auth: 'src/lib/auth.ts', migration: 'supabase/migrations/040_lifecycle_navigation_queries.sql',
  }
  const files = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])))
  assert(!files.pipelinePage.includes("select('*')") && !files.pipelinePage.includes('limit(2000)'))
  assert(files.pipelineApi.includes("page_size") && files.pipelineApi.includes("{ count: 'exact' }") && files.pipelineApi.includes(".order('id'"))
  assert(files.pipelineUi.includes('mutations.current.has') && files.pipelineUi.includes('mutatingLeadIds.has') && files.pipelineUi.includes('Promise.all([loadColumn(source), loadColumn(destination)])'))
  const moveCard = files.pipelineUi.slice(files.pipelineUi.indexOf('async function moveCard'))
  const responseCheckIndex = moveCard.indexOf('if (!response.ok)')
  const cleanupIndex = moveCard.indexOf('cleanupMutation(leadId)', responseCheckIndex)
  const refreshIndex = moveCard.indexOf('await Promise.all([loadColumn(source), loadColumn(destination)])')
  assert(responseCheckIndex >= 0 && cleanupIndex > responseCheckIndex && refreshIndex > cleanupIndex, 'Pipeline mutation cleanup must run after PATCH success and before column refreshes')
  assert(!files.emailApi.includes('getDashboardMetrics') && !files.emailApi.includes('body_html') && !files.emailApi.includes('body_text') && !files.emailApi.includes('limit(500)'))
  assert(files.emailApi.includes('p_search: search'), 'Email Log API does not pass normalized search to its summary')
  assert.equal((files.health.match(/\.rpc\(/g) ?? []).length, 1)
  assert.equal((files.health.match(/\.from\(/g) ?? []).length, 0)
  assert(files.auth.includes('export const getAuthContext = cache('))
  assert(files.migration.includes('SECURITY INVOKER') && files.migration.includes('SET search_path = pg_catalog') && files.migration.includes('REVOKE ALL') && files.migration.includes('GRANT EXECUTE'))
  assert(files.migration.includes('get_email_log_summary(TEXT, TEXT, TEXT)') && files.migration.includes("emails.subject ILIKE '%' || validated.search_term || '%'"))
  assert(files.migration.includes("COALESCE((SUBSTRING(settings_raw.dead_after_react FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS dead_after_react"))
  const classifiedSql = files.migration.slice(files.migration.indexOf('classified AS'), files.migration.indexOf('counts AS'))
  const assertReactivationPrecedesMissingInitial = (reactivationBranch: string, missingInitialBranch: string) => {
    const reactivationIndex = classifiedSql.indexOf(reactivationBranch)
    const missingInitialIndex = classifiedSql.indexOf(missingInitialBranch)
    assert(reactivationIndex >= 0 && missingInitialIndex >= 0 && reactivationIndex < missingInitialIndex)
  }
  assertReactivationPrecedesMissingInitial("WHEN facts.reactivation_sent_at IS NOT NULL THEN 'Mark Dead'", "WHEN facts.initial_sent_at IS NULL THEN 'None'")
  assertReactivationPrecedesMissingInitial('WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.reactivation_sent_at + pg_catalog.make_interval(days => settings_values.dead_after_react)', 'WHEN facts.initial_sent_at IS NULL THEN NULL')
  assertReactivationPrecedesMissingInitial('WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.days_since_reactivation >= settings_values.dead_after_react', 'WHEN facts.initial_sent_at IS NULL THEN FALSE')
}

async function checkLifecycleRpc(legacyCounts: ReturnType<typeof lifecycleCounts>) {
  const started = performance.now()
  const { data, error } = await supabase.rpc('get_lifecycle_page', { p_as_of: asOf.toISOString(), p_filter: 'all', p_search: '', p_sort_key: 'next_action_date', p_sort_dir: 'asc', p_page: 1, p_page_size: 50 })
  if (error?.message.includes('Could not find the function') || error?.message.includes('schema cache')) return { status: 'PENDING', reason: error.message }
  if (error) throw error
  assert((data.data ?? []).length <= 50, 'Lifecycle initial page exceeded 50 records')
  assert.deepEqual(data.counts, legacyCounts, 'Lifecycle stage counts differ')
  const ids = new Set<string>()
  const total = Number(data.total)
  for (let page = 1; ids.size < total; page++) {
    const result = await supabase.rpc('get_lifecycle_page', { p_as_of: asOf.toISOString(), p_filter: 'all', p_search: '', p_sort_key: 'next_action_date', p_sort_dir: 'asc', p_page: page, p_page_size: 100 })
    if (result.error) throw result.error
    for (const row of result.data.data ?? []) assert(!ids.has(row.id) && ids.add(row.id), 'Lifecycle pagination duplicated an id')
  }
  assert.equal(ids.size, total, 'Lifecycle pagination omitted an id')
  return { status: 'PASS', durationMs: performance.now() - started, rows: data.data.length, bytes: Buffer.byteLength(JSON.stringify(data)) }
}

const lifecycleRpcArguments = {
  p_as_of: FIXED_AS_OF,
  p_filter: 'all',
  p_search: '',
  p_sort_key: 'next_action_date',
  p_sort_dir: 'asc',
  p_page: 1,
  p_page_size: 50,
}

async function callLifecycleBenchmarkRpc(expectedCounts: ReturnType<typeof lifecycleCounts>, timed = true) {
  const started = timed ? performance.now() : null
  const { data, error } = await supabase.rpc('get_lifecycle_page', lifecycleRpcArguments)
  if (error) throw new Error(`Lifecycle RPC failed: ${error.message}`)
  assert.equal(data?.data?.length, 50, 'Lifecycle benchmark response must contain exactly 50 rows')
  assert.deepEqual(data.counts, expectedCounts, 'Lifecycle benchmark exact counts differ')
  return {
    ...(started === null ? {} : { durationMs: performance.now() - started }),
    rows: data.data.length,
    bytes: Buffer.byteLength(JSON.stringify(data)),
    counts: data.counts,
  }
}

async function benchmarkLifecycleRpc() {
  assert.equal(asOf.toISOString(), FIXED_AS_OF, `Lifecycle benchmark requires fixed asOf ${FIXED_AS_OF}`)
  const legacy = await baselineLifecycle()
  const warmup = await callLifecycleBenchmarkRpc(legacy.counts, false)
  const samples = []
  for (let index = 0; index < 3; index++) samples.push(await callLifecycleBenchmarkRpc(legacy.counts))
  const sortedDurations = samples.map((sample) => sample.durationMs!).sort((left, right) => left - right)
  return {
    status: 'PASS',
    asOf: asOf.toISOString(),
    parameters: lifecycleRpcArguments,
    legacy,
    warmup,
    samples,
    medianMs: sortedDurations[Math.floor(sortedDurations.length / 2)],
  }
}

async function main() {
  if (mode === '--lifecycle-benchmark') {
    console.log(JSON.stringify({ lifecycleBenchmark: await benchmarkLifecycleRpc() }, null, 2))
    return
  }
  if (mode === '--health') {
    assert.equal(asOf.toISOString(), FIXED_AS_OF, `Health verification requires fixed asOf ${FIXED_AS_OF}`)
    const legacyHealth = await measureLegacyHealth()
    const health = await checkHealthRpc(legacyHealth)
    console.log(JSON.stringify({ asOf: asOf.toISOString(), health: { legacyMetrics: legacyHealth.metrics, ...health } }, null, 2))
    if (health.status !== 'PASS') process.exitCode = 1
    return
  }
  assert.equal(mode, '--full', `Unknown mode: ${mode}`)
  verifyReactivationWithoutInitial()
  await staticContracts()
  const lifecycle = await baselineLifecycle()
  const [pipeline, emailLog, legacyHealth] = await Promise.all([verifyPipeline(), verifyEmailLog(), measureLegacyHealth()])
  const lifecycleRpc = await checkLifecycleRpc(lifecycle.counts)
  const health = await checkHealthRpc(legacyHealth)
  console.log(JSON.stringify({ asOf: asOf.toISOString(), staticContracts: 'PASS', lifecycle: { baseline: lifecycle, optimizedRpc: lifecycleRpc }, pipeline, emailLog, health: { legacyMetrics: legacyHealth.metrics, ...health } }, null, 2))
  if (health.status !== 'PASS') process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
