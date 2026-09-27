import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { Client, type QueryResultRow } from 'pg'

const DATABASE_URL = process.env.V2_LOCAL_DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const parsedDatabaseUrl = new URL(DATABASE_URL)
assert(
  parsedDatabaseUrl.hostname === '127.0.0.1' || parsedDatabaseUrl.hostname === 'localhost',
  'benchmark refuses non-local Postgres',
)

const PRIMARY_WORKSPACE = '00000000-0000-0000-0000-000000000001'
const DECOY_WORKSPACE = 'aaaaaaaa-0000-0000-0000-000000000002'
const FIXTURE_PREFIX = 'V2_PERF_FIXTURE_'
const PRIMARY_LEADS = 6_000
const DECOY_LEADS = 2_000

interface PlanNode {
  'Node Type': string
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Index Name'?: string
  Plans?: PlanNode[]
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function percent(before: number, after: number): number | null {
  return before > 0 ? round(((before - after) / before) * 100) : null
}

async function medianTimed<T extends QueryResultRow>(client: Client, text: string, values: unknown[] = []) {
  const durations: number[] = []
  let rows: T[] = []
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now()
    const result = await client.query<T>(text, values)
    durations.push(performance.now() - started)
    rows = result.rows
  }
  durations.sort((a, b) => a - b)
  return {
    durationMs: round(durations[1]),
    rows,
    bytes: Buffer.byteLength(JSON.stringify(rows)),
  }
}

function summarizePlan(node: PlanNode): { rowsScanned: number; indexes: string[]; scans: string[] } {
  let rowsScanned = 0
  const indexes = new Set<string>()
  const scans = new Set<string>()
  function visit(current: PlanNode) {
    if (current['Node Type'].includes('Scan')) {
      rowsScanned += (current['Actual Rows'] ?? 0) * (current['Actual Loops'] ?? 1)
      scans.add(current['Node Type'])
    }
    if (current['Index Name']) indexes.add(current['Index Name'])
    for (const child of current.Plans ?? []) visit(child)
  }
  visit(node)
  return { rowsScanned, indexes: [...indexes].sort(), scans: [...scans].sort() }
}

async function explain(client: Client, text: string, values: unknown[] = []) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values)
  const document = result.rows[0]['QUERY PLAN'][0] as { Plan: PlanNode; 'Execution Time': number }
  return { durationMs: round(document['Execution Time']), ...summarizePlan(document.Plan) }
}

