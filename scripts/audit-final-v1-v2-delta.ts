import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'

const ROOT = resolve(import.meta.dirname, '..')
const V1_REF = 'obppfnujusqiwjhwzosv'
const V2_REF = 'ojrxfjlgjhzhdpnkyboa'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PAGE = 1000

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
  return fetch(input, init)
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

async function readAll(client: SupabaseClient, table: string, columns: string, workspaceScoped: boolean): Promise<Row[]> {
  const rows: Row[] = []
  for (let from = 0;; from += PAGE) {
    let query = client.from(table).select(columns).range(from, from + PAGE - 1)
    if (workspaceScoped) query = query.eq('workspace_id', WORKSPACE_ID)
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

function dedupeEmails(rows: Row[]): { effective: Row[]; skipped: Row[] } {
  const eligible = new Set(['pending_send','sent','email_sync_failed']) // exact rehearsal rule
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    if (!eligible.has(String(row.status))) continue
    const key = `${row.lead_id}|${row.type}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const skip = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const keep = group.find(row => row.status === 'sent') ?? group[0]
    for (const row of group) if (row.id !== keep.id) skip.add(String(row.id))
  }
  return { effective: rows.filter(row => !skip.has(String(row.id))), skipped: rows.filter(row => skip.has(String(row.id))) }
}

async function main(): Promise<void> {
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
    const client = new pg.Client({ connectionString: v2env.V2_SUPABASE_DB_URL, options: '-c default_transaction_read_only=on' })
    await client.connect()
    try {
      const readOnly = await client.query("SELECT current_setting('default_transaction_read_only') AS default_read_only, current_database() AS database_name, has_schema_privilege('reachagent_function_owner','public','CREATE') AS owner_create")
      const catalog = await client.query(`
        SELECT c.relname AS table_name,
               ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
               ARRAY(SELECT con.conname FROM pg_constraint con WHERE con.conrelid=c.oid ORDER BY con.conname) AS constraints,
               ARRAY(SELECT i.indexname FROM pg_indexes i WHERE i.schemaname=n.nspname AND i.tablename=c.relname ORDER BY i.indexname) AS indexes
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`, [[...specs, ...excludedSpecs].map(spec => spec.name)])
      console.log(JSON.stringify({ mode: 'SELECT_ONLY_CATALOG', identity: V2_REF, session: readOnly.rows[0], tables: catalog.rows }, null, 2))
    } finally {
      await client.end()
    }
    return
  }
  if (process.argv.includes('--focus')) {
    const [v1Settings, v2Settings, v1Activity, v2Activity, v1Inbound, v2Inbound] = await Promise.all([
      readAll(v1, 'settings', 'key,value,updated_at', false),
      readAll(v2, 'settings', 'key,value,updated_at', false),
      readAll(v1, 'activity_log', 'id,created_at', false),
      readAll(v2, 'activity_log', 'id,created_at', true),
      readAll(v1, 'inbound_receipts', 'id,updated_at', false),
      readAll(v2, 'inbound_receipts', 'id,updated_at', true),
    ])
    const gate = (rows: Row[]) => rows.find(row => row.key === 'system_active') ?? null
    console.log(JSON.stringify({ mode: 'SELECT_ONLY_FOCUS', identity: { v1: V1_REF, v2: V2_REF }, system_active: { v1: gate(v1Settings), v2: gate(v2Settings) }, settings_updated_at: { v1: extrema(v1Settings, 'updated_at'), v2: extrema(v2Settings, 'updated_at') }, activity: { v1_count: v1Activity.length, v1_max: extrema(v1Activity, 'created_at').max, v2_count: v2Activity.length, v2_max: extrema(v2Activity, 'created_at').max }, inbound_receipts: { v1_count: v1Inbound.length, v1_max_updated_at: extrema(v1Inbound, 'updated_at').max, v2_count: v2Inbound.length, v2_max_updated_at: extrema(v2Inbound, 'updated_at').max } }, null, 2))
    return
  }
  const source = new Map<string, Row[]>()
  const target = new Map<string, Row[]>()
  for (const spec of [...specs, ...excludedSpecs]) {
    source.set(spec.name, await readAll(v1, spec.name, spec.columns.join(','), false))
    target.set(spec.name, await readAll(v2, spec.name, `${spec.columns.join(',')},workspace_id`, true))
  }

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

  const v1Settings = await readAll(v1, 'settings', 'id,key,value,description,updated_at', false)
  const v2Settings = await readAll(v2, 'settings', 'id,key,value,description,updated_at', false)
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

  console.log(JSON.stringify(output, null, 2))
}

main().catch(error => {
  console.error(`FINAL_DELTA_AUDIT_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
