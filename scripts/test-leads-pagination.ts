import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createLeadsFilterSearchParams,
  createLeadsFilterSnapshot,
  createUniqueIdBatches,
  FILTERED_IDS_PAGE_SIZE,
  LEADS_LIST_FIELDS,
  LEADS_LIST_PROJECTION,
  LEADS_MAX_PAGE_SIZE,
  LEADS_PAGE_SIZE,
  normalizeLeadsSearch,
  REGENERATION_BATCH_SIZE,
} from '../src/lib/leads-list'
import { resolvePagination, toSupabaseRange } from '../src/lib/pagination'

type Filters = {
  category?: string
  city?: string
  search?: string
  stage?: 'negotiating' | 'closed'
  status?: string
}

const STAGE_STATUSES = {
  negotiating: ['negotiating', 'interested'],
  closed: ['closed', 'closed_won', 'closed_manual'],
} as const

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function applyFilters(query: any, filters: Filters): any {
  if (filters.stage) query = query.in('status', [...STAGE_STATUSES[filters.stage]])
  else if (filters.status) query = query.eq('status', filters.status)
  if (filters.category) query = query.eq('category_name', filters.category)
  if (filters.city) query = query.eq('city', filters.city)
  if (filters.search) query = query.ilike('business_name', `%${filters.search}%`)
  return query
}

async function readPage(
  supabase: SupabaseClient,
  projection: string,
  filters: Filters,
  page: number,
) {
  const pagination = resolvePagination(
    { page, pageSize: LEADS_PAGE_SIZE },
    { defaultPageSize: LEADS_PAGE_SIZE, maxPageSize: LEADS_MAX_PAGE_SIZE },
  )
  const { from, to } = toSupabaseRange(pagination)
  let query = applyFilters(supabase.from('leads').select(projection, { count: 'exact' }), filters)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })

  const startedAt = performance.now()
  const { data, error, count } = await query.range(from, to)
  const durationMs = performance.now() - startedAt
  if (error) throw error
  return { data: data ?? [], count: count ?? 0, durationMs, pagination }
}

async function verifyIdPagination(supabase: SupabaseClient, filters: Filters) {
  const ids: string[] = []
  let page = 1
  let total = Number.POSITIVE_INFINITY
  let requests = 0

  while (ids.length < total) {
    const pagination = resolvePagination(
      { page, pageSize: FILTERED_IDS_PAGE_SIZE },
      { defaultPageSize: FILTERED_IDS_PAGE_SIZE, maxPageSize: FILTERED_IDS_PAGE_SIZE },
    )
    const { from, to } = toSupabaseRange(pagination)
    let query = applyFilters(supabase.from('leads').select('id', { count: 'exact' }), filters)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
    const { data, error, count } = await query.range(from, to)
    requests += 1
    if (error) throw error
    total = count ?? 0
    const pageIds = (data ?? []).map((lead: { id: string }) => lead.id)
    assert(pageIds.length <= FILTERED_IDS_PAGE_SIZE)
    ids.push(...pageIds)
    if (pageIds.length < FILTERED_IDS_PAGE_SIZE) break
    page += 1
  }

  assert.equal(ids.length, total)
  assert.equal(new Set(ids).size, ids.length)
  return { ids, requests, total }
}

