import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapePostgresLikeTerm, normalizeSearchTerm, SEARCH_DEBOUNCE_MS } from '../src/lib/search'
import { createLeadsFilterSearchParams, createLeadsFilterSnapshot } from '../src/lib/leads-list'

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

function getHandler(path: string): string {
  const text = source(path)
  const start = text.indexOf('export async function GET')
  const nextHandler = text.indexOf('\nexport async function ', start + 1)
  return text.slice(start, nextHandler === -1 ? undefined : nextHandler)
}

assert.equal(SEARCH_DEBOUNCE_MS, 300, 'live server searches use a sensible shared debounce')
assert.equal(normalizeSearchTerm('  vr quest  '), 'vr quest', 'search is trimmed')
assert.equal(normalizeSearchTerm('VR QUEST'), 'VR QUEST', 'normalization does not make query semantics case-sensitive')
assert.equal(normalizeSearchTerm('   '), '', 'empty/whitespace search preserves the normal listing')
assert.equal(normalizeSearchTerm('x'.repeat(250)).length, 200, 'search length is bounded')
assert.throws(() => normalizeSearchTerm('test', -1), /maxLength/)

assert.equal(escapePostgresLikeTerm('50%_off\\today'), '50\\%\\_off\\\\today', 'SQL LIKE wildcards and backslashes are escaped literally')
assert.equal(escapePostgresLikeTerm(`O'Reilly,"sales"@example.com.au`), `O'Reilly,"sales"@example.com.au`, 'quotes, commas, @, and dots remain safe bound-parameter text')

const leadsParams = createLeadsFilterSearchParams(createLeadsFilterSnapshot({
  rawSearch: '  admin@vrquest  ', status: 'contacted', city: ' Sydney ', category: 'Escape Rooms',
}))
assert.equal(leadsParams.get('search'), 'admin@vrquest', 'partial email is sent to the Leads API')
assert.equal(leadsParams.get('status'), 'contacted', 'status remains combined with search')
assert.equal(leadsParams.get('city'), 'Sydney', 'city remains combined with search')
assert.equal(leadsParams.get('category'), 'Escape Rooms', 'category remains combined with search')

const migration = source('supabase/migrations/048_global_search.sql')
assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/, 'focused trigram support is additive')
assert.match(migration, /pg_extension[\s\S]*extnamespace[\s\S]*extname = 'pg_trgm'/, 'trigram operator class uses the installed extension namespace')
assert.doesNotMatch(migration, /extensions\.gin_trgm_ops/, 'trigram indexes do not assume the extension schema')
assert.match(migration, /leads_business_name_trgm_idx[\s\S]*leads_email_trgm_idx/, 'business and email partial search have focused indexes')
assert.match(migration, /emails_subject_trgm_idx/, 'Email Log subject partial search has a focused index')
assert.match(migration, /dm_queue_handle_trgm_idx/, 'DM handle partial search has a focused index')
assert.match(migration, /literal_ilike_pattern[\s\S]*replace[\s\S]*'%'[\s\S]*'_'/, 'one SQL helper escapes literal ILIKE patterns')

const rpcExpectations: Array<[string, RegExp[]]> = [
  ['get_leads_search_page', [/business_name ILIKE/, /leads\.email/, /p_statuses/, /p_category/, /p_city/, /OFFSET/, /LIMIT/]],
  ['get_pipeline_search_page', [/business_name ILIKE/, /leads\.email/, /p_statuses/, /OFFSET/, /LIMIT/]],
  ['get_email_log_search_page', [/emails\.subject ILIKE/, /leads\.business_name/, /leads\.email/, /p_type/, /p_status/, /OFFSET/, /LIMIT/]],
  ['get_deals_search_page', [/business_name/, /joined\.email/, /OFFSET/, /LIMIT/]],
  ['get_dm_queue_search_page', [/business_name/, /dm_queue\.handle ILIKE/, /p_status/, /p_platform/, /p_city/, /OFFSET/, /LIMIT/]],
]
for (const [name, patterns] of rpcExpectations) {
  const start = migration.indexOf(`FUNCTION public.${name}`)
  const end = migration.indexOf('\nCREATE OR REPLACE FUNCTION ', start + 1)
  const body = migration.slice(start, end === -1 ? undefined : end)
  assert.ok(start >= 0, `${name} exists`)
  for (const pattern of patterns) assert.match(body, pattern, `${name} preserves its required fields/filters/pagination`)
  assert.match(body, /literal_ilike_pattern/, `${name} uses literal case-insensitive partial matching`)
}

const routeRpcs: Array<[string, string]> = [
  ['src/app/api/leads/route.ts', 'get_leads_search_page'],
  ['src/app/api/pipeline/route.ts', 'get_pipeline_search_page'],
  ['src/app/api/email-log/route.ts', 'get_email_log_search_page'],
  ['src/app/api/deals/route.ts', 'get_deals_search_page'],
  ['src/app/api/dm-queue/route.ts', 'get_dm_queue_search_page'],
]
for (const [path, rpc] of routeRpcs) {
  const handler = getHandler(path)
  assert.match(handler, new RegExp(rpc), `${path} uses bounded server-side search`)
  assert.doesNotMatch(handler, /\.(?:insert|update|upsert|delete)\s*\(/, `${path} GET introduces no writes`)
}

for (const path of [
  'src/components/leads/LeadsTable.tsx',
  'src/components/lifecycle/LifecycleTable.tsx',
  'src/components/email-log/EmailLogTable.tsx',
  'src/components/deals/DealsTable.tsx',
  'src/components/dm-queue/DMQueueTable.tsx',
  'src/components/pipeline/KanbanBoard.tsx',
]) {
  assert.match(source(path), /Search (?:business|name)/, `${path} advertises supported search fields`)
}

for (const path of [
  'src/components/leads/LeadsTable.tsx',
  'src/components/lifecycle/LifecycleTable.tsx',
  'src/components/email-log/EmailLogTable.tsx',
  'src/components/deals/DealsTable.tsx',
  'src/components/dm-queue/DMQueueTable.tsx',
  'src/components/pipeline/KanbanBoard.tsx',
]) {
  assert.match(source(path), /300|SEARCH_DEBOUNCE_MS/, `${path} debounces live search requests`)
}

const deliveryRoute = source('src/app/api/delivery-failures/route.ts')
const deliverySelectionRoute = source('src/app/api/delivery-failures/lead-selection/route.ts')
assert.match(deliveryRoute, /escapePostgresLikeTerm\(filters\.search\)/, 'Delivery Failures treats wildcard input literally')
assert.match(deliverySelectionRoute, /escapePostgresLikeTerm\(filters\.search\)/, 'bulk selection uses identical Delivery Failure search semantics')

const emailReport = source('src/components/email-report/EmailReportDashboard.tsx')
assert.doesNotMatch(emailReport, /SEARCH_DEBOUNCE_MS/, 'Email Report preserves intentional client-side filtering of the loaded date range')
assert.match(source('src/lib/email-report-ui.ts'), /toLocaleLowerCase\('en-AU'\)[\s\S]*includes\(query\)/, 'Email Report remains case-insensitive and partial-match friendly')

const users = source('src/components/admin/UserManagement.tsx')
assert.match(users, /query\.trim\(\)\.toLowerCase\(\)/, 'Admin Users trims and normalizes its small client-side dataset')
assert.match(users, /user\.email\.toLowerCase\(\)\.includes\(needle\)/, 'Admin Users searches email partially and case-insensitively')
assert.match(users, /full_name[\s\S]*role\.includes\(needle\)/, 'Admin Users searches name and role fields appropriate to profiles')

console.log('Global search tests passed')
