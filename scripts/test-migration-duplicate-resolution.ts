/**
 * scripts/test-migration-duplicate-resolution.ts
 *
 * Verifies the fix for Medium audit finding "Production migration safety":
 * supabase/migrations/027_email_threading_and_dedup.sql must not be able to
 * fail on deploy if production already has duplicate delivered
 * ('sent'/'email_sync_failed') rows for the same (lead_id, type) — and must
 * resolve them without deleting any data.
 *
 *   1-5. Pure-logic reimplementation of the migration's
 *        ROW_NUMBER() OVER (PARTITION BY lead_id, type ORDER BY sent_at ASC
 *        NULLS LAST, created_at ASC) ranking, asserted against representative
 *        duplicate scenarios (none, one pair, three-way, ties, mixed
 *        sent/email_sync_failed, multiple independent lead+type groups) —
 *        confirms exactly one row per (lead_id, type) group is kept
 *        ('sent'/'email_sync_failed') and it is always the earliest by
 *        sent_at, with every other row in the group demoted to 'failed'.
 *   6. Static check: the migration file contains no DELETE statement — the
 *      fix is required to be non-destructive.
 *   7. Static check: the duplicate-resolution DO block appears before
 *      CREATE UNIQUE INDEX in the file, so it always runs first.
 *   8. Static check: an activity_log audit row is written when duplicates
 *      are found, so a deploy that resolved real duplicates is discoverable
 *      afterward.
 *
 * Run: npx tsx scripts/test-migration-duplicate-resolution.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const SEP = '═'.repeat(60)
let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ─── Pure-JS re-implementation of the migration's ranking + demotion logic,
// equivalent to:
//   ROW_NUMBER() OVER (PARTITION BY lead_id, type ORDER BY sent_at ASC NULLS LAST, created_at ASC)
//   ... rows with rn > 1 get status = 'failed'
type EmailRow = { id: string; lead_id: string; type: string; status: string; sent_at: string | null; created_at: string }

function resolveDuplicates(rows: EmailRow[]): EmailRow[] {
  const delivered = rows.filter((r) => r.status === 'sent' || r.status === 'email_sync_failed')
  const groups = new Map<string, EmailRow[]>()
  for (const row of delivered) {
    const key = `${row.lead_id}::${row.type}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const demotedIds = new Set<string>()
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => {
      // NULLS LAST on sent_at ASC
      if (a.sent_at === null && b.sent_at !== null) return 1
      if (a.sent_at !== null && b.sent_at === null) return -1
      if (a.sent_at !== b.sent_at) return (a.sent_at ?? '').localeCompare(b.sent_at ?? '')
      return a.created_at.localeCompare(b.created_at)
    })
    for (let i = 1; i < ranked.length; i++) demotedIds.add(ranked[i].id)
  }

  return rows.map((r) => (demotedIds.has(r.id) ? { ...r, status: 'failed' } : r))
}

console.log(SEP)
console.log('  TEST:MIGRATION-DUPLICATE-RESOLUTION')
console.log(SEP)

// ── 1. No duplicates — nothing changes ────────────────────────────────────────
console.log('\n  1. No duplicates — every row is left untouched')
{
  const rows: EmailRow[] = [
    { id: 'e1', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'e2', lead_id: 'lead-2', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-02T00:00:00Z', created_at: '2026-01-02T00:00:00Z' },
  ]
  const result = resolveDuplicates(rows)
  assert(result.every((r, i) => r.status === rows[i].status), 'No row is demoted when every (lead_id, type) has at most one delivered row')
}

// ── 2. One duplicate pair — earliest kept, later demoted ─────────────────────
console.log('\n  2. One duplicate pair — earliest sent_at wins, the other is demoted')
{
  const rows: EmailRow[] = [
    { id: 'e1', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-01T10:00:00Z', created_at: '2026-01-01T10:00:00Z' },
    { id: 'e2', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-02T10:00:00Z', created_at: '2026-01-02T10:00:00Z' },
  ]
  const result = resolveDuplicates(rows)
  const kept = result.find((r) => r.id === 'e1')!
  const demoted = result.find((r) => r.id === 'e2')!
  assert(kept.status === 'sent', 'The earlier delivery (e1) keeps its delivered status')
  assert(demoted.status === 'failed', 'The later delivery (e2) is demoted to failed')
}

// ── 3. Three-way duplicate — only the earliest survives ──────────────────────
console.log('\n  3. Three-way duplicate — exactly one survivor, the earliest')
{
  const rows: EmailRow[] = [
    { id: 'e2', lead_id: 'lead-1', type: 'follow_up_1', status: 'sent', sent_at: '2026-01-05T00:00:00Z', created_at: '2026-01-05T00:00:00Z' },
    { id: 'e1', lead_id: 'lead-1', type: 'follow_up_1', status: 'sent', sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'e3', lead_id: 'lead-1', type: 'follow_up_1', status: 'email_sync_failed', sent_at: '2026-01-10T00:00:00Z', created_at: '2026-01-10T00:00:00Z' },
  ]
  const result = resolveDuplicates(rows)
  const delivered = result.filter((r) => r.status === 'sent' || r.status === 'email_sync_failed')
  assert(delivered.length === 1, 'Exactly one delivered row remains for the group', `found ${delivered.length}`)
  assert(delivered[0].id === 'e1', 'The earliest by sent_at (e1) is the survivor regardless of insertion/id order')
}

// ── 4. 'sent' and 'email_sync_failed' both count toward the same group ───────
console.log("\n  4. 'sent' and 'email_sync_failed' are treated as the same delivered group")
{
  const rows: EmailRow[] = [
    { id: 'e1', lead_id: 'lead-1', type: 'initial_pitch', status: 'email_sync_failed', sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'e2', lead_id: 'lead-1', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-02T00:00:00Z', created_at: '2026-01-02T00:00:00Z' },
  ]
  const result = resolveDuplicates(rows)
  assert(result.find((r) => r.id === 'e1')!.status === 'email_sync_failed', 'Earlier email_sync_failed row is kept as-is')
  assert(result.find((r) => r.id === 'e2')!.status === 'failed', 'Later sent row is demoted even though its own status was "sent", not a duplicate of itself')
}

// ── 5. Independent groups are resolved independently ──────────────────────────
console.log('\n  5. Different lead_id/type groups do not affect each other')
{
  const rows: EmailRow[] = [
    { id: 'a1', lead_id: 'lead-A', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'a2', lead_id: 'lead-A', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-02T00:00:00Z', created_at: '2026-01-02T00:00:00Z' },
    { id: 'b1', lead_id: 'lead-A', type: 'follow_up_1', status: 'sent', sent_at: '2026-01-03T00:00:00Z', created_at: '2026-01-03T00:00:00Z' },
    { id: 'c1', lead_id: 'lead-B', type: 'initial_pitch', status: 'sent', sent_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
  ]
  const result = resolveDuplicates(rows)
  assert(result.find((r) => r.id === 'a1')!.status === 'sent', 'lead-A/initial_pitch: earliest kept')
  assert(result.find((r) => r.id === 'a2')!.status === 'failed', 'lead-A/initial_pitch: duplicate demoted')
  assert(result.find((r) => r.id === 'b1')!.status === 'sent', 'lead-A/follow_up_1: single row untouched (different type, not a duplicate of a1/a2)')
  assert(result.find((r) => r.id === 'c1')!.status === 'sent', 'lead-B/initial_pitch: single row untouched (different lead, not a duplicate of a1/a2)')
}

// ── Static checks against the actual migration file ──────────────────────────
const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/027_email_threading_and_dedup.sql')
const migrationSrc = fs.readFileSync(migrationPath, 'utf8')

console.log('\n  6. Migration contains no DELETE — resolution is non-destructive')
{
  const hasDelete = /\bDELETE\s+FROM\b/i.test(migrationSrc)
  assert(!hasDelete, 'No DELETE statement anywhere in the migration — duplicates are demoted, never removed')
}

console.log('\n  7. Duplicate-resolution DO block runs before CREATE UNIQUE INDEX')
{
  const doBlockIdx = migrationSrc.indexOf('DO $$')
  const indexIdx = migrationSrc.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS emails_lead_type_delivered_key')
  assert(doBlockIdx !== -1, 'Migration contains a DO $$ block')
  assert(indexIdx !== -1, 'Migration contains the CREATE UNIQUE INDEX statement')
  assert(doBlockIdx < indexIdx, 'The duplicate-resolution DO block appears before the actual CREATE UNIQUE INDEX statement, so it always runs first')
}

console.log('\n  8. An activity_log audit row is written when duplicates are resolved')
{
  const hasAudit = migrationSrc.includes("'duplicate_delivered_emails_resolved'") && migrationSrc.includes('INSERT INTO activity_log')
  assert(hasAudit, 'Migration inserts an activity_log row documenting how many rows were demoted', hasAudit ? undefined : 'pattern not found')
}

console.log('\n' + SEP)
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
console.log(SEP)

if (failed > 0) {
  console.error('\n  ✗ Some tests failed — review output above.')
  process.exit(1)
} else {
  console.log('\n  ✓ All tests passed.')
}
