import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'

// ---------------------------------------------------------------------------
// V1 -> V2 migration rehearsal (NOT a production cutover).
//
// V1 is READ-ONLY: this module never exposes a mutation path against V1.
// V2 is the only writable environment.
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, '..')
const TARGET_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const V1_REF = 'obppfnujusqiwjhwzosv'
const V2_REF = 'ojrxfjlgjhzhdpnkyboa'
const CONFIRM_TOKEN = 'V1_TO_V2_REHEARSAL'

// ---------------------------------------------------------------------------
// Environment loading (explicit, no process.env ambiguity)
// ---------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

interface Config {
  v1Url: string
  v1Key: string
  v2Url: string
  v2Key: string
  v2DbUrl: string | undefined
}

function loadConfig(): Config {
  const v1 = parseEnvFile(resolve(ROOT, '.env.local'))
  const v2 = parseEnvFile(resolve(ROOT, '.env.v2.local'))

  const v1Url = v1.NEXT_PUBLIC_SUPABASE_URL || v1.SUPABASE_URL || ''
  const v1Key = v1.SUPABASE_SERVICE_ROLE_KEY || ''
  const v2Url = v2.NEXT_PUBLIC_SUPABASE_URL || ''
  const v2Key = v2.SUPABASE_SERVICE_ROLE_KEY || ''
  const v2DbUrl = v2.V2_SUPABASE_DB_URL || undefined

  return { v1Url, v1Key, v2Url, v2Key, v2DbUrl }
}