async function seed(client: Client) {
  await client.query(`
    INSERT INTO public.leads (
      workspace_id, business_name, email, city, suburb, category_name,
      phone, status, source, created_at
    )
    SELECT $1::uuid,
      $2 || lpad(n::text, 5, '0'),
      'perf-' || n || '@fixture-' || (n % 500) || '.example',
      CASE WHEN n % 2 = 0 THEN 'Sydney' ELSE 'Melbourne' END,
      'Suburb ' || (n % 80), 'Category ' || (n % 12),
      '0400' || lpad(n::text, 6, '0'),
      CASE WHEN n <= 4500 THEN 'contacted' WHEN n % 2 = 0 THEN 'new' ELSE 'researched' END,
      'manual', now() - (n || ' seconds')::interval
    FROM generate_series(1, $3::integer) AS series(n)
  `, [PRIMARY_WORKSPACE, FIXTURE_PREFIX, PRIMARY_LEADS])

  await client.query(`
    INSERT INTO public.leads (
      workspace_id, business_name, email, city, suburb, category_name,
      phone, status, source, created_at
    )
    SELECT $1::uuid,
      $2 || 'DECOY_' || lpad(n::text, 5, '0'),
      'decoy-' || n || '@fixture.example', 'Perth', 'Decoy', 'Decoy',
      '0500' || lpad(n::text, 6, '0'), 'contacted', 'manual',
      now() - (n || ' seconds')::interval
    FROM generate_series(1, $3::integer) AS series(n)
  `, [DECOY_WORKSPACE, FIXTURE_PREFIX, DECOY_LEADS])

  await client.query(`
    INSERT INTO public.emails (
      workspace_id, lead_id, type, subject, body_text, body_html, status, sent_at, created_at
    )
    SELECT workspace_id, id, 'initial_pitch', 'Fixture initial',
      repeat('Fixture body ', 20), repeat('<p>Fixture body</p>', 20),
      CASE WHEN row_number() OVER (ORDER BY created_at) % 20 = 0 THEN 'bounced' ELSE 'sent' END,
      created_at, created_at
    FROM public.leads
    WHERE business_name LIKE $1 AND status = 'contacted'
  `, [`${FIXTURE_PREFIX}%`])

  await client.query(`
    INSERT INTO public.emails (
      workspace_id, lead_id, type, subject, body_text, body_html, status, sent_at, created_at
    )
    SELECT workspace_id, id, 'follow_up_1', 'Fixture follow-up',
      repeat('Fixture follow-up body ', 20), repeat('<p>Fixture follow-up body</p>', 20),
      'sent', created_at + interval '7 days', created_at + interval '7 days'
    FROM public.leads
    WHERE workspace_id = $1 AND business_name LIKE $2 AND status = 'contacted'
      AND right(business_name, 1)::integer % 2 = 0
  `, [PRIMARY_WORKSPACE, `${FIXTURE_PREFIX}%`])

  await client.query(`
    INSERT INTO public.dm_queue (workspace_id, lead_id, platform, handle, message_text, status, created_at)
    SELECT workspace_id, id, CASE WHEN row_number() OVER () % 2 = 0 THEN 'instagram' ELSE 'facebook' END,
      '@perf_' || row_number() OVER (), repeat('Fixture DM ', 25),
      CASE WHEN row_number() OVER () % 3 = 0 THEN 'sent' ELSE 'pending' END, created_at
    FROM public.leads WHERE workspace_id = $1 AND business_name LIKE $2 LIMIT 1500
  `, [PRIMARY_WORKSPACE, `${FIXTURE_PREFIX}%`])

  await client.query(`
    INSERT INTO public.deals (workspace_id, lead_id, deal_value, deal_type, notes, closed_at, created_at)
    SELECT workspace_id, id, 500 + row_number() OVER (), 'remote_sponsored',
      repeat('Fixture deal note ', 10), created_at, created_at
    FROM public.leads WHERE workspace_id = $1 AND business_name LIKE $2 LIMIT 500
  `, [PRIMARY_WORKSPACE, `${FIXTURE_PREFIX}%`])

  await client.query(`
    INSERT INTO public.activity_log (workspace_id, event_type, description, metadata, created_at)
    SELECT $1::uuid, 'finder_complete', 'Fixture finder run',
      jsonb_build_object('outscraper_calls', n % 10), now() - (n || ' minutes')::interval
    FROM generate_series(1, 3000) AS series(n)
  `, [PRIMARY_WORKSPACE])

  await client.query(`
    INSERT INTO public.workspaces (id, name, slug, status)
    SELECT ('10000000-0000-0000-' || lpad(to_hex(n), 4, '0') || '-000000000000')::uuid,
      $1 || ' Workspace ' || n, 'perf-workspace-' || n, 'active'
    FROM generate_series(1, 400) AS series(n)
  `, [FIXTURE_PREFIX])

  await client.query('ANALYZE public.leads; ANALYZE public.emails; ANALYZE public.dm_queue; ANALYZE public.deals; ANALYZE public.activity_log; ANALYZE public.workspaces')
}

