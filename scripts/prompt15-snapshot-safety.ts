import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const APPROVED_SNAPSHOT_FIELDS = new Set([
  'lead_id', 'status', 'category_id', 'manual_source', 'category_id_present',
  'has_email', 'has_business_name', 'has_category_name', 'has_city', 'has_website',
  'suppressed', 'duplicate', 'recipient_ownership', 'deal_state', 'initial_email_mode',
  'contact_discovery_complete', 'personalisation_complete', 'can_supply_template_fields',
  'template_available', 'required_template_placeholders', 'required_template_data_available',
  'initial_email_state', 'initial_sent_at', 'follow_up_1_state', 'follow_up_1_sent_at',
  'follow_up_2_state', 'follow_up_2_sent_at', 'follow_up_3_state', 'follow_up_3_sent_at',
  'reply_received', 'reply_classification', 'reactivation_enabled', 'reactivation_sent_at',
  'follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days',
  'reactivation_delay_days', 'dead_after_reactivation_days', 'as_of', 'cohorts',
  'population_total', 'population_status_total', 'population_excluded_status_total',
])

const FORBIDDEN_SQL = [
  'insert', 'update', 'delete', 'upsert', 'merge', 'truncate', 'create', 'alter',
  'drop', 'grant', 'revoke', 'comment', 'call', 'do', 'copy',
]

function codeOnly(sql: string): string {
  let output = ''
  let index = 0
  let state: 'code' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'code'
  let dollarTag = ''
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2)
    if (state === 'code') {
      const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0]
      if (pair === '--') { state = 'line'; output += '  '; index += 2; continue }
      if (pair === '/*') { state = 'block'; output += '  '; index += 2; continue }
      if (sql[index] === "'") { state = 'single'; output += ' '; index++; continue }
      if (sql[index] === '"') { state = 'double'; output += ' '; index++; continue }
      if (dollar) { state = 'dollar'; dollarTag = dollar; output += ' '.repeat(dollar.length); index += dollar.length; continue }
      output += sql[index++]
      continue
    }
    if (state === 'single' && sql[index] === "'" && sql[index + 1] === "'") { output += '  '; index += 2; continue }
    if (state === 'double' && sql[index] === '"' && sql[index + 1] === '"') { output += '  '; index += 2; continue }
    if (state === 'single' && sql[index] === "'") { state = 'code'; output += ' '; index++; continue }
    if (state === 'double' && sql[index] === '"') { state = 'code'; output += ' '; index++; continue }
    if (state === 'line' && /[\r\n]/.test(sql[index])) { state = 'code'; output += sql[index++]; continue }
    if (state === 'block' && pair === '*/') { state = 'code'; output += '  '; index += 2; continue }
    if (state === 'dollar' && sql.startsWith(dollarTag, index)) { state = 'code'; output += ' '.repeat(dollarTag.length); index += dollarTag.length; continue }
    output += /[\r\n]/.test(sql[index]) ? sql[index] : ' '
    index++
  }
  assert.equal(state, 'code', `SQL lexical scan ended inside ${state}`)
  return output
}

export function validateSnapshotQuery(sql: string): { queryHash: string } {
  const code = codeOnly(sql).trim()
  assert.match(code, /^(select|with)\b/i, 'Snapshot SQL must begin with SELECT or WITH')
  const semicolons = [...code.matchAll(/;/g)]
  assert.ok(semicolons.length <= 1 && (!semicolons.length || semicolons[0].index === code.length - 1), 'Snapshot SQL must contain exactly one statement')
  for (const keyword of FORBIDDEN_SQL) {
    assert.doesNotMatch(code, new RegExp(`\\b${keyword}\\b`, 'i'), `Forbidden SQL keyword: ${keyword}`)
  }
  assert.doesNotMatch(code, /\b(nextval|setval|pg_advisory_lock|pg_advisory_xact_lock|dblink|lo_import|lo_export|claim_[a-z0-9_]*|release_[a-z0-9_]*)\s*\(/i, 'Mutating or external function call rejected')
  assert.match(code, /\blimit\s+100\s*;?$/i, 'Snapshot SQL requires a final hard LIMIT 100')
  assert.match(code, /\bselected_ids\b[\s\S]*?\blimit\s+100\b/i, 'Selection CTE requires a hard LIMIT 100')
  return { queryHash: createHash('sha256').update(sql, 'utf8').digest('hex') }
}

export function validateSnapshotRows(rows: unknown): asserts rows is Array<Record<string, unknown>> {
  assert.ok(Array.isArray(rows), 'Snapshot rows must be an array')
  assert.ok(rows.length <= 100, 'Snapshot exceeds 100 rows')
  for (const [rowIndex, row] of rows.entries()) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row), `Row ${rowIndex} must be an object`)
    for (const key of Object.keys(row as Record<string, unknown>)) {
      assert.ok(APPROVED_SNAPSHOT_FIELDS.has(key), `Unapproved snapshot field: ${key}`)
    }
    for (const key of APPROVED_SNAPSHOT_FIELDS) {
      assert.ok(Object.hasOwn(row as Record<string, unknown>, key), `Approved snapshot field missing from row ${rowIndex}: ${key}`)
    }
  }
  const serialized = JSON.stringify(rows)
  if (/"(?:email|normalized_email|business_name|phone|address|website|city|subject|body|metadata|prompt|response|provider_message_id|api_key|credential)"\s*:/i.test(serialized)) {
    throw new Error('Forbidden sensitive field found')
  }
  const strings: string[] = []
  const collectStrings = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(collectStrings)
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collectStrings)
  }
  collectStrings(rows)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/
  for (const value of strings) {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) throw new Error('Email-address pattern found')
    if (/\b(?:https?:\/\/|www\.)\S+/i.test(value)) throw new Error('URL pattern found')
    if (!uuid.test(value) && !timestamp.test(value) && /^(?:\+?\d[\s().-]*){9,}$/.test(value)) throw new Error('Phone-like pattern found')
  }
}

if (process.argv[1]?.endsWith('prompt15-snapshot-safety.ts')) {
  const queryPath = process.argv[2]
  if (!queryPath) throw new Error('Usage: prompt15-snapshot-safety.ts <query.sql> [snapshot.json]')
  const sql = readFileSync(queryPath, 'utf8')
  const result = validateSnapshotQuery(sql)
  if (process.argv[3]) {
    const raw = readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as { rows?: unknown } | unknown[]
    validateSnapshotRows(Array.isArray(parsed) ? parsed : parsed.rows)
  }
  console.log(JSON.stringify({ status: 'PASS', ...result }))
}
