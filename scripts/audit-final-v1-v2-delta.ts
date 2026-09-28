import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'

const ROOT = resolve(import.meta.dirname, '..')
const V1_REF = 'obppfnujusqiwjhwzosv'
const V2_REF = 'ojrxfjlgjhzhdpnkyboa'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PAGE = 1000
const DEFAULT_PLAN_PATH = resolve(ROOT, 'artifacts', 'final-v1-v2-sync-plan.json')
const TERMINAL_INBOUND_STATUSES = new Set(['processed', 'ignored', 'unmatched', 'unmatched_ambiguous', 'failed'])
const PHASE1_BASELINE = {
  effective_emails: 11842,
  skipped_email_drafts: 267,
  safe_inbound_receipts: 192,
  safe_activity_log: 3,
  email_max_created_at: '2026-09-24T22:07:48.999Z',
  activity_max_created_at: '2026-09-27T04:37:16.999Z',
} as const
const PHASE1_DEFERRED_LEAD_IDS = [
  '301ae5f8-7950-4cf1-a5c6-b4c1da7bbfa8',
  'd8a11683-6036-4166-a9f3-c4ecabce86b4',
].sort()
const PHASE1_OWNERSHIP_TARGET_OWNER_IDS = new Set([
  '5c4a6b00-0000-4000-8000-00000000c003',
  'b0e00000-0000-4000-8000-000000000101',
])
const PLAN_SCHEMA_VERSION = 2
const ADVISORY_LOCK_NAME = 'reachagent:final-v1-v2-sync:v1'

type Row = Record<string, unknown>
type Classification =
  | 'INSERT_SAFE'
  | 'UPDATE_SAFE'
  | 'NO_CHANGE'
  | 'EXPECTED_DEDUP'
  | 'V2_ONLY'
  | 'CONFLICT'
  | 'MANUAL_REVIEW'
  | 'DO_NOT_MIGRATE'

interface TableSpec {
  name: string
  columns: string[]
  key: (row: Row) => string
  naturalKeys?: ((row: Row) => string | null)[]
  foreignKeys?: { column: string; parent: string }[]
  timestamps?: string[]
  disposition?: 'SYNC' | 'DERIVED' | 'GENERATED' | 'AUDIT' | 'OBSOLETE'
  mismatchClassification?: Classification
}

type CliMode = 'audit' | 'plan' | 'execute-plan'

interface Cli {
  mode: CliMode
  path: string
  confirmSha256?: string
}

function cli(): Cli {
  const args = process.argv.slice(2)
  const executeIndex = args.indexOf('--execute-plan')
  if (executeIndex >= 0) {
    const path = args[executeIndex + 1]
    const confirmIndex = args.indexOf('--confirm-plan-sha256')
    if (!path || path.startsWith('--')) throw new Error('--execute-plan requires a plan artifact path')
    if (confirmIndex < 0 || !args[confirmIndex + 1]) throw new Error('--execute-plan requires --confirm-plan-sha256 <sha256>')
    return { mode: 'execute-plan', path: resolve(ROOT, path), confirmSha256: args[confirmIndex + 1] }
  }
  if (args.includes('--plan')) {
    const outIndex = args.indexOf('--out')
    const path = outIndex >= 0 ? args[outIndex + 1] : undefined
    if (outIndex >= 0 && (!path || path.startsWith('--'))) throw new Error('--out requires a path')
    return { mode: 'plan', path: path ? resolve(ROOT, path) : DEFAULT_PLAN_PATH }
  }
  return { mode: 'audit', path: DEFAULT_PLAN_PATH }
}

function parseEnv(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const split = line.indexOf('=')
    if (split < 1) continue
    let value = line.slice(split + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[line.slice(0, split).trim()] = value
  }
  return values
}

function hostRef(url: string): string | null {
  try {
    const match = new URL(url).hostname.match(/^([a-z]+)\.supabase\.co$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function jwtIdentity(key: string): { ref?: string; role?: string } {
  try {
    const payload = key.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { ref?: string; role?: string }
  } catch {
    return {}
  }
}

function identityGuard(label: string, url: string, key: string, expected: string, corroboratingRefs: string[] = []): void {
  const fromHost = hostRef(url)
  const jwt = jwtIdentity(key)
  if (fromHost !== expected) throw new Error(`${label} host identity is not expected project ${expected}`)
  if (jwt.ref) {
    if (jwt.ref !== expected || jwt.role !== 'service_role') throw new Error(`${label} credential identity or role cannot be proven`)
  } else if (!key.startsWith('sb_secret_') || corroboratingRefs.length < 2 || corroboratingRefs.some(ref => ref !== expected)) {
    throw new Error(`${label} opaque credential identity cannot be corroborated`)
  }
}

function refFromDbUrl(value: string): string | null {
  // Hosted direct URLs contain db.<ref>.supabase.co; pooler URLs carry postgres.<ref> as the username.
  const host = value.match(/@db\.([a-z]+)\.supabase\.co(?::|\/|$)/)?.[1]
  const user = value.match(/(?:^|\/)postgres\.([a-z]+):/)?.[1]
  return host ?? user ?? null
}

const readOnlyFetch: typeof fetch = async (input, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') throw new Error(`READ_ONLY_GUARD blocked HTTP ${method}`)
  const timeout = AbortSignal.timeout(15_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}

function makeClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: readOnlyFetch },
  })
}