function decodeJwtPayload(token: string): { ref?: string; role?: string } {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Read-only V1 source client. Mutation methods are intentionally absent.
// ---------------------------------------------------------------------------

class ReadOnlyV1Source {
  private readonly db: SupabaseClient
  readonly ref: string

  constructor(url: string, key: string) {
    this.db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    const payload = decodeJwtPayload(key)
    this.ref = payload.ref ?? hostOf(url)
  }

  async select(table: string, columns: string, orderBy: string, range: { from: number; to: number }): Promise<Record<string, unknown>[]> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { data, error } = await this.db
        .from(table)
        .select(columns)
        .order(orderBy, { ascending: true })
        .range(range.from, range.to)
      if (!error) return (data ?? []) as unknown as Record<string, unknown>[]
      lastError = error
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
    throw new Error(`V1 read ${table}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  async count(table: string): Promise<number> {
    const { count, error } = await this.db.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`V1 count ${table}: ${error.message}`)
    return count ?? 0
  }
}

// ---------------------------------------------------------------------------
// Table mapping config. Every migrated row is workspace-scoped to the target.
// `columns` is the explicit V1->V2 column mapping (names are shared/identical).
// V2-only columns (workspace_id is set explicitly; category_policy_facts,
// send_envelope, categories.exclude_*, etc.) are deliberately NOT listed and
// therefore never overwritten — they keep their V2 defaults.
// ---------------------------------------------------------------------------

interface TableSpec {
  name: string
  columns: string[]
  keyColumns: string[]
  orderBy: string
  conflict: string
  fkChecks?: { column: string; parent: string; parentKey?: string }[]
}

const TABLES: TableSpec[] = [
  {
    name: 'categories',
    columns: ['id', 'name', 'halal_filter', 'cities', 'custom_cities', 'content_type', 'pitch_template', 'dm_template', 'search_keywords', 'status', 'created_at', 'updated_at', 'use_priority_suburbs', 'city_content_types'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
  },
  {
    name: 'city_suburbs',
    columns: ['id', 'city', 'suburb', 'active', 'created_at', 'last_used_at', 'priority'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
  },
  {
    name: 'category_email_templates',
    columns: ['id', 'category_id', 'template_type', 'subject_template', 'body_template', 'created_at', 'updated_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'category_id', parent: 'categories' }],
  },
  {
    name: 'category_suburb_priorities',
    columns: ['id', 'category_id', 'city_suburb_id', 'priority', 'created_at', 'updated_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'category_id', parent: 'categories' }, { column: 'city_suburb_id', parent: 'city_suburbs' }],
  },
  {
    name: 'category_suburb_search_state',
    columns: ['id', 'category_id', 'city_suburb_id', 'last_searched_at', 'exhausted_at', 'created_at', 'updated_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'category_id', parent: 'categories' }, { column: 'city_suburb_id', parent: 'city_suburbs' }],
  },
  {
    name: 'leads',
    columns: ['id', 'business_name', 'category_id', 'category_name', 'halal', 'address', 'suburb', 'city', 'state', 'phone', 'email', 'website', 'instagram_handle', 'facebook_url', 'google_rating', 'google_reviews_count', 'description', 'services', 'outreach_channel', 'status', 'deal_value', 'deal_type', 'content_created', 'payment_received', 'notes', 'created_at', 'updated_at', 'halal_confidence_score', 'halal_reasons', 'reactivation_sent_at', 'source', 'content_type', 'delivery_suppressed_emails', 'normalized_email', 'outreach_suppression_reason', 'outreach_suppressed_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'category_id', parent: 'categories' }],
  },
  {
    name: 'emails',
    columns: ['id', 'lead_id', 'type', 'subject', 'body_html', 'body_text', 'resend_id', 'status', 'sent_at', 'opened_at', 'replied_at', 'created_at', 'edited_at', 'edited_by_user', 'message_id', 'generation_source'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'lead_id', parent: 'leads' }],
  },
  {
    name: 'follow_ups',
    columns: ['id', 'lead_id', 'follow_up_number', 'scheduled_at', 'sent_at', 'email_id', 'status', 'created_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'lead_id', parent: 'leads' }, { column: 'email_id', parent: 'emails' }],
  },
  {
    name: 'deals',
    columns: ['id', 'lead_id', 'deal_value', 'deal_type', 'content_created', 'content_created_at', 'payment_received', 'payment_received_at', 'notes', 'closed_at', 'created_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'lead_id', parent: 'leads' }],
  },
  {
    name: 'dm_queue',
    columns: ['id', 'lead_id', 'platform', 'handle', 'profile_url', 'message_text', 'status', 'created_at', 'sent_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'lead_id', parent: 'leads' }],
  },
  {
    name: 'recipient_outreach_ownership',
    columns: ['normalized_email', 'owner_lead_id', 'state', 'claimed_at', 'last_activity_at', 'metadata'],
    keyColumns: ['normalized_email'],
    orderBy: 'normalized_email',
    conflict: 'workspace_id,normalized_email',
    fkChecks: [{ column: 'owner_lead_id', parent: 'leads' }],
  },
  {
    name: 'activity_log',
    columns: ['id', 'event_type', 'lead_id', 'description', 'metadata', 'created_at'],
    keyColumns: ['id'],
    orderBy: 'id',
    conflict: 'id',
    fkChecks: [{ column: 'lead_id', parent: 'leads' }],
  },
]

// NOTE: `lead_data_quality_flags` is intentionally EXCLUDED. V2 derives these
// deterministically from `leads` via the `leads_refresh_data_quality` trigger
// (which fires on lead insert/update). Migrating V1's historical flags would
// collide with the trigger-generated rows on the partial unique index
// `lead_data_quality_flags_open_key` and would duplicate derived state.

// Global (non-workspace-scoped) business settings to migrate. Runtime/infra/
// provider/spend-telemetry keys are intentionally excluded.
const SETTINGS_ALLOWLIST = [
  'active_cities',
  'blocked_business_keywords',
  'blocked_google_categories',
  'daily_dm_limit',
  'daily_followup1_limit',
  'daily_followup2_limit',
  'daily_followup3_limit',
  'daily_initial_outreach_limit',
  'daily_lead_limit',
  'daily_reactivation_limit',
  'dead_after_reactivation_days',
  'dead_lead_days',
  'digest_email',
  'enable_lead_filtering',
  'follow_up_1_days',
  'follow_up_2_days',
  'follow_up_3_days',
  'initial_email_mode',
  'reactivation_delay_days',
  'reactivation_enabled',
  'system_active',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function identityKey(row: Record<string, unknown>, keyColumns: string[]): string {
  return keyColumns.map((k) => String(row[k])).join('|')
}

// V2 enforces "one open/delivered email per (lead_id, type)" via a partial
// unique index on (workspace_id, lead_id, type) WHERE status IN
// ('pending_send','sending','sent','delivery_uncertain','email_sync_failed').
// V1's historical data can hold a redundant 'pending_send' draft alongside an
// already-'sent' email for the same lead/phase. We keep the delivered ('sent')
// record and drop the redundant draft so the V2 invariant is preserved without
// converting any historical 'sent' row back to 'pending_send'.
const EMAIL_NON_TERMINAL = new Set(['pending_send', 'sent', 'email_sync_failed'])

function dedupeEmailNonTerminal(rows: Record<string, unknown>[]): { keep: Record<string, unknown>[]; skippedCount: number } {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const r of rows) {
    if (!EMAIL_NON_TERMINAL.has(String(r.status))) continue
    const key = `${String(r.lead_id)}|${String(r.type)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  const skipIds = new Set<string>()
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    const sent = group.filter((r) => r.status === 'sent')
    const keepOne = sent.length ? sent[0] : group[0]
    for (const r of group) {
      if (String(r.id) !== String(keepOne.id)) skipIds.add(String(r.id))
    }
  }
  return { keep: rows.filter((r) => !skipIds.has(String(r.id))), skippedCount: skipIds.size }
}

const readCache = new Map<string, Record<string, unknown>[]>()

async function readAllOrdered(
  source: ReadOnlyV1Source,
  spec: TableSpec,
): Promise<Record<string, unknown>[]> {
  const cached = readCache.get(spec.name)
  if (cached) return cached
  const rows: Record<string, unknown>[] = []
  const PAGE = 1000
  let from = 0
  for (;;) {
    const batch = await source.select(spec.name, spec.columns.join(','), spec.orderBy, { from, to: from + PAGE - 1 })
    rows.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  // re-sort by the natural key so checksums are stable regardless of API order
  rows.sort((a, b) => (identityKey(a, spec.keyColumns) < identityKey(b, spec.keyColumns) ? -1 : 1))
  readCache.set(spec.name, rows)
  return rows
}

async function readAllV2Keys(v2db: SupabaseClient, table: string, keyCol: string): Promise<string[]> {
  const keys: string[] = []
  const PAGE = 1000
  let from = 0
  for (;;) {
    const { data, error } = await v2db
      .from(table)
      .select(keyCol)
      .eq('workspace_id', TARGET_WORKSPACE_ID)
      .order(keyCol, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table} ${keyCol} read: ${error.message}`)
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    keys.push(...rows.map((r) => String(r[keyCol])))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return keys.sort()
}

async function withV2Pg<T>(v2DbUrl: string | undefined, cb: (client: pg.Client) => Promise<T>): Promise<T> {
  if (!v2DbUrl) throw new Error('V2_SUPABASE_DB_URL is required for this operation.')
  const client = new pg.Client({ connectionString: v2DbUrl })
  await client.connect()
  try {
    return await cb(client)
  } finally {
    await client.end()
  }
}

async function upsertWithRetry(
  v2db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  retries = 4,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { error } = await v2db.from(table).upsert(rows, { onConflict, ignoreDuplicates: true })
    if (!error) return
    if (attempt === retries) throw error
    await new Promise((r) => setTimeout(r, 1000 * attempt))
  }
}

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

function assertGuards(cfg: Config): void {
  const v1Host = hostOf(cfg.v1Url)
  const v2Host = hostOf(cfg.v2Url)
  const v1Payload = decodeJwtPayload(cfg.v1Key)

  if (!cfg.v1Url || !cfg.v1Key) throw new Error('Missing V1 credentials (.env.local).')
  if (!cfg.v2Url || !cfg.v2Key) throw new Error('Missing V2 credentials (.env.v2.local).')

  if (!v1Host.includes(V1_REF)) throw new Error(`V1 URL host ${v1Host} does not match expected ref ${V1_REF}.`)
  if (!v2Host.includes(V2_REF)) throw new Error(`V2 URL host ${v2Host} does not match expected ref ${V2_REF}.`)

  if (v1Payload.ref !== V1_REF) {
    throw new Error(`V1 service key ref ${v1Payload.ref ?? '(undecodable)'} is not the expected V1 ref ${V1_REF}.`)
  }
  if (v1Payload.role !== 'service_role') {
    throw new Error(`V1 key role ${v1Payload.role ?? '(undecodable)'} is not service_role.`)
  }

  if (v1Host === v2Host || cfg.v1Url === cfg.v2Url) {
    throw new Error('Refusing to run: V1 source and V2 target resolve to the same project.')
  }
}

// ---------------------------------------------------------------------------
// Preview (zero V2 writes)
// ---------------------------------------------------------------------------

async function runPreview(source: ReadOnlyV1Source, v2db: SupabaseClient): Promise<void> {
  console.log('=== V1 -> V2 MIGRATION PREVIEW (zero target writes) ===\n')

  // Build parent ID sets for FK checks.
  const parentIdSets: Record<string, Set<string>> = {}
  for (const spec of TABLES) {
    if (spec.name === 'categories' || spec.name === 'city_suburbs' || spec.name === 'leads' || spec.name === 'emails') {
      const rows = await readAllOrdered(source, spec)
      parentIdSets[spec.name] = new Set(rows.map((r) => String(r.id)))
    }
  }
  // Parent sets for the remaining referenced tables (already covered above):
  // categories, city_suburbs, leads, emails are the only parents in fkChecks.

  let totalInsert = 0
  let totalSkip = 0
  const warnings: string[] = []

  for (const spec of TABLES) {
    const rawRows = await readAllOrdered(source, spec)
    let v1Rows = rawRows
    let dedupSkipped = 0
    if (spec.name === 'emails') {
      const d = dedupeEmailNonTerminal(rawRows)
      v1Rows = d.keep
      dedupSkipped = d.skippedCount
    }
    const v1Count = v1Rows.length

    const { count: v2Count } = await v2db.from(spec.name).select('*', { count: 'exact', head: true })

    // Existing V2 IDs within the target workspace.
    const keyCol = spec.name === 'recipient_outreach_ownership' ? 'normalized_email' : 'id'
    const existingIds = new Set(await readAllV2Keys(v2db, spec.name, keyCol))

    let insert = 0
    let skip = 0
    for (const row of v1Rows) {
      const key = identityKey(row, spec.keyColumns)
      if (existingIds.has(key)) skip += 1
      else insert += 1
    }

    // FK integrity within the V1 snapshot.
    let missingFk = 0
    if (spec.fkChecks) {
      for (const check of spec.fkChecks) {
        const parent = parentIdSets[check.parent]
        if (!parent) continue
        for (const row of v1Rows) {
          const val = row[check.column]
          if (val !== null && val !== undefined && !parent.has(String(val))) missingFk += 1
        }
      }
    }

    totalInsert += insert
    totalSkip += skip

    console.log(`${spec.name}:`)
    console.log(`  V1 source=${v1Count}  V2 target=${v2Count ?? '?'}  to_insert=${insert}  to_skip(already present)=${skip}${dedupSkipped ? `  dedup_skipped=${dedupSkipped}` : ''}${missingFk ? `  MISSING_FK=${missingFk}` : ''}`)
    if (dedupSkipped) warnings.push(`${spec.name}: ${dedupSkipped} redundant non-terminal (lead,type) emails skipped (kept the delivered 'sent' record) to satisfy V2's one-open/delivered-per-phase invariant.`)
    if (missingFk) warnings.push(`${spec.name}: ${missingFk} rows reference a parent id missing from the V1 snapshot (would violate V2 FK).`)
    if (v1Count === 0) warnings.push(`${spec.name}: no V1 rows (table empty).`)
  }

  // Settings preview.
  {
    const v1Rows = await readAllOrdered(source, { name: 'settings', columns: ['id', 'key', 'value', 'description', 'updated_at'], keyColumns: ['key'], orderBy: 'key', conflict: 'key' })
    const migrated = v1Rows.filter((r) => SETTINGS_ALLOWLIST.includes(String(r.key)))
    const excluded = v1Rows.filter((r) => !SETTINGS_ALLOWLIST.includes(String(r.key)))
    const { count: v2SettingsCount } = await v2db.from('settings').select('*', { count: 'exact', head: true })
    console.log(`\nsettings:`)
    console.log(`  V1 source=${v1Rows.length}  migrate(business allowlist)=${migrated.length}  exclude(runtime/infra)=${excluded.length}  V2 target=${v2SettingsCount ?? '?'}`)
    console.log(`  excluded keys: ${excluded.map((r) => String(r.key)).sort().join(', ')}`)
  }

  // Cross-check V2 test data that will remain untouched.
  console.log('\n=== V2 disposable test data (remains untouched; no ID overlap with V1) ===')
  const testTables = ['categories', 'city_suburbs', 'leads', 'emails', 'follow_ups', 'category_email_templates', 'activity_log', 'recipient_outreach_ownership']
  for (const t of testTables) {
    const { count } = await v2db.from(t).select('*', { count: 'exact', head: true })
    console.log(`  ${t}: ${count ?? '?'}`)
  }

  // Duplicate resend_id check (V2 unique (workspace_id, resend_id)).
  const resendIds = new Set<string>()
  let dupResend = 0
  for (const row of await readAllOrdered(source, TABLES.find((t) => t.name === 'emails')!)) {
    const rid = row.resend_id
    if (rid === null || rid === undefined) continue
    if (resendIds.has(String(rid))) dupResend += 1
    else resendIds.add(String(rid))
  }
  if (dupResend) warnings.push(`emails: ${dupResend} duplicate non-null resend_id values would violate V2 unique (workspace_id, resend_id).`)

  console.log(`\n=== TOTALS ===`)
  console.log(`  rows_to_insert=${totalInsert}  rows_already_present=${totalSkip}`)
  if (warnings.length) {
    console.log('\n=== WARNINGS ===')
    for (const w of warnings) console.log(`  - ${w}`)
  } else {
    console.log('\nNo warnings.')
  }
}

// ---------------------------------------------------------------------------
// Execution (V2 writes; requires confirm token)
// ---------------------------------------------------------------------------

async function runExecute(source: ReadOnlyV1Source, v2db: SupabaseClient): Promise<void> {
  if (process.env.MIGRATION_REHEARSAL_CONFIRM !== CONFIRM_TOKEN) {
    throw new Error(`Refusing writes: set MIGRATION_REHEARSAL_CONFIRM=${CONFIRM_TOKEN} to run the rehearsal.`)
  }

  const BATCH = 500
  const results: Record<string, { inserted: number; skipped: number; errors: number }> = {}

  for (const spec of TABLES) {
    const rawRows = await readAllOrdered(source, spec)
    let rows = rawRows
    let dedupSkipped = 0
    if (spec.name === 'emails') {
      const d = dedupeEmailNonTerminal(rawRows)
      rows = d.keep
      dedupSkipped = d.skippedCount
    }
    results[spec.name] = { inserted: 0, skipped: dedupSkipped, errors: 0 }
    if (rows.length === 0) {
      console.log(`${spec.name}: 0 rows (skip)`)
      continue
    }
    const mapped = rows.map((row) => {
      const out: Record<string, unknown> = { workspace_id: TARGET_WORKSPACE_ID }
      for (const col of spec.columns) out[col] = row[col]
      return out
    })
    for (let i = 0; i < mapped.length; i += BATCH) {
      const chunk = mapped.slice(i, i + BATCH)
      try {
        await upsertWithRetry(v2db, spec.name, chunk, spec.conflict)
      } catch (error) {
        results[spec.name].errors += 1
        throw new Error(`${spec.name} upsert failed at batch ${i / BATCH}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    results[spec.name].inserted = mapped.length
    console.log(`${spec.name}: processed ${mapped.length} rows (ON CONFLICT DO NOTHING; conflicts skipped)${dedupSkipped ? ` [${dedupSkipped} dedup skipped]` : ''}`)
  }

  // Settings (allowlist only).
  {
    const all = await readAllOrdered(source, { name: 'settings', columns: ['id', 'key', 'value', 'description', 'updated_at'], keyColumns: ['key'], orderBy: 'key', conflict: 'key' })
    const migrated = all.filter((r) => SETTINGS_ALLOWLIST.includes(String(r.key)))
    const mapped = migrated.map((r) => ({
      key: r.key,
      value: r.value,
      description: r.description,
      updated_at: r.updated_at,
    }))
    if (mapped.length) {
      await upsertWithRetry(v2db, 'settings', mapped, 'key')
    }
    console.log(`settings: processed ${mapped.length} business settings (ON CONFLICT DO NOTHING)`)
  }

  console.log('\n=== EXECUTION SUMMARY ===')
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}: inserted=${r.inserted} errors=${r.errors}`)
  }
}

// ---------------------------------------------------------------------------
// Validation (read-only, V1 vs migrated V2)
// ---------------------------------------------------------------------------

async function runValidate(source: ReadOnlyV1Source, v2db: SupabaseClient, cfg: Config): Promise<void> {
  console.log('=== V1 -> V2 VALIDATION ===\n')

  const effectiveRows: Record<string, Record<string, unknown>[]> = {}

  for (const spec of TABLES) {
    const rawRows = await readAllOrdered(source, spec)
    const v1Rows = spec.name === 'emails' ? dedupeEmailNonTerminal(rawRows).keep : rawRows
    effectiveRows[spec.name] = v1Rows
    const v1Count = v1Rows.length
    const v1Ids = v1Rows.map((r) => identityKey(r, spec.keyColumns)).sort()

    const keyCol = spec.name === 'recipient_outreach_ownership' ? 'normalized_email' : 'id'
    const v2Ids = await readAllV2Keys(v2db, spec.name, keyCol)
    const v1Set = new Set(v1Ids)
    const v2Set = new Set(v2Ids)
    const missing = v1Ids.filter((id) => !v2Set.has(id)).length
    const extra = v2Ids.filter((id) => !v1Set.has(id)).length
    const allPresent = missing === 0

    console.log(`${spec.name}: V1=${v1Count} V2=${v2Ids.length} all_V1_present=${allPresent ? 'YES' : 'NO'} missing=${missing} extra(pre-existing V2 test data)=${extra} hash=${sha256(v1Ids.join('\n')).slice(0, 12)}/${sha256(v2Ids.join('\n')).slice(0, 12)}`)
    if (!allPresent) console.log(`   -> ${missing} V1 rows missing from V2`)
  }

  // Status/type distribution comparison for the high-signal columns.
  console.log('\n--- distribution checks ---')
  function distributionV1(table: string, col: string): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of effectiveRows[table] ?? []) {
      const k = r[col] === null || r[col] === undefined ? '<null>' : String(r[col])
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  }
  async function distributionV2(table: string, col: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    const PAGE = 1000
    let from = 0
    for (;;) {
      const { data, error } = await v2db.from(table).select(col).eq('workspace_id', TARGET_WORKSPACE_ID).order(col, { ascending: true }).range(from, from + PAGE - 1)
      if (error) throw new Error(`${table} ${col}: ${error.message}`)
      const rows = (data ?? []) as unknown as Record<string, unknown>[]
      for (const r of rows) {
        const k = r[col] === null || r[col] === undefined ? '<null>' : String(r[col])
        out[k] = (out[k] ?? 0) + 1
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
    return out
  }

  const distChecks: [string, string][] = [
    ['leads', 'status'],
    ['emails', 'status'],
    ['emails', 'type'],
    ['follow_ups', 'status'],
    ['follow_ups', 'follow_up_number'],
    ['dm_queue', 'status'],
    ['recipient_outreach_ownership', 'state'],
  ]
  for (const [table, col] of distChecks) {
    const a = distributionV1(table, col)
    const b = await distributionV2(table, col)
    const aStr = JSON.stringify(Object.entries(a).sort())
    const bStr = JSON.stringify(Object.entries(b).sort())
    console.log(`${table}.${col}: ${aStr === bStr ? 'MATCH' : 'MISMATCH'}`)
    if (aStr !== bStr) {
      console.log(`   V1=${aStr}`)
      console.log(`   V2=${bStr}`)
    }
  }

  // SQL-based integrity checks against V2 via direct Postgres.
  await withV2Pg(cfg.v2DbUrl, async (pgc) => {
    console.log('\n--- V2 workspace scope + FK/orphan/duplicate (SQL) ---')
    const scopedTables = TABLES.map((t) => t.name).filter((n) => n !== 'recipient_outreach_ownership')

    // Workspace scope: zero null, zero other-workspace rows.
    for (const t of scopedTables) {
      const { rows } = await pgc.query(
        `SELECT count(*) FILTER (WHERE workspace_id IS NULL) AS nulls,
                count(*) FILTER (WHERE workspace_id <> $1) AS other_ws,
                count(*) AS total
           FROM public.${t}`,
        [TARGET_WORKSPACE_ID],
      )
      const r = rows[0]
      console.log(`  workspace_scope ${t}: total=${r.total} null_ws=${r.nulls} other_ws=${r.other_ws} ${Number(r.nulls) === 0 && Number(r.other_ws) === 0 ? 'OK' : 'FAIL'}`)
    }
    for (const t of ['recipient_outreach_ownership']) {
      const { rows } = await pgc.query(
        `SELECT count(*) FILTER (WHERE workspace_id IS NULL) AS nulls,
                count(*) FILTER (WHERE workspace_id <> $1) AS other_ws,
                count(*) AS total
           FROM public.${t}`,
        [TARGET_WORKSPACE_ID],
      )
      const r = rows[0]
      console.log(`  workspace_scope ${t}: total=${r.total} null_ws=${r.nulls} other_ws=${r.other_ws} ${Number(r.nulls) === 0 && Number(r.other_ws) === 0 ? 'OK' : 'FAIL'}`)
    }

    // Cross-workspace FK references: child rows in the target workspace must not
    // reference parents in another workspace.
    const fkSql: [string, string, string][] = [
      ['category_email_templates', 'category_id', 'categories'],
      ['category_suburb_priorities', 'category_id', 'categories'],
      ['category_suburb_priorities', 'city_suburb_id', 'city_suburbs'],
      ['category_suburb_search_state', 'category_id', 'categories'],
      ['category_suburb_search_state', 'city_suburb_id', 'city_suburbs'],
      ['leads', 'category_id', 'categories'],
      ['emails', 'lead_id', 'leads'],
      ['follow_ups', 'lead_id', 'leads'],
      ['follow_ups', 'email_id', 'emails'],
      ['deals', 'lead_id', 'leads'],
      ['dm_queue', 'lead_id', 'leads'],
      ['recipient_outreach_ownership', 'owner_lead_id', 'leads'],
      ['activity_log', 'lead_id', 'leads'],
    ]
    for (const [child, col, parent] of fkSql) {
      const { rows } = await pgc.query(
        `SELECT count(*) AS orphans
           FROM public.${child} c
          WHERE c.workspace_id = $1 AND c.${col} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.${parent} p WHERE p.id = c.${col} AND p.workspace_id = $1)`,
        [TARGET_WORKSPACE_ID],
      )
      const orphans = Number(rows[0].orphans)
      if (orphans !== 0) console.log(`  fk_orphan ${child}.${col} -> ${parent}: ${orphans} FAIL`)
    }
    console.log('  (fk orphan checks emitted above only on failure)')

    // Duplicate detection on workspace-scoped unique keys.
    const dupChecks: [string, string][] = [
      ['emails', 'resend_id'],
    ]
    for (const [table, col] of dupChecks) {
      const { rows } = await pgc.query(
        `SELECT count(*) AS dupes FROM (SELECT ${col} FROM public.${table} WHERE workspace_id = $1 AND ${col} IS NOT NULL GROUP BY ${col} HAVING count(*) > 1) d`,
        [TARGET_WORKSPACE_ID],
      )
      console.log(`  duplicate ${table}.${col}: ${rows[0].dupes} ${Number(rows[0].dupes) === 0 ? 'OK' : 'FAIL'}`)
    }
  })

  console.log('\nValidation complete.')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig()
  assertGuards(cfg)

  const source = new ReadOnlyV1Source(cfg.v1Url, cfg.v1Key)
  const v2db = createClient(cfg.v2Url, cfg.v2Key, { auth: { autoRefreshToken: false, persistSession: false } })

  const mode = process.argv.includes('--execute') ? 'execute' : process.argv.includes('--validate') ? 'validate' : 'preview'

  console.log(`[guards] V1 ref=${source.ref} (expected ${V1_REF}); V2 host=${hostOf(cfg.v2Url)}; mode=${mode}\n`)

  if (mode === 'preview') await runPreview(source, v2db)
  else if (mode === 'execute') await runExecute(source, v2db)
  else await runValidate(source, v2db, cfg)
}

main().catch((error) => {
  console.error(`MIGRATION_REHEARSAL_FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
