import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { resolvePagination, toSupabaseRange } from '../src/lib/pagination'

const ROOT = process.cwd()
const DATABASE_URL = process.env.V2_LOCAL_DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const databaseHost = new URL(DATABASE_URL).hostname
assert(databaseHost === '127.0.0.1' || databaseHost === 'localhost', 'performance tests refuse non-local Postgres')

function source(path: string): string {
  return readFileSync(`${ROOT}/${path}`, 'utf8')
}

function assertWorkspaceScopedRoute(path: string, rpc: string) {
  const text = source(path)
  assert(text.includes('requireApiWorkspaceUser()'), `${path} must resolve workspace server-side`)
  assert(text.includes(`rpc('${rpc}'`), `${path} must use ${rpc}`)
  assert(text.includes('p_workspace_id: workspace.workspaceId'), `${path} must pass only server-resolved workspace scope`)
  assert(!text.includes("select('*')"), `${path} must not add a heavy select('*') list read`)
}

async function main() {
  const fallback = resolvePagination({ page: '-5', pageSize: 'not-a-number' })
  assert.deepEqual(fallback, { page: 1, pageSize: 50 }, 'invalid pagination must fall back safely')
  assert.equal(resolvePagination({ page: '2', pageSize: '100000' }).pageSize, 100, 'page size maximum must be enforced')
  assert.deepEqual(toSupabaseRange({ page: 2, pageSize: 50 }), { from: 50, to: 99 })

  assertWorkspaceScopedRoute('src/app/api/leads/route.ts', 'get_leads_search_page')
  assertWorkspaceScopedRoute('src/app/api/lifecycle/route.ts', 'get_lifecycle_page')
  assertWorkspaceScopedRoute('src/app/api/pipeline/route.ts', 'get_pipeline_search_page')
  assertWorkspaceScopedRoute('src/app/api/deals/route.ts', 'get_deals_search_page')
  assertWorkspaceScopedRoute('src/app/api/dm-queue/route.ts', 'get_dm_queue_search_page')
  assertWorkspaceScopedRoute('src/app/api/email-log/route.ts', 'get_email_log_search_page')
  assertWorkspaceScopedRoute('src/app/api/delivery-failures/route.ts', 'get_delivery_failure_report')

  const leadsRoute = source('src/app/api/leads/route.ts')
  assert(leadsRoute.includes('p_search: search'), 'lead search must execute in the database')
  assert(leadsRoute.includes('p_statuses: statuses'), 'lead status filter must execute in the database')
  assert(leadsRoute.includes('p_category: category'), 'lead category filter must execute in the database')
  assert(leadsRoute.includes('p_city: city'), 'lead city filter must execute in the database')

  const emailRoute = source('src/app/api/email-log/route.ts')
  assert.equal((emailRoute.match(/\.rpc\(/g) ?? []).length, 1, 'email log must use one combined list/summary RPC')

  const auditRoute = source('src/app/api/admin/audit/route.ts')
  assert(auditRoute.includes('limit > 100') && auditRoute.includes('cursor'), 'audit pagination must remain keyset-bounded')

  const adminDirectory = source('src/app/dashboard/admin/workspaces/page.tsx')
  assert(adminDirectory.includes('adminListWorkspaceDirectoryPage'), 'admin workspace directory must be server-paged')

  const migration = source('supabase-v2/migrations/00000000000018_performance_optimisation.sql')
  assert(!migration.includes('CREATE OR REPLACE FUNCTION public.get_dashboard_summary'), 'dashboard hotfix must remain unchanged')
  assert(!migration.includes('workspace_usage_counters') && !migration.includes('stripe_webhook_events'), 'SaaS 6/7 authority must remain unchanged')
  assert(!migration.includes('CREATE POLICY') && !migration.includes('ALTER TABLE public.audit_events'), 'SaaS 8 RLS and append-only controls must remain unchanged')
  for (const index of [
    'leads_workspace_status_created_at_idx',
    'emails_workspace_created_at_id_idx',
    'emails_workspace_type_created_at_id_idx',
    'deals_workspace_closed_at_idx',
    'dm_queue_workspace_status_created_at_idx',
    'activity_log_workspace_delivery_email_created_at_idx',
  ]) assert(migration.includes(index), `migration must declare ${index}`)

  const benchmarkSource = source('scripts/benchmark-v2-performance.ts')
  for (const forbidden of ['resend.emails.send', 'runFinder', 'generateContent', 'openai.']) {
    assert(!benchmarkSource.includes(forbidden), `performance benchmark must not call ${forbidden}`)
  }

  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    const indexResult = await client.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
    `, [[
      'leads_workspace_status_created_at_idx',
      'emails_workspace_created_at_id_idx',
      'emails_workspace_type_created_at_id_idx',
      'deals_workspace_closed_at_idx',
      'dm_queue_workspace_status_created_at_idx',
      'activity_log_workspace_delivery_email_created_at_idx',
    ]])
    assert.equal(indexResult.rowCount, 6, 'all expected performance indexes must exist locally')

    const privileges = await client.query<{ legacy: boolean; scoped: boolean }>(`
      SELECT
        has_function_privilege('authenticated', 'public.get_leads_search_page(text[],text,text,text,integer,integer,boolean)', 'EXECUTE') AS legacy,
        has_function_privilege('authenticated', 'public.get_leads_search_page(uuid,text[],text,text,text,integer,integer,boolean)', 'EXECUTE') AS scoped
    `)
    assert.equal(privileges.rows[0].legacy, false, 'authenticated must not execute unscoped list RPC')
    assert.equal(privileges.rows[0].scoped, true, 'authenticated must execute workspace-scoped list RPC')

    const firstWorkspace = '00000000-0000-0000-0000-000000000001'
    const secondWorkspace = 'aaaaaaaa-0000-0000-0000-000000000002'
    const [first, second] = await Promise.all([
      client.query<{ result: { data: Array<{ id: string }> } }>(
        `SELECT public.get_leads_search_page($1::uuid, NULL, NULL, NULL, '', 1, 100, true) AS result`,
        [firstWorkspace],
      ),
      client.query<{ result: { data: Array<{ id: string }> } }>(
        `SELECT public.get_leads_search_page($1::uuid, NULL, NULL, NULL, '', 1, 100, true) AS result`,
        [secondWorkspace],
      ),
    ])
    const overlap = new Set(first.rows[0].result.data.map((row) => row.id))
    assert(second.rows[0].result.data.every((row) => !overlap.has(row.id)), 'workspace list results must not overlap')
  } finally {
    await client.end()
  }

  console.log('V2 SaaS 9A performance tests passed (bounded lists, workspace scope, indexes, and side-effect safety)')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