const specs: TableSpec[] = [
  { name: 'categories', columns: ['id','name','halal_filter','cities','custom_cities','content_type','pitch_template','dm_template','search_keywords','status','created_at','updated_at','use_priority_suburbs','city_content_types'], key: r => String(r.id), naturalKeys: [r => String(r.name).trim().toLowerCase()], timestamps: ['created_at','updated_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'city_suburbs', columns: ['id','city','suburb','active','created_at','last_used_at','priority'], key: r => String(r.id), timestamps: ['created_at','last_used_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'category_email_templates', columns: ['id','category_id','template_type','subject_template','body_template','created_at','updated_at'], key: r => String(r.id), naturalKeys: [r => `${r.category_id}|${r.template_type}`], foreignKeys: [{ column: 'category_id', parent: 'categories' }], timestamps: ['created_at','updated_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'category_suburb_priorities', columns: ['id','category_id','city_suburb_id','priority','created_at','updated_at'], key: r => String(r.id), naturalKeys: [r => `${r.category_id}|${r.city_suburb_id}`], foreignKeys: [{ column: 'category_id', parent: 'categories' },{ column: 'city_suburb_id', parent: 'city_suburbs' }], timestamps: ['created_at','updated_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'category_suburb_search_state', columns: ['id','category_id','city_suburb_id','last_searched_at','exhausted_at','created_at','updated_at'], key: r => String(r.id), naturalKeys: [r => `${r.category_id}|${r.city_suburb_id}`], foreignKeys: [{ column: 'category_id', parent: 'categories' },{ column: 'city_suburb_id', parent: 'city_suburbs' }], timestamps: ['created_at','updated_at','last_searched_at','exhausted_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'leads', columns: ['id','business_name','category_id','category_name','halal','address','suburb','city','state','phone','email','website','instagram_handle','facebook_url','google_rating','google_reviews_count','description','services','outreach_channel','status','deal_value','deal_type','content_created','payment_received','notes','created_at','updated_at','halal_confidence_score','halal_reasons','reactivation_sent_at','source','content_type','delivery_suppressed_emails','normalized_email','outreach_suppression_reason','outreach_suppressed_at'], key: r => String(r.id), foreignKeys: [{ column: 'category_id', parent: 'categories' }], timestamps: ['created_at','updated_at','reactivation_sent_at','outreach_suppressed_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'emails', columns: ['id','lead_id','type','subject','body_html','body_text','resend_id','status','sent_at','opened_at','replied_at','created_at','edited_at','edited_by_user','message_id','generation_source'], key: r => String(r.id), naturalKeys: [r => r.resend_id == null ? null : `resend:${r.resend_id}`, r => ['pending_send','sending','sent','delivery_uncertain','email_sync_failed'].includes(String(r.status)) ? `phase:${r.lead_id}|${r.type}` : null], foreignKeys: [{ column: 'lead_id', parent: 'leads' }], timestamps: ['created_at','sent_at','opened_at','replied_at','edited_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'follow_ups', columns: ['id','lead_id','follow_up_number','scheduled_at','sent_at','email_id','status','created_at'], key: r => String(r.id), foreignKeys: [{ column: 'lead_id', parent: 'leads' },{ column: 'email_id', parent: 'emails' }], timestamps: ['created_at','scheduled_at','sent_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'deals', columns: ['id','lead_id','deal_value','deal_type','content_created','content_created_at','payment_received','payment_received_at','notes','closed_at','created_at'], key: r => String(r.id), foreignKeys: [{ column: 'lead_id', parent: 'leads' }], timestamps: ['created_at','content_created_at','payment_received_at','closed_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'dm_queue', columns: ['id','lead_id','platform','handle','profile_url','message_text','status','created_at','sent_at'], key: r => String(r.id), foreignKeys: [{ column: 'lead_id', parent: 'leads' }], timestamps: ['created_at','sent_at'], mismatchClassification: 'MANUAL_REVIEW' },
  { name: 'recipient_outreach_ownership', columns: ['normalized_email','owner_lead_id','state','claimed_at','last_activity_at','metadata'], key: r => String(r.normalized_email), naturalKeys: [r => String(r.normalized_email)], foreignKeys: [{ column: 'owner_lead_id', parent: 'leads' }], timestamps: ['claimed_at','last_activity_at'], mismatchClassification: 'CONFLICT' },
  { name: 'activity_log', columns: ['id','event_type','lead_id','description','metadata','created_at'], key: r => String(r.id), naturalKeys: [r => typeof r.metadata === 'object' && r.metadata !== null && 'inbound_receipt_id' in r.metadata ? `inbound:${r.event_type}|${(r.metadata as Row).inbound_receipt_id}` : null], foreignKeys: [{ column: 'lead_id', parent: 'leads' }], timestamps: ['created_at'], mismatchClassification: 'MANUAL_REVIEW' },
  // This operational idempotency ledger was omitted by the rehearsal tool. It is audited now as a Phase 2 candidate.
  { name: 'inbound_receipts', columns: ['id','provider','receipt_key','mailbox_id','folder','uid','provider_message_id','status','payload','outcome','trigger_run_id','processing_run_id','processing_started_at','processed_at','last_error','created_at','updated_at','attempts'], key: r => String(r.id), naturalKeys: [r => String(r.receipt_key)], timestamps: ['created_at','updated_at','processing_started_at','processed_at'], mismatchClassification: 'MANUAL_REVIEW' },
]

const excludedSpecs: TableSpec[] = [
  { name: 'lead_data_quality_flags', columns: ['id','lead_id','normalized_email','issue_type','reason','related_lead_ids','status','metadata','created_at','updated_at','resolved_at','resolution_reason','resolved_by'], key: r => String(r.id), disposition: 'DERIVED', timestamps: ['created_at','updated_at'] },
  { name: 'exhausted_queries', columns: ['query','city','category','exhausted_at','expires_at'], key: r => String(r.query), disposition: 'GENERATED', timestamps: ['exhausted_at','expires_at'] },
  { name: 'search_cache', columns: ['id','query','results','api_used','created_at','expires_at'], key: r => String(r.id), disposition: 'GENERATED', timestamps: ['created_at','expires_at'] },
  { name: 'discovery_run_metrics', columns: ['id','run_id','run_at'], key: r => String(r.id), disposition: 'AUDIT', timestamps: ['run_at'] },
]

const settingsAllowlist = new Set([
  'active_cities','blocked_business_keywords','blocked_google_categories','daily_dm_limit','daily_followup1_limit','daily_followup2_limit','daily_followup3_limit','daily_initial_outreach_limit','daily_lead_limit','daily_reactivation_limit','dead_after_reactivation_days','dead_lead_days','digest_email','enable_lead_filtering','follow_up_1_days','follow_up_2_days','follow_up_3_days','initial_email_mode','reactivation_delay_days','reactivation_enabled','system_active',
])

function stable(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Row).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex')
}

function numericTotal(value: unknown): number {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + numericTotal(item), 0)
  if (value && typeof value === 'object') return Object.values(value as Row).reduce<number>((sum, item) => sum + numericTotal(item), 0)
  return 0
}

function isFalseValue(value: unknown): boolean {
  return value === false || value === 'false' || value === 0 || value === '0'
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function exactColumns(row: Row, columns: string[]): Row {
  return Object.fromEntries(columns.map(column => [column, row[column] ?? null]))
}

interface SafetyGate {
  passed: boolean
  required: unknown
  observed: unknown
}

function assertAll(checks: Record<string, SafetyGate>): void {
  const failures = Object.entries(checks).filter(([, check]) => !check.passed)
  if (!failures.length) return
  const diagnostics = failures.map(([name, check]) => `${name}:\n  required: ${stable(check.required)}\n  observed: ${stable(check.observed)}`)
  throw new Error(`PLAN_SAFETY_GATE_FAILED:\n${diagnostics.join('\n')}`)
}

function withoutPlanHash(plan: Row): Row {
  const { plan_sha256: _ignored, ...unsigned } = plan
  return unsigned
}

async function withReadOnlyCatalogTransaction<T>(v2DbUrl: string, inspect: (client: pg.Client) => Promise<T>): Promise<T> {
  if (refFromDbUrl(v2DbUrl) !== V2_REF) throw new Error('V2 database URL identity is not the expected project')
  const client = new pg.Client({ connectionString: v2DbUrl })
  await client.connect()
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      const mode = await client.query("SELECT current_setting('transaction_read_only') AS transaction_read_only")
      if (mode.rows[0]?.transaction_read_only !== 'on') throw new Error('Catalog transaction is not explicitly read-only')
      const result = await inspect(client)
      await client.query('ROLLBACK')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  } finally {
    await client.end()
  }
}

async function v2CatalogSafety(v2DbUrl: string): Promise<{ transaction_read_only: string; database_name: string; owner_create: boolean }> {
  return withReadOnlyCatalogTransaction(v2DbUrl, async client => {
    const result = await client.query("SELECT current_setting('transaction_read_only') AS transaction_read_only, current_database() AS database_name, has_schema_privilege('reachagent_function_owner','public','CREATE') AS owner_create")
    return result.rows[0] as { transaction_read_only: string; database_name: string; owner_create: boolean }
  })
}

function readVerifiedPlan(path: string, expectedSha256: string): Row {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as Row
  const recorded = String(plan.plan_sha256 ?? '')
  const calculated = sha256(withoutPlanHash(plan))
  if (!/^[a-f0-9]{64}$/.test(recorded) || recorded !== calculated) throw new Error('Plan artifact SHA-256 verification failed')
  if (recorded !== expectedSha256) throw new Error('--confirm-plan-sha256 does not match the verified artifact')
  if (plan.schema_version !== PLAN_SCHEMA_VERSION || plan.kind !== 'FINAL_V1_V2_INSERT_ONLY_PLAN') throw new Error('Unsupported plan artifact')
  if (plan.source_project_ref !== V1_REF || plan.target_project_ref !== V2_REF || plan.seed_workspace_id !== WORKSPACE_ID) throw new Error('Plan identity does not match the pinned projects/workspace')
  const snapshot = plan.snapshot as Row
  if (String(plan.snapshot_sha256 ?? '') !== sha256(snapshot)) throw new Error('Plan snapshot SHA-256 verification failed')
  return plan
}

async function insertRows(client: pg.Client, table: 'inbound_receipts' | 'activity_log', columns: string[], rows: Row[]): Promise<void> {
  if (!rows.length) return
  if (![table, ...columns].every(name => /^[a-z_]+$/.test(name))) throw new Error('Unsafe SQL identifier')
  const values: unknown[] = []
  const tuples = rows.map((row, rowIndex) => {
    const parameters = columns.map((column, columnIndex) => {
      values.push(row[column] ?? null)
      return `$${rowIndex * columns.length + columnIndex + 1}`
    })
    return `(${parameters.join(',')})`
  })
  await client.query(`INSERT INTO public.${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values)
}

async function executeApprovedPlan(plan: Row, source: Map<string, Row[]>, v2DbUrl: string): Promise<void> {
  if (refFromDbUrl(v2DbUrl) !== V2_REF) throw new Error('V2 database URL identity is not the expected project')
  const snapshot = plan.snapshot as Row
  const allowlist = snapshot.executable_allowlist as Row
  const inboundEntries = allowlist.inbound_receipts as Row[]
  const activityEntries = allowlist.activity_log as Row[]
  const approvedCounts = snapshot.approved_executable_counts as Row
  if ((allowlist.all_other_tables as unknown[]).length !== 0) throw new Error('Plan contains a forbidden executable table')
  if (inboundEntries.length !== Number(approvedCounts.inbound_receipts) || activityEntries.length !== Number(approvedCounts.activity_log)) throw new Error('Plan executable counts do not match the approved artifact')
  if (new Set(inboundEntries.map(entry => String(entry.id))).size !== inboundEntries.length || new Set(activityEntries.map(entry => String(entry.id))).size !== activityEntries.length) throw new Error('Plan contains duplicate executable IDs')
  const inboundSpec = specs.find(spec => spec.name === 'inbound_receipts')!
  const activitySpec = specs.find(spec => spec.name === 'activity_log')!
  const sourceInboundById = new Map((source.get('inbound_receipts') ?? []).map(row => [String(row.id), row]))
  const sourceActivityById = new Map((source.get('activity_log') ?? []).map(row => [String(row.id), row]))
  const materialize = (entries: Row[], byId: Map<string, Row>, spec: TableSpec): Row[] => entries.map(entry => {
    const row = byId.get(String(entry.id))
    if (!row) throw new Error(`${spec.name} source row ${String(entry.id)} is missing`)
    const sourceRow = exactColumns(row, spec.columns)
    const targetRow = { ...sourceRow, workspace_id: WORKSPACE_ID }
    if (entry.canonical_source_sha256 !== sha256(sourceRow) || entry.canonical_target_sha256 !== sha256(targetRow)) throw new Error(`${spec.name} source row ${String(entry.id)} changed after plan generation`)
    return targetRow
  })
  const inboundRows = materialize(inboundEntries, sourceInboundById, inboundSpec)
  const activityRows = materialize(activityEntries, sourceActivityById, activitySpec)
  if (inboundRows.some(row => !TERMINAL_INBOUND_STATUSES.has(String(row.status)))) throw new Error('Plan contains a nonterminal inbound receipt')

  const targetPreCounts = snapshot.target_pre_counts as Row
  const client = new pg.Client({ connectionString: v2DbUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ADVISORY_LOCK_NAME])
      const safety = await client.query("SELECT current_database() AS database_name, has_schema_privilege('reachagent_function_owner','public','CREATE') AS owner_create, (SELECT value FROM public.settings WHERE key='system_active') AS system_active")
      if (safety.rows[0]?.owner_create !== false || !isFalseValue(safety.rows[0]?.system_active)) throw new Error('V2 execution safety gates are not false')

      const preInbound = await client.query('SELECT count(*)::int AS count FROM public.inbound_receipts WHERE workspace_id=$1', [WORKSPACE_ID])
      const preActivity = await client.query('SELECT count(*)::int AS count FROM public.activity_log WHERE workspace_id=$1', [WORKSPACE_ID])
      if (preInbound.rows[0].count !== Number(targetPreCounts.inbound_receipts) || preActivity.rows[0].count !== Number(targetPreCounts.activity_log)) throw new Error('V2 target pre-counts changed after plan generation')

      const inboundIds = inboundRows.map(row => row.id)
      const receiptKeys = inboundRows.map(row => row.receipt_key)
      const inboundConflicts = await client.query('SELECT id FROM public.inbound_receipts WHERE id=ANY($1::uuid[]) OR (workspace_id=$2 AND receipt_key=ANY($3::text[])) FOR UPDATE', [inboundIds, WORKSPACE_ID, receiptKeys])
      if (inboundConflicts.rowCount !== 0) throw new Error('V2 inbound receipt ID/natural-key conflict detected')
      const activityIds = activityRows.map(row => row.id)
      const activityIdConflicts = await client.query('SELECT id FROM public.activity_log WHERE id=ANY($1::uuid[]) FOR UPDATE', [activityIds])
      if (activityIdConflicts.rowCount !== 0) throw new Error('V2 activity ID conflict detected')
      for (const row of activityRows) {
        const receiptId = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Row).inbound_receipt_id : null
        if (receiptId == null) continue
        const conflict = await client.query("SELECT id FROM public.activity_log WHERE workspace_id=$1 AND event_type=$2 AND metadata->>'inbound_receipt_id'=$3 FOR UPDATE", [WORKSPACE_ID, row.event_type, String(receiptId)])
        if (conflict.rowCount !== 0) throw new Error('V2 activity natural-key conflict detected')
      }

      await insertRows(client, 'inbound_receipts', [...inboundSpec.columns, 'workspace_id'], inboundRows)
      await insertRows(client, 'activity_log', [...activitySpec.columns, 'workspace_id'], activityRows)

      const postInbound = await client.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE id=ANY($2::uuid[]))::int AS planned FROM public.inbound_receipts WHERE workspace_id=$1', [WORKSPACE_ID, inboundIds])
      const postActivity = await client.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE id=ANY($2::uuid[]))::int AS planned FROM public.activity_log WHERE workspace_id=$1', [WORKSPACE_ID, activityIds])
      if (postInbound.rows[0].total !== Number(targetPreCounts.inbound_receipts) + inboundRows.length || postInbound.rows[0].planned !== inboundRows.length) throw new Error('Inbound receipt postcondition failed')
      if (postActivity.rows[0].total !== Number(targetPreCounts.activity_log) + activityRows.length || postActivity.rows[0].planned !== activityRows.length) throw new Error('Activity postcondition failed')
      if (inboundIds.length) {
        const inserted = await client.query(`SELECT to_jsonb(x) AS row FROM (SELECT ${inboundSpec.columns.join(',')},workspace_id FROM public.inbound_receipts WHERE workspace_id=$1 AND id=ANY($2::uuid[])) x`, [WORKSPACE_ID, inboundIds])
        const hashes = new Map(inserted.rows.map(item => [String((item.row as Row).id), sha256(item.row)]))
        for (const entry of inboundEntries) if (hashes.get(String(entry.id)) !== entry.canonical_target_sha256) throw new Error(`Inbound receipt ${String(entry.id)} canonical postcondition failed`)
      }
      if (activityIds.length) {
        const inserted = await client.query(`SELECT to_jsonb(x) AS row FROM (SELECT ${activitySpec.columns.join(',')},workspace_id FROM public.activity_log WHERE workspace_id=$1 AND id=ANY($2::uuid[])) x`, [WORKSPACE_ID, activityIds])
        const hashes = new Map(inserted.rows.map(item => [String((item.row as Row).id), sha256(item.row)]))
        for (const entry of activityEntries) if (hashes.get(String(entry.id)) !== entry.canonical_target_sha256) throw new Error(`Activity ${String(entry.id)} canonical postcondition failed`)
      }
      const wrongWorkspace = await client.query('SELECT (SELECT count(*) FROM public.inbound_receipts WHERE id=ANY($1::uuid[]) AND workspace_id IS DISTINCT FROM $3) + (SELECT count(*) FROM public.activity_log WHERE id=ANY($2::uuid[]) AND workspace_id IS DISTINCT FROM $3) AS count', [inboundIds, activityIds, WORKSPACE_ID])
      if (Number(wrongWorkspace.rows[0].count) !== 0) throw new Error('Planned row workspace postcondition failed')
      const duplicateInbound = await client.query('SELECT count(*)::int AS count FROM (SELECT receipt_key FROM public.inbound_receipts WHERE workspace_id=$1 GROUP BY receipt_key HAVING count(*)>1) d', [WORKSPACE_ID])
      const duplicateActivity = await client.query("SELECT count(*)::int AS count FROM (SELECT event_type,metadata->>'inbound_receipt_id' FROM public.activity_log WHERE workspace_id=$1 AND metadata->>'inbound_receipt_id' IS NOT NULL GROUP BY event_type,metadata->>'inbound_receipt_id' HAVING count(*)>1) d", [WORKSPACE_ID])
      if (duplicateInbound.rows[0].count !== 0 || duplicateActivity.rows[0].count !== 0) throw new Error('Natural-key uniqueness postcondition failed')
      const missingReceipt = await client.query("SELECT count(*)::int AS count FROM public.activity_log a WHERE a.workspace_id=$1 AND a.id=ANY($2::uuid[]) AND a.metadata->>'inbound_receipt_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.inbound_receipts r WHERE r.workspace_id=$1 AND r.id::text=a.metadata->>'inbound_receipt_id')", [WORKSPACE_ID, activityIds])
      if (missingReceipt.rows[0].count !== 0) throw new Error('Activity receipt FK-like postcondition failed')
      const emailDuplicates = await client.query("SELECT (SELECT count(*) FROM (SELECT resend_id FROM public.emails WHERE workspace_id=$1 AND resend_id IS NOT NULL GROUP BY resend_id HAVING count(*)>1) a) + (SELECT count(*) FROM (SELECT lead_id,type FROM public.emails WHERE workspace_id=$1 AND status IN ('pending_send','sending','sent','delivery_uncertain','email_sync_failed') GROUP BY lead_id,type HAVING count(*)>1) b) AS count", [WORKSPACE_ID])
      if (Number(emailDuplicates.rows[0].count) !== 0) throw new Error('Email uniqueness postcondition failed')
      for (const spec of [...specs, ...excludedSpecs]) {
        const scope = await client.query(`SELECT count(*)::int AS count FROM public.${spec.name} WHERE workspace_id IS NULL OR workspace_id<>$1`, [WORKSPACE_ID])
        if (scope.rows[0].count !== 0) throw new Error(`${spec.name} workspace scope postcondition failed`)
        for (const fk of spec.foreignKeys ?? []) {
          const orphan = await client.query(`SELECT count(*)::int AS count FROM public.${spec.name} c WHERE c.workspace_id=$1 AND c.${fk.column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.${fk.parent} p WHERE p.workspace_id=$1 AND p.id=c.${fk.column})`, [WORKSPACE_ID])
          if (orphan.rows[0].count !== 0) throw new Error(`${spec.name}.${fk.column} FK postcondition failed`)
        }
      }
      const finalGate = await client.query("SELECT value FROM public.settings WHERE key='system_active'")
      if (!isFalseValue(finalGate.rows[0]?.value)) throw new Error('V2 system_active changed before commit')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    await client.end()
  }
}

function semantic(row: Row, columns: string[]): string {
  return stable(Object.fromEntries(columns.map(column => [column, row[column] ?? null])))
}

function safeKey(spec: TableSpec, key: string): string {
  return spec.name === 'recipient_outreach_ownership'
    ? `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
    : key
}

function changedFields(a: Row, b: Row, columns: string[]): string[] {
  return columns.filter(column => stable(a[column] ?? null) !== stable(b[column] ?? null))
}

async function readAll(client: SupabaseClient, table: string, columns: string, workspaceScoped: boolean, orderColumn?: string): Promise<Row[]> {
  const rows: Row[] = []
  for (let from = 0;; from += PAGE) {
    let query = client.from(table).select(columns).range(from, from + PAGE - 1)
    if (workspaceScoped) query = query.eq('workspace_id', WORKSPACE_ID)
    if (orderColumn) query = query.order(orderColumn, { ascending: true })
    const { data, error } = await query
    if (error) throw new Error(`SELECT ${table}: ${error.message}`)
    rows.push(...((data ?? []) as unknown as Row[]))
    if ((data?.length ?? 0) < PAGE) return rows
  }
}

async function countWorkspace(client: SupabaseClient, table: string, mode: 'seed' | 'other' | 'null'): Promise<number> {
  let query = client.from(table).select('*', { count: 'exact', head: true })
  if (mode === 'seed') query = query.eq('workspace_id', WORKSPACE_ID)
  else if (mode === 'other') query = query.neq('workspace_id', WORKSPACE_ID)
  else query = query.is('workspace_id', null)
  const { count, error } = await query
  if (error) throw new Error(`SELECT COUNT ${table}: ${error.message}`)
  return count ?? 0
}

function distribution(rows: Row[], column: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) {
    const value = row[column] == null ? '<null>' : String(row[column])
    result[value] = (result[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort(([a],[b]) => a.localeCompare(b)))
}

function extrema(rows: Row[], column: string): { min: string | null; max: string | null } {
  const values = rows.map(r => r[column]).filter((v): v is string => typeof v === 'string').sort()
  return { min: values[0] ?? null, max: values.at(-1) ?? null }
}

function emptyClasses(): Record<Classification, number> {
  return { INSERT_SAFE: 0, UPDATE_SAFE: 0, NO_CHANGE: 0, EXPECTED_DEDUP: 0, V2_ONLY: 0, CONFLICT: 0, MANUAL_REVIEW: 0, DO_NOT_MIGRATE: 0 }
}

function duplicateKeys(rows: Row[], fn: (row: Row) => string | null): { keys: number; rows: number } {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = fn(row)
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const duplicates = [...counts.values()].filter(count => count > 1)
  return { keys: duplicates.length, rows: duplicates.reduce((sum, count) => sum + count, 0) }
}

function dedupeEmails(rows: Row[]): { effective: Row[]; skipped: Row[]; ambiguities: Row[] } {
  const eligible = new Set(['pending_send','sent','email_sync_failed']) // exact rehearsal rule
  const groups = new Map<string, Row[]>()
  const ambiguities: Row[] = []
  const ordered = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const idCounts = new Map<string, number>()
  for (const row of ordered) {
    const id = String(row.id ?? '')
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
    if (!eligible.has(String(row.status))) continue
    if (!row.id || !row.lead_id || !row.type) ambiguities.push({ reason: 'missing_dedup_key_component', id: row.id ?? null, lead_id: row.lead_id ?? null, type: row.type ?? null })
    const key = `${row.lead_id}|${row.type}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const [id, count] of idCounts) if (!id || count > 1) ambiguities.push({ reason: 'duplicate_or_missing_email_id', id: id || null, count })
  const skip = new Set<string>()
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    const sent = group.filter(row => row.status === 'sent')
    if (sent.length > 1) ambiguities.push({ reason: 'multiple_sent_rows_in_dedup_group', natural_key: key, ids: sent.map(row => row.id) })
    const keep = sent[0] ?? group[0]
    for (const row of group) if (row.id !== keep.id) skip.add(String(row.id))
  }
  return { effective: ordered.filter(row => !skip.has(String(row.id))), skipped: ordered.filter(row => skip.has(String(row.id))), ambiguities }
}

async function main(): Promise<void> {
  const command = cli()
  const approvedInputPlan = command.mode === 'execute-plan'
    ? readVerifiedPlan(command.path, command.confirmSha256!)
    : null
  const v1env = parseEnv(resolve(ROOT, '.env.local'))
  const v2env = parseEnv(resolve(ROOT, '.env.v2.local'))
  const v1Url = v1env.NEXT_PUBLIC_SUPABASE_URL || v1env.SUPABASE_URL || ''
  const v2Url = v2env.NEXT_PUBLIC_SUPABASE_URL || v2env.SUPABASE_URL || ''
  const v1Key = v1env.SUPABASE_SERVICE_ROLE_KEY || ''
  const v2Key = v2env.SUPABASE_SERVICE_ROLE_KEY || ''
  identityGuard('V1', v1Url, v1Key, V1_REF)
  identityGuard('V2', v2Url, v2Key, V2_REF, [v2env.NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF ?? '', refFromDbUrl(v2env.V2_SUPABASE_DB_URL ?? '') ?? ''])
  if (v1Url === v2Url) throw new Error('V1 and V2 resolve to the same database')

  const v1 = makeClient(v1Url, v1Key)
  const v2 = makeClient(v2Url, v2Key)
  if (process.argv.includes('--catalog')) {
    const result = await withReadOnlyCatalogTransaction(v2env.V2_SUPABASE_DB_URL ?? '', async client => {
      const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS transaction_read_only, current_database() AS database_name, has_schema_privilege('reachagent_function_owner','public','CREATE') AS owner_create")
      const catalog = await client.query(`
        SELECT c.relname AS table_name,
               ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
               ARRAY(SELECT con.conname FROM pg_constraint con WHERE con.conrelid=c.oid ORDER BY con.conname) AS constraints,
               ARRAY(SELECT i.indexname FROM pg_indexes i WHERE i.schemaname=n.nspname AND i.tablename=c.relname ORDER BY i.indexname) AS indexes
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`, [[...specs, ...excludedSpecs].map(spec => spec.name)])
      return { mode: 'SELECT_ONLY_CATALOG', identity: V2_REF, session: readOnly.rows[0], tables: catalog.rows }
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (process.argv.includes('--focus')) {
    const [v1Settings, v2Settings, v1Activity, v2Activity, v1Inbound, v2Inbound] = await Promise.all([
      readAll(v1, 'settings', 'key,value,updated_at', false, 'key'),
      readAll(v2, 'settings', 'key,value,updated_at', false, 'key'),
      readAll(v1, 'activity_log', 'id,created_at', false, 'id'),
      readAll(v2, 'activity_log', 'id,created_at', true, 'id'),
      readAll(v1, 'inbound_receipts', 'id,updated_at', false, 'id'),
      readAll(v2, 'inbound_receipts', 'id,updated_at', true, 'id'),
    ])
    const gate = (rows: Row[]) => rows.find(row => row.key === 'system_active') ?? null
    console.log(JSON.stringify({ mode: 'SELECT_ONLY_FOCUS', identity: { v1: V1_REF, v2: V2_REF }, system_active: { v1: gate(v1Settings), v2: gate(v2Settings) }, settings_updated_at: { v1: extrema(v1Settings, 'updated_at'), v2: extrema(v2Settings, 'updated_at') }, activity: { v1_count: v1Activity.length, v1_max: extrema(v1Activity, 'created_at').max, v2_count: v2Activity.length, v2_max: extrema(v2Activity, 'created_at').max }, inbound_receipts: { v1_count: v1Inbound.length, v1_max_updated_at: extrema(v1Inbound, 'updated_at').max, v2_count: v2Inbound.length, v2_max_updated_at: extrema(v2Inbound, 'updated_at').max } }, null, 2))
    return
  }
  const source = new Map<string, Row[]>()
  const target = new Map<string, Row[]>()
  for (const spec of [...specs, ...excludedSpecs]) {
    const orderColumn = spec.name === 'recipient_outreach_ownership' ? 'normalized_email' : spec.name === 'exhausted_queries' ? 'query' : 'id'
    source.set(spec.name, await readAll(v1, spec.name, spec.columns.join(','), false, orderColumn))
    target.set(spec.name, await readAll(v2, spec.name, `${spec.columns.join(',')},workspace_id`, true, orderColumn))
  }
  const v2WorkspaceIds = new Set((await readAll(v2, 'workspaces', 'id', false, 'id')).map(row => String(row.id)))

  const output: Row = {
    generated_at: new Date().toISOString(),
    mode: 'SELECT_ONLY',
    identity: { v1: V1_REF, v2: V2_REF, distinct: true, workspace_id: WORKSPACE_ID, proofs: { v1: ['URL hostname project ref','service-role JWT project ref'], v2: ['URL hostname project ref','explicit V2 project-ref marker','database URL embedded project ref','opaque sb_secret service credential accepted by project'], separation: ['distinct project refs','distinct URLs'] } },
    baseline: { exact_cutoff_found: false, recorded_rehearsal_date: '2026-09-26 Australia/Sydney', method: 'current-state ID and natural-key reconciliation' },
    tables: {},
    excluded: {},
    integrity: { source_orphans: {}, target_orphans: {}, workspace_scope: {} },
    suppression: {},
    settings: {},
    lifecycle: {},
    critical_details: {},
  }
  const tableOutput = output.tables as Record<string, Row>
  const sourceEffective = new Map(source)
  const emailDedupe = dedupeEmails(source.get('emails') ?? [])
  sourceEffective.set('emails', emailDedupe.effective)

  for (const spec of specs) {
    const rawV1 = source.get(spec.name) ?? []
    const v1rows = sourceEffective.get(spec.name) ?? []
    const v2rows = target.get(spec.name) ?? []
    const v1ById = new Map(v1rows.map(row => [spec.key(row), row]))
    const v2ById = new Map(v2rows.map(row => [spec.key(row), row]))
    const v2Natural = (spec.naturalKeys ?? []).map(fn => {
      const entries: [string, Row][] = []
      for (const row of v2rows) {
        const natural = fn(row)
        if (natural !== null) entries.push([natural, row])
      }
      return new Map(entries)
    })
    const classes = emptyClasses()
    const fieldDifferences: Record<string, number> = {}
    const samples: Record<string, string[]> = { insert: [], mismatch: [], v2_only: [], conflict: [] }
    const naturalConflicts: Record<string, number> = {}

    if (spec.name === 'emails') classes.EXPECTED_DEDUP = emailDedupe.skipped.length
    for (const [id, v1row] of v1ById) {
      const v2row = v2ById.get(id)
      if (v2row) {
        if (semantic(v1row, spec.columns) === semantic(v2row, spec.columns)) classes.NO_CHANGE++
        else {
          const classification = spec.mismatchClassification ?? 'MANUAL_REVIEW'
          classes[classification]++
          if (samples.mismatch.length < 20) samples.mismatch.push(safeKey(spec, id))
          for (const field of changedFields(v1row, v2row, spec.columns)) fieldDifferences[field] = (fieldDifferences[field] ?? 0) + 1
        }
        continue
      }
      let conflict = false
      for (const [index, fn] of (spec.naturalKeys ?? []).entries()) {
        const natural = fn(v1row)
        if (natural !== null && v2Natural[index].has(natural)) {
          conflict = true
          naturalConflicts[`key_${index + 1}`] = (naturalConflicts[`key_${index + 1}`] ?? 0) + 1
        }
      }
      if (conflict) {
        classes.CONFLICT++
        if (samples.conflict.length < 20) samples.conflict.push(safeKey(spec, id))
      } else {
        classes.INSERT_SAFE++
        if (samples.insert.length < 20) samples.insert.push(safeKey(spec, id))
      }
    }
    for (const [id] of v2ById) if (!v1ById.has(id)) {
      classes.V2_ONLY++
      if (samples.v2_only.length < 20) samples.v2_only.push(safeKey(spec, id))
    }
    const timestamps = Object.fromEntries((spec.timestamps ?? []).map(column => [column, { v1: extrema(rawV1, column), v2: extrema(v2rows, column) }]))
    const duplicates = Object.fromEntries((spec.naturalKeys ?? []).map((fn, index) => [`key_${index + 1}`, { v1: duplicateKeys(rawV1, fn), v2: duplicateKeys(v2rows, fn) }]))
    tableOutput[spec.name] = { v1_count: rawV1.length, v1_effective_count: v1rows.length, v2_seed_count: v2rows.length, raw_count_difference: v2rows.length - rawV1.length, classifications: classes, field_differences: fieldDifferences, natural_key_conflicts: naturalConflicts, duplicate_natural_keys: duplicates, timestamps, samples }
  }

  const scopeCounts = await Promise.all([...specs, ...excludedSpecs].map(async spec => [spec.name, {
    seed: await countWorkspace(v2, spec.name, 'seed'),
    other_workspace: await countWorkspace(v2, spec.name, 'other'),
    null_workspace: await countWorkspace(v2, spec.name, 'null'),
  }] as const))
  ;(output.integrity as Row).workspace_scope = Object.fromEntries(scopeCounts)

  const sourceIds = new Map([...sourceEffective].map(([name, rows]) => [name, new Set(rows.map(row => String(row.id ?? row.normalized_email ?? row.query)))]))
  const targetIds = new Map([...target].map(([name, rows]) => [name, new Set(rows.map(row => String(row.id ?? row.normalized_email ?? row.query)))]))
  for (const spec of specs) for (const fk of spec.foreignKeys ?? []) {
    const sourceOrphans = (sourceEffective.get(spec.name) ?? []).filter(row => row[fk.column] != null && !sourceIds.get(fk.parent)?.has(String(row[fk.column]))).length
    const targetOrphans = (target.get(spec.name) ?? []).filter(row => row[fk.column] != null && !targetIds.get(fk.parent)?.has(String(row[fk.column]))).length
    ;(output.integrity as Row).source_orphans = { ...((output.integrity as Row).source_orphans as Row), [`${spec.name}.${fk.column}->${fk.parent}`]: sourceOrphans }
    ;(output.integrity as Row).target_orphans = { ...((output.integrity as Row).target_orphans as Row), [`${spec.name}.${fk.column}->${fk.parent}`]: targetOrphans }
  }

  for (const spec of excludedSpecs) {
    const v1rows = source.get(spec.name) ?? []
    const v2rows = target.get(spec.name) ?? []
    ;(output.excluded as Record<string, Row>)[spec.name] = { disposition: spec.disposition, reason: spec.name === 'lead_data_quality_flags' ? 'derived deterministically from leads; original migration explicitly excluded it' : 'runtime/generated/historical state not included by original migration', v1_count: v1rows.length, v2_seed_count: v2rows.length, classifications: { ...emptyClasses(), DO_NOT_MIGRATE: v1rows.length }, timestamps: Object.fromEntries((spec.timestamps ?? []).map(column => [column, { v1: extrema(v1rows, column), v2: extrema(v2rows, column) }])) }
  }

  const v1Settings = await readAll(v1, 'settings', 'id,key,value,description,updated_at', false, 'key')
  const v2Settings = await readAll(v2, 'settings', 'id,key,value,description,updated_at', false, 'key')
  const v1Allowed = v1Settings.filter(row => settingsAllowlist.has(String(row.key)))
  const v2ByKey = new Map(v2Settings.map(row => [String(row.key), row]))
  const settingClasses = emptyClasses()
  const settingDiffs: Row[] = []
  for (const row of v1Allowed) {
    const other = v2ByKey.get(String(row.key))
    if (!other) settingClasses.INSERT_SAFE++
    else if (semantic(row, ['key','value','description','updated_at']) === semantic(other, ['key','value','description','updated_at'])) settingClasses.NO_CHANGE++
    else {
      settingClasses.MANUAL_REVIEW++
      settingDiffs.push({ key: row.key, changed_fields: changedFields(row, other, ['value','description','updated_at']) })
    }
  }
  const allowedKeys = new Set(v1Allowed.map(row => String(row.key)))
  settingClasses.V2_ONLY = v2Settings.filter(row => settingsAllowlist.has(String(row.key)) && !allowedKeys.has(String(row.key))).length
  settingClasses.DO_NOT_MIGRATE = v1Settings.length - v1Allowed.length
  output.settings = { v1_total: v1Settings.length, v1_allowlisted: v1Allowed.length, v2_total_global: v2Settings.length, classifications: settingClasses, allowlisted_differences: settingDiffs, excluded_keys: v1Settings.filter(row => !settingsAllowlist.has(String(row.key))).map(row => row.key).sort() }

  const v1Leads = new Map((source.get('leads') ?? []).map(row => [String(row.id), row]))
  const v2Leads = new Map((target.get('leads') ?? []).map(row => [String(row.id), row]))
  let sourceSuppressionMissing = 0
  let deliverySuppressionMissing = 0
  let suppressionConflict = 0
  for (const [id, a] of v1Leads) {
    const b = v2Leads.get(id)
    if (!b) continue
    const aSuppressed = a.outreach_suppressed_at != null || a.outreach_suppression_reason != null
    const bSuppressed = b.outreach_suppressed_at != null || b.outreach_suppression_reason != null
    if (aSuppressed && !bSuppressed) sourceSuppressionMissing++
    if (aSuppressed !== bSuppressed) suppressionConflict++
    const bDelivery = new Set(Array.isArray(b.delivery_suppressed_emails) ? b.delivery_suppressed_emails.map(String) : [])
    if ((Array.isArray(a.delivery_suppressed_emails) ? a.delivery_suppressed_emails.map(String) : []).some(email => !bDelivery.has(email))) deliverySuppressionMissing++
  }
  const v1Emails = new Map(emailDedupe.effective.map(row => [String(row.id), row]))
  const v2Emails = new Map((target.get('emails') ?? []).map(row => [String(row.id), row]))
  let terminalEmailSuppressionMissing = 0
  for (const [id, a] of v1Emails) {
    const b = v2Emails.get(id)
    if (b && ['bounced','suppressed'].includes(String(a.status)) && !['bounced','suppressed'].includes(String(b.status))) terminalEmailSuppressionMissing++
  }
  output.suppression = { v1_lead_suppression_missing_in_v2: sourceSuppressionMissing, v1_delivery_suppression_missing_in_v2: deliverySuppressionMissing, lead_suppression_disagreements_manual_review: suppressionConflict, v1_terminal_email_suppression_missing_in_v2: terminalEmailSuppressionMissing, rule: 'never weaken either side; disagreements require manual review' }

  const duplicateRecipients = (rows: Row[]) => {
    const counts = new Map<string, number>()
    for (const row of rows) if (row.normalized_email) counts.set(String(row.normalized_email), (counts.get(String(row.normalized_email)) ?? 0) + 1)
    const values = [...counts.values()].filter(count => count > 1)
    return { duplicate_keys: values.length, related_rows: values.reduce((sum, count) => sum + count, 0), excess_relationships: values.reduce((sum, count) => sum + count - 1, 0) }
  }
  const mismatchedLeads = [...v1Leads].flatMap(([id, a]) => {
    const b = v2Leads.get(id)
    return b && semantic(a, specs.find(spec => spec.name === 'leads')!.columns) !== semantic(b, specs.find(spec => spec.name === 'leads')!.columns)
      ? [{ id, v1_status: a.status, v2_status: b.status, v1_updated_at: a.updated_at, v2_updated_at: b.updated_at, changed_fields: changedFields(a, b, specs.find(spec => spec.name === 'leads')!.columns) }]
      : []
  })
  const v1Ownership = new Map((source.get('recipient_outreach_ownership') ?? []).map(row => [String(row.normalized_email), row]))
  const v2Ownership = new Map((target.get('recipient_outreach_ownership') ?? []).map(row => [String(row.normalized_email), row]))
  const ownershipConflicts = [...v1Ownership].flatMap(([email, a]) => {
    const b = v2Ownership.get(email)
    return b && semantic(a, specs.find(spec => spec.name === 'recipient_outreach_ownership')!.columns) !== semantic(b, specs.find(spec => spec.name === 'recipient_outreach_ownership')!.columns)
      ? [{ normalized_email_sha256: createHash('sha256').update(email).digest('hex'), v1_owner_lead_id: a.owner_lead_id, v2_owner_lead_id: b.owner_lead_id, v1_state: a.state, v2_state: b.state, v1_claimed_at: a.claimed_at, v2_claimed_at: b.claimed_at, v1_last_activity_at: a.last_activity_at, v2_last_activity_at: b.last_activity_at }]
      : []
  })
  const sourceActivityIds = new Set((target.get('activity_log') ?? []).map(row => String(row.id)))
  const newActivity = (source.get('activity_log') ?? []).filter(row => !sourceActivityIds.has(String(row.id))).map(row => ({ id: row.id, event_type: row.event_type, lead_id: row.lead_id, created_at: row.created_at, inbound_receipt_id: typeof row.metadata === 'object' && row.metadata !== null ? (row.metadata as Row).inbound_receipt_id ?? null : null }))
  output.lifecycle = {
    leads_status: { v1: distribution(source.get('leads') ?? [], 'status'), v2: distribution(target.get('leads') ?? [], 'status') },
    emails_status_raw_v1: distribution(source.get('emails') ?? [], 'status'),
    emails_status_effective_v1: distribution(emailDedupe.effective, 'status'),
    emails_status_v2: distribution(target.get('emails') ?? [], 'status'),
    emails_type_effective_v1: distribution(emailDedupe.effective, 'type'),
    emails_type_v2: distribution(target.get('emails') ?? [], 'type'),
    follow_ups_status: { v1: distribution(source.get('follow_ups') ?? [], 'status'), v2: distribution(target.get('follow_ups') ?? [], 'status') },
    inbound_receipts_status: { v1: distribution(source.get('inbound_receipts') ?? [], 'status'), v2: distribution(target.get('inbound_receipts') ?? [], 'status') },
    email_reply_markers: { v1_replied_at_non_null: emailDedupe.effective.filter(row => row.replied_at != null).length, v2_replied_at_non_null: (target.get('emails') ?? []).filter(row => row.replied_at != null).length },
    lead_duplicate_normalized_recipients: { v1: duplicateRecipients(source.get('leads') ?? []), v2: duplicateRecipients(target.get('leads') ?? []) },
    redundant_nonterminal_drafts: { count: emailDedupe.skipped.length, statuses: distribution(emailDedupe.skipped, 'status'), definition: "within V1 statuses pending_send/sent/email_sync_failed sharing (lead_id,type), retain first sent row if present, otherwise first row" },
  }
  output.critical_details = { lead_value_mismatches: mismatchedLeads, ownership_conflicts: ownershipConflicts, source_only_activity: newActivity }

  const catalogSafety = await v2CatalogSafety(v2env.V2_SUPABASE_DB_URL ?? '')
  const inboundSpec = specs.find(spec => spec.name === 'inbound_receipts')!
  const activitySpec = specs.find(spec => spec.name === 'activity_log')!
  const emailSpec = specs.find(spec => spec.name === 'emails')!
  const leadSpec = specs.find(spec => spec.name === 'leads')!
  const ownershipSpec = specs.find(spec => spec.name === 'recipient_outreach_ownership')!
  const v1Inbound = source.get('inbound_receipts') ?? []
  const v2Inbound = target.get('inbound_receipts') ?? []
  const v1Activity = source.get('activity_log') ?? []
  const v2Activity = target.get('activity_log') ?? []
  const v2InboundIds = new Set(v2Inbound.map(row => String(row.id)))
  const v2InboundKeys = new Set(v2Inbound.map(row => String(row.receipt_key)))
  const v2ActivityIds = new Set(v2Activity.map(row => String(row.id)))
  const v2InboundById = new Map(v2Inbound.map(row => [String(row.id), row]))
  const v2ActivityById = new Map(v2Activity.map(row => [String(row.id), row]))
  const v1InboundIdCounts = new Map<string, number>()
  const v1ActivityIdCounts = new Map<string, number>()
  const activityNaturalKey = (row: Row): string | null => activitySpec.naturalKeys?.[0](row) ?? null
  const v2ActivityNaturalKeys = new Set(v2Activity.map(activityNaturalKey).filter((value): value is string => value !== null))
  const inboundKeyCounts = new Map<string, number>()
  const activityNaturalCounts = new Map<string, number>()
  for (const row of v1Inbound) {
    const id = String(row.id ?? '')
    const key = String(row.receipt_key ?? '')
    v1InboundIdCounts.set(id, (v1InboundIdCounts.get(id) ?? 0) + 1)
    inboundKeyCounts.set(key, (inboundKeyCounts.get(key) ?? 0) + 1)
  }
  for (const row of v1Activity) {
    const id = String(row.id ?? '')
    v1ActivityIdCounts.set(id, (v1ActivityIdCounts.get(id) ?? 0) + 1)
    const key = activityNaturalKey(row)
    if (key !== null) activityNaturalCounts.set(key, (activityNaturalCounts.get(key) ?? 0) + 1)
  }
  const sourceOnlyInbound = v1Inbound.filter(row => !v2InboundIds.has(String(row.id)))
  const inboundAssessment = sourceOnlyInbound.map(row => {
    const id = String(row.id ?? '')
    const key = String(row.receipt_key ?? '')
    const reasons: string[] = []
    if (!id || !key) reasons.push('SOURCE_ROW_CANNOT_BE_MAPPED')
    if ((v1InboundIdCounts.get(id) ?? 0) !== 1) reasons.push('DUPLICATE_SOURCE_ID')
    if ((inboundKeyCounts.get(key) ?? 0) !== 1) reasons.push('DUPLICATE_SOURCE_RECEIPT_KEY')
    if (v2InboundKeys.has(key)) reasons.push('CONFLICTING_TARGET_RECEIPT_KEY')
    if (!TERMINAL_INBOUND_STATUSES.has(String(row.status))) reasons.push('NONTERMINAL_STATUS')
    return { row, id, receipt_key: key, status: row.status, reasons }
  })
  const rejectedInbound = inboundAssessment.filter(item => item.reasons.length).map(({ row: _row, ...item }) => item)
  const safeInbound = inboundAssessment.filter(item => !item.reasons.length).map(item => item.row).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const inboundTargetIdConflicts = v1Inbound.flatMap(row => {
    const other = v2InboundById.get(String(row.id))
    return other && semantic(row, inboundSpec.columns) !== semantic(other, inboundSpec.columns)
      ? [{ id: row.id, changed_fields: changedFields(row, other, inboundSpec.columns) }]
      : []
  })
  const sourceOnlyActivity = v1Activity.filter(row => !v2ActivityIds.has(String(row.id)))
  const targetLeadIds = new Set((target.get('leads') ?? []).map(row => String(row.id)))
  const availableReceiptIds = new Set([...v2InboundIds, ...safeInbound.map(row => String(row.id))])
  const activityAssessment = sourceOnlyActivity.map(row => {
    const id = String(row.id ?? '')
    const key = activityNaturalKey(row)
    const receiptId = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Row).inbound_receipt_id : null
    const hard_reasons: string[] = []
    const manual_review_reasons: string[] = []
    if (!id || !row.event_type) hard_reasons.push('SOURCE_ROW_CANNOT_BE_MAPPED')
    if ((v1ActivityIdCounts.get(id) ?? 0) !== 1) hard_reasons.push('DUPLICATE_SOURCE_ID')
    if (key !== null && (activityNaturalCounts.get(key) ?? 0) !== 1) hard_reasons.push('DUPLICATE_SOURCE_NATURAL_KEY')
    if (key !== null && v2ActivityNaturalKeys.has(key)) hard_reasons.push('CONFLICTING_TARGET_NATURAL_KEY')
    if (row.lead_id != null && !targetLeadIds.has(String(row.lead_id))) hard_reasons.push('MISSING_TARGET_LEAD_PARENT')
    if (receiptId != null && !availableReceiptIds.has(String(receiptId))) hard_reasons.push('MISSING_RECEIPT_PARENT')
    const eventType = String(row.event_type ?? '').toLowerCase()
    if (/(^|_)(test|canary|runtime)(_|$)/.test(eventType)) manual_review_reasons.push('RUNTIME_OR_TEST_ACTIVITY')
    const createdAtMs = timestampMs(row.created_at)
    if (receiptId == null && (createdAtMs === null || createdAtMs > Date.parse(PHASE1_BASELINE.activity_max_created_at))) manual_review_reasons.push('NEW_OR_UNDATED_UNRELATED_ACTIVITY_AFTER_PHASE1')
    return { row, id, natural_key: key, receipt_id: receiptId, hard_reasons, manual_review_reasons }
  })
  const rejectedActivity = activityAssessment.filter(item => item.hard_reasons.length).map(({ row: _row, ...item }) => item)
  const manualReviewActivity = activityAssessment.filter(item => !item.hard_reasons.length && item.manual_review_reasons.length).map(({ row: _row, ...item }) => item)
  const safeActivity = activityAssessment.filter(item => !item.hard_reasons.length && !item.manual_review_reasons.length).map(item => item.row).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const activityTargetIdConflicts = v1Activity.flatMap(row => {
    const other = v2ActivityById.get(String(row.id))
    return other && semantic(row, activitySpec.columns) !== semantic(other, activitySpec.columns)
      ? [{ id: row.id, changed_fields: changedFields(row, other, activitySpec.columns) }]
      : []
  })

  const insertEntry = (row: Row, spec: TableSpec, naturalKeys: Row[]): Row => {
    const sourceRow = exactColumns(row, spec.columns)
    const targetRow = { ...sourceRow, workspace_id: WORKSPACE_ID }
    return {
      id: row.id,
      natural_keys: naturalKeys,
      canonical_source_sha256: sha256(sourceRow),
      canonical_target_sha256: sha256(targetRow),
    }
  }
  const inboundEntries = safeInbound.map(row => insertEntry(row, inboundSpec, [{ name: 'receipt_key', value: row.receipt_key }]))
  const activityEntries = safeActivity.map(row => {
    const key = activityNaturalKey(row)
    return insertEntry(row, activitySpec, key === null ? [] : [{ name: 'event_type+inbound_receipt_id', value: key }])
  })
  const skippedEmailEntries = emailDedupe.skipped
    .map(row => ({ id: row.id, canonical_source_sha256: sha256(exactColumns(row, emailSpec.columns)) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const leadExclusions = mismatchedLeads.map(item => {
    const id = String(item.id)
    return {
      id,
      disposition: 'DEFER_MANUAL_REVIEW',
      canonical_v1_sha256: sha256(exactColumns(v1Leads.get(id)!, leadSpec.columns)),
      canonical_v2_sha256: sha256(exactColumns(v2Leads.get(id)!, leadSpec.columns)),
      changed_fields: item.changed_fields,
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const ownershipExclusions = [...v1Ownership].flatMap(([key, v1row]) => {
    const v2row = v2Ownership.get(key)
    if (!v2row || semantic(v1row, ownershipSpec.columns) === semantic(v2row, ownershipSpec.columns)) return []
    return [{
      normalized_email_sha256: sha256(key),
      disposition: 'DEFER_CONFLICT',
      canonical_v1_sha256: sha256(exactColumns(v1row, ownershipSpec.columns)),
      canonical_v2_sha256: sha256(exactColumns(v2row, ownershipSpec.columns)),
      v1_owner_lead_id: v1row.owner_lead_id,
      v2_owner_lead_id: v2row.owner_lead_id,
    }]
  }).sort((a, b) => a.normalized_email_sha256.localeCompare(b.normalized_email_sha256))

  const effectiveV1Emails = emailDedupe.effective
  const effectiveV1EmailById = new Map(effectiveV1Emails.map(row => [String(row.id), row]))
  const v2EmailById = new Map((target.get('emails') ?? []).map(row => [String(row.id), row]))
  const sourceOnlyEmails = effectiveV1Emails.filter(row => !v2EmailById.has(String(row.id)))
  const targetOnlyEmails = [...v2EmailById].filter(([id]) => !effectiveV1EmailById.has(id)).map(([, row]) => row)
  const mismatchedEmails = effectiveV1Emails.flatMap(row => {
    const other = v2EmailById.get(String(row.id))
    if (!other || semantic(row, emailSpec.columns) === semantic(other, emailSpec.columns)) return []
    return [{ id: row.id, changed_fields: changedFields(row, other, emailSpec.columns), canonical_v1_sha256: sha256(exactColumns(row, emailSpec.columns)), canonical_v2_sha256: sha256(exactColumns(other, emailSpec.columns)) }]
  })
  const matchingEmailCount = effectiveV1Emails.length - sourceOnlyEmails.length - mismatchedEmails.length
  const phase1EmailMaxMs = Date.parse(PHASE1_BASELINE.email_max_created_at)
  const phase1ReconstructedSkippedIds = emailDedupe.skipped.filter(row => {
    const value = timestampMs(row.created_at)
    return value !== null && value <= phase1EmailMaxMs
  }).map(row => String(row.id)).sort()
  const addedSkippedIds = emailDedupe.skipped.filter(row => {
    const value = timestampMs(row.created_at)
    return value !== null && value > phase1EmailMaxMs
  }).map(row => String(row.id)).sort()
  const unclassifiedSkippedIds = emailDedupe.skipped.filter(row => timestampMs(row.created_at) === null).map(row => String(row.id)).sort()
  const removedSkippedCount = Math.max(0, PHASE1_BASELINE.skipped_email_drafts - phase1ReconstructedSkippedIds.length)
  const dedupComparison = {
    previous: PHASE1_BASELINE.skipped_email_drafts,
    current: skippedEmailEntries.length,
    drift: skippedEmailEntries.length - PHASE1_BASELINE.skipped_email_drafts,
    comparison_basis: 'Phase 1 report count plus its documented maximum email created_at; Phase 1 did not persist the 267 IDs',
    added_skipped_ids: addedSkippedIds,
    unclassified_skipped_ids: unclassifiedSkippedIds,
    removed_skipped_ids: [] as string[],
    removed_skipped_ids_unavailable_count: removedSkippedCount,
    current_ids: skippedEmailEntries.map(entry => entry.id),
    current_set_sha256: sha256(skippedEmailEntries),
    algorithm_ambiguities: emailDedupe.ambiguities,
  }
  const previousLeadIdSet = new Set(PHASE1_DEFERRED_LEAD_IDS)
  const currentLeadIdSet = new Set(leadExclusions.map(item => item.id))
  const leadConflictDrift = {
    previous: PHASE1_DEFERRED_LEAD_IDS,
    still_existing: PHASE1_DEFERRED_LEAD_IDS.filter(id => currentLeadIdSet.has(id)),
    resolved: PHASE1_DEFERRED_LEAD_IDS.filter(id => !currentLeadIdSet.has(id)),
    new: leadExclusions.filter(item => !previousLeadIdSet.has(item.id)).map(item => item.id),
  }
  const stillOwnership = ownershipExclusions.filter(item => PHASE1_OWNERSHIP_TARGET_OWNER_IDS.has(String(item.v2_owner_lead_id)))
  const stillOwnershipOwnerIds = new Set(stillOwnership.map(item => String(item.v2_owner_lead_id)))
  const ownershipConflictDrift = {
    previous_count: 2,
    previous_reference: 'Phase 1 target owner IDs (recipient addresses were intentionally not persisted)',
    still_existing: stillOwnership,
    resolved_previous_target_owner_ids: [...PHASE1_OWNERSHIP_TARGET_OWNER_IDS].filter(id => !stillOwnershipOwnerIds.has(id)),
    new: ownershipExclusions.filter(item => !PHASE1_OWNERSHIP_TARGET_OWNER_IDS.has(String(item.v2_owner_lead_id))),
  }

  const workspaceScope = (output.integrity as Row).workspace_scope as Record<string, Row>
  const crossWorkspaceRows = Object.values(workspaceScope).reduce((sum, counts) => sum + Number(counts.other_workspace ?? 0) + Number(counts.null_workspace ?? 0), 0)
  const sourceOrphans = numericTotal((output.integrity as Row).source_orphans)
  const targetOrphans = numericTotal((output.integrity as Row).target_orphans)
  const suppressionCounts = output.suppression as Row
  const suppressionWeakening = [
    'v1_lead_suppression_missing_in_v2',
    'v1_delivery_suppression_missing_in_v2',
    'lead_suppression_disagreements_manual_review',
    'v1_terminal_email_suppression_missing_in_v2',
  ].reduce((sum, key) => sum + Number(suppressionCounts[key] ?? 0), 0)
  const naturalKeyConflicts = Object.values(tableOutput).reduce((sum, table) => sum + numericTotal(table.natural_key_conflicts), 0)
  const v2SystemActive = v2ByKey.get('system_active')?.value
  const invariantCounts = {
    effective_v1_emails: emailDedupe.effective.length,
    effective_v2_matching_emails: matchingEmailCount,
    source_only_effective_emails: sourceOnlyEmails.length,
    target_only_emails: targetOnlyEmails.length,
    mismatched_effective_emails: mismatchedEmails.length,
    current_email_dedup_ids: skippedEmailEntries.length,
    suppression_weakening: suppressionWeakening,
    source_fk_orphans: sourceOrphans,
    target_fk_orphans: targetOrphans,
    cross_or_null_workspace_rows: crossWorkspaceRows,
    natural_key_conflicts: naturalKeyConflicts,
    source_only_inbound_receipts: sourceOnlyInbound.length,
    safe_terminal_inbound_receipts: safeInbound.length,
    rejected_source_only_inbound_receipts: rejectedInbound.length,
    inbound_target_id_conflicts: inboundTargetIdConflicts.length,
    source_only_activity_rows: sourceOnlyActivity.length,
    safe_activity_rows: safeActivity.length,
    rejected_source_only_activity_rows: rejectedActivity.length,
    manual_review_activity_rows: manualReviewActivity.length,
    activity_target_id_conflicts: activityTargetIdConflicts.length,
    deferred_leads: leadExclusions.length,
    deferred_ownership_conflicts: ownershipExclusions.length,
  }
  const exactReconciliation = Object.fromEntries(specs.map(spec => {
    const sourceRows = sourceEffective.get(spec.name) ?? []
    const targetRows = target.get(spec.name) ?? []
    const sourceById = new Map(sourceRows.map(row => [spec.key(row), row]))
    const targetById = new Map(targetRows.map(row => [spec.key(row), row]))
    const renderKey = (key: string) => safeKey(spec, key)
    return [spec.name, {
      source_only_ids: [...sourceById.keys()].filter(key => !targetById.has(key)).map(renderKey).sort(),
      target_only_ids: [...targetById.keys()].filter(key => !sourceById.has(key)).map(renderKey).sort(),
      value_mismatches: [...sourceById].flatMap(([key, row]) => {
        const other = targetById.get(key)
        return other && semantic(row, spec.columns) !== semantic(other, spec.columns)
          ? [{ key: renderKey(key), changed_fields: changedFields(row, other, spec.columns) }]
          : []
      }),
    }]
  }))
  const emailDelta = {
    phase1_effective_count: PHASE1_BASELINE.effective_emails,
    current_effective_v1_count: effectiveV1Emails.length,
    effective_count_drift: effectiveV1Emails.length - PHASE1_BASELINE.effective_emails,
    effective_v2_matching_count: matchingEmailCount,
    source_only: sourceOnlyEmails.map(row => ({ id: row.id, created_at: row.created_at, status: row.status, canonical_source_sha256: sha256(exactColumns(row, emailSpec.columns)), disposition: 'NEW_DELTA_REQUIRING_REVIEW' })),
    target_only: targetOnlyEmails.map(row => ({ id: row.id, created_at: row.created_at, status: row.status, canonical_target_sha256: sha256(exactColumns(row, emailSpec.columns)) })),
    mismatched: mismatchedEmails,
    fully_reconciled_for_insert_only_phase2a: sourceOnlyEmails.length === 0 && mismatchedEmails.length === 0,
  }
  const driftReport = {
    emails: emailDelta,
    email_dedup: dedupComparison,
    inbound_receipts: { previous_safe: PHASE1_BASELINE.safe_inbound_receipts, current_safe: safeInbound.length, drift: safeInbound.length - PHASE1_BASELINE.safe_inbound_receipts, source_only: sourceOnlyInbound.length, rejected: rejectedInbound },
    activity_log: { previous_safe: PHASE1_BASELINE.safe_activity_log, current_safe: safeActivity.length, drift: safeActivity.length - PHASE1_BASELINE.safe_activity_log, source_only: sourceOnlyActivity.length, rejected: rejectedActivity, manual_review: manualReviewActivity },
    leads: leadConflictDrift,
    ownership: ownershipConflictDrift,
  }
  const safetyGates: Record<string, SafetyGate> = {
    seed_workspace_present: { passed: v2WorkspaceIds.has(WORKSPACE_ID), required: WORKSPACE_ID, observed: v2WorkspaceIds.has(WORKSPACE_ID) ? WORKSPACE_ID : null },
    effective_email_history_reconciled: { passed: sourceOnlyEmails.length === 0 && mismatchedEmails.length === 0, required: { source_only: 0, mismatched: 0 }, observed: { source_only: sourceOnlyEmails.length, mismatched: mismatchedEmails.length, exact_differences: emailDelta } },
    email_dedup_algorithm_unambiguous: { passed: emailDedupe.ambiguities.length === 0, required: 0, observed: emailDedupe.ambiguities },
    suppression_weakening_zero: { passed: suppressionWeakening === 0, required: 0, observed: suppressionWeakening },
    fk_orphans_zero: { passed: sourceOrphans + targetOrphans === 0, required: 0, observed: { source: sourceOrphans, target: targetOrphans } },
    cross_or_null_workspace_rows_zero: { passed: crossWorkspaceRows === 0, required: 0, observed: { total: crossWorkspaceRows, by_table: workspaceScope } },
    v2_system_active_false: { passed: isFalseValue(v2SystemActive), required: false, observed: v2SystemActive ?? null },
    owner_create_false: { passed: catalogSafety.owner_create === false, required: false, observed: catalogSafety.owner_create },
    catalog_transaction_read_only: { passed: catalogSafety.transaction_read_only === 'on', required: 'on', observed: catalogSafety.transaction_read_only },
    inbound_source_only_rows_safe: { passed: rejectedInbound.length === 0 && inboundTargetIdConflicts.length === 0, required: { rejected: 0, target_id_conflicts: 0 }, observed: { rejected: rejectedInbound, target_id_conflicts: inboundTargetIdConflicts } },
    activity_proposed_rows_safe: { passed: rejectedActivity.length === 0 && activityTargetIdConflicts.length === 0, required: { rejected: 0, target_id_conflicts: 0 }, observed: { rejected: rejectedActivity, target_id_conflicts: activityTargetIdConflicts, manual_review_excluded: manualReviewActivity } },
    executable_tables_allowlisted: { passed: true, required: ['inbound_receipts', 'activity_log'], observed: ['inbound_receipts', 'activity_log'] },
  }
  output.phase2a = {
    mode: command.mode,
    catalog_session: catalogSafety,
    baseline_comparisons: driftReport,
    current_counts: invariantCounts,
    safety_gates: Object.fromEntries(Object.entries(safetyGates).map(([name, gate]) => [name, { ...gate, status: gate.passed ? 'PASS' : 'FAIL' }])),
    exact_reconciliation: exactReconciliation,
  }

  const snapshot: Row = {
    phase1_baselines: PHASE1_BASELINE,
    current_counts_and_drift: driftReport,
    approved_executable_counts: {
      inbound_receipts: inboundEntries.length,
      activity_log: activityEntries.length,
    },
    executable_allowlist: {
      inbound_receipts: inboundEntries,
      activity_log: activityEntries,
      all_other_tables: [],
    },
    target_pre_counts: {
      inbound_receipts: v2Inbound.length,
      activity_log: v2Activity.length,
    },
    expected_skipped_emails: {
      count: skippedEmailEntries.length,
      ids_and_hashes: skippedEmailEntries,
      canonical_set_sha256: sha256(skippedEmailEntries),
      phase1_comparison: dedupComparison,
    },
    explicitly_excluded: {
      leads: leadExclusions,
      recipient_outreach_ownership: ownershipExclusions,
      activity_log_manual_review: manualReviewActivity,
      email_new_delta_requiring_review: emailDelta,
      settings: [{ key: 'system_active', expected_v2_value: false, disposition: 'PRESERVE_V2' }],
    },
    all_discovered_mismatches: {
      mapped_tables: exactReconciliation,
      allowlisted_settings: settingDiffs,
      suppression: output.suppression,
      intentionally_excluded_tables: output.excluded,
    },
    system_active_expected_value: false,
    owner_create_expected_value: false,
    catalog_transaction_read_only: catalogSafety.transaction_read_only,
    safety_invariant_counts: invariantCounts,
  }
  const unsignedPlan: Row = {
    schema_version: PLAN_SCHEMA_VERSION,
    kind: 'FINAL_V1_V2_INSERT_ONLY_PLAN',
    generated_at: new Date().toISOString(),
    source_project_ref: V1_REF,
    target_project_ref: V2_REF,
    seed_workspace_id: WORKSPACE_ID,
    source_access: 'SELECT_ONLY',
    target_access_during_generation: 'SELECT_ONLY',
    snapshot,
    snapshot_sha256: sha256(snapshot),
    future_execution_contract: {
      order: ['verify_plan_hash', 'reverify_projects_and_invariants', 'verify_system_active_false', 'begin_v2_transaction', 'take_advisory_transaction_lock', 'reselect_all_target_ids_and_natural_keys', 'insert_inbound_receipts', 'insert_activity_log', 'run_postconditions', 'commit'],
      advisory_lock_name: ADVISORY_LOCK_NAME,
      insert_semantics: 'plain INSERT with explicit IDs and workspace_id; any conflict aborts; DO UPDATE forbidden',
      forbidden: ['V1 writes', 'deletes', 'updates', 'upserts', 'application routes', 'RPC', 'webhooks', 'providers', 'jobs', 'leads', 'emails', 'ownership', 'settings', 'categories'],
    },
    hash_algorithm: 'SHA-256 of canonical JSON (object keys sorted recursively), excluding plan_sha256',
  }
  const artifact: Row = { ...unsignedPlan, plan_sha256: sha256(unsignedPlan) }

  if (command.mode === 'audit') {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  console.log(JSON.stringify({
    mode: 'PLAN_CURRENT_AUDIT_NO_DATABASE_WRITES',
    current_counts: invariantCounts,
    drift: {
      effective_emails: { previous: PHASE1_BASELINE.effective_emails, current: effectiveV1Emails.length, drift: effectiveV1Emails.length - PHASE1_BASELINE.effective_emails },
      email_dedup: { previous: PHASE1_BASELINE.skipped_email_drafts, current: skippedEmailEntries.length, drift: skippedEmailEntries.length - PHASE1_BASELINE.skipped_email_drafts },
      inbound_receipts: { previous: PHASE1_BASELINE.safe_inbound_receipts, current: safeInbound.length, drift: safeInbound.length - PHASE1_BASELINE.safe_inbound_receipts },
      activity_log: { previous: PHASE1_BASELINE.safe_activity_log, current: safeActivity.length, drift: safeActivity.length - PHASE1_BASELINE.safe_activity_log },
      lead_conflicts: { previous: PHASE1_DEFERRED_LEAD_IDS.length, current: leadExclusions.length },
      ownership_conflicts: { previous: PHASE1_OWNERSHIP_TARGET_OWNER_IDS.size, current: ownershipExclusions.length },
    },
    failed_gates: Object.entries(safetyGates).filter(([, gate]) => !gate.passed).map(([name]) => name),
  }, null, 2))
  assertAll(safetyGates)

  if (command.mode === 'plan') {
    mkdirSync(dirname(command.path), { recursive: true })
    writeFileSync(command.path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    console.log(JSON.stringify({ mode: 'PLAN_GENERATED_NO_DATABASE_WRITES', path: command.path, plan_sha256: artifact.plan_sha256, inbound_receipts: inboundEntries.length, activity_log: activityEntries.length }, null, 2))
    return
  }

  const approvedPlan = approvedInputPlan!
  if (approvedPlan.snapshot_sha256 !== artifact.snapshot_sha256) throw new Error('Live source/target snapshot no longer matches the approved plan')
  await executeApprovedPlan(approvedPlan, source, v2env.V2_SUPABASE_DB_URL ?? '')
  console.log(JSON.stringify({ mode: 'EXECUTE_PLAN_COMPLETE', plan_sha256: approvedPlan.plan_sha256 }, null, 2))
}

main().catch(error => {
  console.error(`FINAL_DELTA_AUDIT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