async function benchmark(client: Client) {
  const legacyLeads = await medianTimed(client,
    `SELECT public.get_leads_search_page(NULL, NULL, NULL, '', 1, 50, false)`)
  const scopedLeads = await medianTimed(client,
    `SELECT public.get_leads_search_page($1::uuid, NULL, NULL, NULL, '', 1, 50, false)`,
    [PRIMARY_WORKSPACE])

  const legacyPipeline = await medianTimed(client,
    `SELECT public.get_pipeline_search_page(ARRAY['contacted'], '', 1, 50)`)
  const scopedPipeline = await medianTimed(client,
    `SELECT public.get_pipeline_search_page($1::uuid, ARRAY['contacted'], '', 1, 50)`,
    [PRIMARY_WORKSPACE])

  const legacyEmail = await medianTimed(client, `
    SELECT public.get_email_log_search_page(NULL, NULL, '', 1, 50) AS page,
      public.get_email_log_summary(NULL, NULL, '') AS summary
  `)
  const scopedEmail = await medianTimed(client,
    `SELECT public.get_email_log_search_page($1::uuid, NULL, NULL, '', 1, 50)`,
    [PRIMARY_WORKSPACE])

  const legacyLifecycle = await medianTimed(client,
    `SELECT public.get_lifecycle_page('2026-09-15T00:00:00Z', 'all', '', 'next_action_date', 'asc', 1, 50)`)
  const scopedLifecycle = await medianTimed(client,
    `SELECT public.get_lifecycle_page($1::uuid, '2026-09-15T00:00:00Z', 'all', '', 'next_action_date', 'asc', 1, 50)`,
    [PRIMARY_WORKSPACE])

  const legacyDirectory = await medianTimed(client, `
    SELECT w.id,
      (SELECT count(*) FROM public.workspace_members m WHERE m.workspace_id = w.id AND m.status = 'active'),
      (SELECT count(*) FROM public.leads l WHERE l.workspace_id = w.id),
      (SELECT count(*) FROM public.mailbox_connections mc WHERE mc.workspace_id = w.id AND mc.status <> 'disconnected')
    FROM public.workspaces w ORDER BY w.created_at, w.id
  `)
  await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
  const pagedDirectory = await medianTimed(client,
    `SELECT public.admin_list_workspace_directory_page('', 1, 50)`)

  const listPlan = await explain(client, `
    SELECT id, business_name, category_name, city, suburb, status, created_at
    FROM public.leads
    WHERE workspace_id = $1 AND status = 'contacted'
    ORDER BY created_at DESC, id ASC LIMIT 50
  `, [PRIMARY_WORKSPACE])
  const emailPlan = await explain(client, `
    SELECT id, type, subject, status, sent_at, replied_at, created_at
    FROM public.emails
    WHERE workspace_id = $1 AND type = 'follow_up_1'
    ORDER BY created_at DESC, id ASC LIMIT 50
  `, [PRIMARY_WORKSPACE])
  const dmPlan = await explain(client, `
    SELECT id, platform, handle, status, created_at
    FROM public.dm_queue
    WHERE workspace_id = $1 AND status = 'pending'
    ORDER BY created_at DESC, id ASC LIMIT 50
  `, [PRIMARY_WORKSPACE])

  const comparison = (before: typeof legacyLeads, after: typeof scopedLeads) => ({
    before_ms: before.durationMs,
    after_ms: after.durationMs,
    change_percent: percent(before.durationMs, after.durationMs),
    before_payload_bytes: before.bytes,
    after_payload_bytes: after.bytes,
  })

  return {
    methodology: {
      database: 'isolated local V2',
      fixture: { primary_leads: PRIMARY_LEADS, decoy_workspace_leads: DECOY_LEADS, activity_rows: 3000, synthetic_workspaces: 400 },
      timing: 'median of three warm database calls; transaction rolled back after benchmark',
      caveat: 'database timings do not claim browser-render improvements',
    },
    comparisons: {
      leads_page: { ...comparison(legacyLeads, scopedLeads), before_calls: 1, after_calls: 1, rows_returned: 50 },
      pipeline_page: { ...comparison(legacyPipeline, scopedPipeline), before_calls: 1, after_calls: 1, rows_returned: 50 },
      email_log: { ...comparison(legacyEmail, scopedEmail), before_calls: 2, after_calls: 1, rows_returned: 50 },
      lifecycle_page: { ...comparison(legacyLifecycle, scopedLifecycle), before_calls: 1, after_calls: 1, rows_returned: 50 },
      admin_workspace_directory: { ...comparison(legacyDirectory, pagedDirectory), before_rows: legacyDirectory.rows.length, after_page_size: 50 },
    },
    plans: {
      leads_status_page: listPlan,
      email_type_page: emailPlan,
      dm_status_page: dmPlan,
    },
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  await client.query('BEGIN')
  try {
    await seed(client)
    console.log(JSON.stringify(await benchmark(client), null, 2))
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