async function main() {
  const displayedDebouncedSearch = 'old search'
  const rawSearch = '  example  '
  const tableFilterSnapshot = createLeadsFilterSnapshot({
    rawSearch: normalizeLeadsSearch(rawSearch),
    status: 'email_ready',
    stage: 'closed',
    city: ' Sydney ',
  })
  const regenerationFilterSnapshot = createLeadsFilterSnapshot({
    rawSearch,
    status: 'email_ready',
    stage: 'closed',
    city: ' Sydney ',
  })
  const tableParams = createLeadsFilterSearchParams(tableFilterSnapshot)
  const regenerationParams = createLeadsFilterSearchParams(regenerationFilterSnapshot)
  assert.equal(tableParams.get('search'), 'example', 'table request trims the debounced search')
  assert.equal(regenerationParams.get('search'), 'example', 'regeneration request trims the raw search captured when the dialog opens')
  assert.notEqual(regenerationParams.get('search'), displayedDebouncedSearch, 'regeneration never reuses the displayed debounced search')
  assert.equal(regenerationParams.get('status'), 'email_ready')
  assert.equal(regenerationParams.has('stage'), false, 'an exact status keeps the Leads-list status-over-stage precedence')
  assert.equal(regenerationParams.get('city'), 'Sydney')
  assert.deepEqual(
    Array.from(tableParams.entries()),
    Array.from(regenerationParams.entries()),
    'table and regeneration requests use identical search/status/stage/city parameters',
  )

  const whitespaceTableParams = createLeadsFilterSearchParams(createLeadsFilterSnapshot({
    rawSearch: normalizeLeadsSearch('   '),
  }))
  const whitespaceRegenerationParams = createLeadsFilterSearchParams(createLeadsFilterSnapshot({
    rawSearch: '   ',
  }))
  assert.equal(whitespaceTableParams.has('search'), false, 'table request omits an all-whitespace search')
  assert.equal(whitespaceRegenerationParams.has('search'), false, 'regeneration request omits an all-whitespace search')

  const supabase = createClient(
    requireEnvironment('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const { data: seed, error: seedError } = await supabase
    .from('leads')
    .select('business_name, city, category_name, status')
    .not('business_name', 'is', null)
    .not('city', 'is', null)
    .not('category_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (seedError) throw seedError

  const searchToken = seed.business_name.match(/[A-Za-z0-9]{3,}/)?.[0] ?? seed.business_name.slice(0, 3)
  const cases: Array<{ name: string; filters: Filters; page?: number }> = [
    { name: 'Default first page', filters: {} },
    { name: 'Second page', filters: {}, page: 2 },
    { name: 'Business-name search', filters: { search: searchToken } },
    { name: 'Exact status', filters: { status: seed.status } },
    { name: 'Exact city', filters: { city: seed.city } },
    { name: 'Status + city', filters: { status: seed.status, city: seed.city } },
    { name: 'Negotiating stage', filters: { stage: 'negotiating' } },
    { name: 'Closed stage', filters: { stage: 'closed' } },
    { name: 'API category', filters: { category: seed.category_name } },
    { name: 'Search + filters', filters: { search: searchToken, status: seed.status, city: seed.city } },
  ]

  const results: Array<{ name: string; total: number; rows: number; parity: 'PASS' }> = []
  let optimizedMeasurement: { rows: number; bytes: number; durationMs: number; requests: number } | null = null
  let optimizedFirstPageIds: string[] = []
  let optimizedSecondPageIds: string[] = []

  for (const testCase of cases) {
    const page = testCase.page ?? 1
    const before = await readPage(supabase, '*', testCase.filters, page)
    const after = await readPage(supabase, LEADS_LIST_PROJECTION, testCase.filters, page)
    const beforeIds = before.data.map((lead: any) => lead.id)
    const afterIds = after.data.map((lead: any) => lead.id)

    assert.equal(after.count, before.count, `${testCase.name}: total changed`)
    assert.deepEqual(afterIds, beforeIds, `${testCase.name}: ordered IDs changed`)
    assert(after.data.length <= LEADS_PAGE_SIZE, `${testCase.name}: page exceeds limit`)
    assert(after.data.every((lead: any) => LEADS_LIST_FIELDS.every((field) => Object.hasOwn(lead, field))), `${testCase.name}: required field missing`)

    if (testCase.name === 'Default first page') {
      optimizedFirstPageIds = afterIds
      optimizedMeasurement = {
        rows: after.data.length,
        bytes: Buffer.byteLength(JSON.stringify({ data: after.data, count: after.count, page, limit: LEADS_PAGE_SIZE })),
        durationMs: Number(after.durationMs.toFixed(1)),
        requests: 1,
      }
    } else if (testCase.name === 'Second page') {
      optimizedSecondPageIds = afterIds
    }

    results.push({ name: testCase.name, total: after.count, rows: after.data.length, parity: 'PASS' })
  }

  assert.equal(optimizedFirstPageIds.filter((id) => optimizedSecondPageIds.includes(id)).length, 0, 'Consecutive pages overlap')
  assert.deepEqual(resolvePagination({ page: 'bad', pageSize: '-1' }), { page: 1, pageSize: LEADS_PAGE_SIZE })
  assert.equal(resolvePagination({ pageSize: '500' }).pageSize, LEADS_MAX_PAGE_SIZE)

  const idPagination = await verifyIdPagination(supabase, { category: seed.category_name })
  const batches = createUniqueIdBatches([...idPagination.ids, ...idPagination.ids.slice(0, 5)])
  assert.equal(batches.flat().length, idPagination.ids.length)
  assert(batches.every((batch) => batch.length <= REGENERATION_BATCH_SIZE))

  console.table(results)
  console.log('Optimized measurement:', optimizedMeasurement)
  console.log('ID pagination/batching:', {
    matchingIds: idPagination.total,
    idRequests: idPagination.requests,
    uniqueIds: new Set(idPagination.ids).size,
    regenerationBatches: batches.length,
    maximumBatchSize: Math.max(0, ...batches.map((batch) => batch.length)),
  })
}

main().catch((error) => {
  console.error('Leads pagination verification failed:', error instanceof Error ? error.message : JSON.stringify(error))
  process.exitCode = 1
})
