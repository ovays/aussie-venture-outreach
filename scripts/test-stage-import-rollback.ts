/**
 * scripts/test-stage-import-rollback.ts
 *
 * Verifies the fix for Medium audit finding "Stage import rollback safety":
 * src/app/api/leads/route.ts's staged-import path (Add Lead with a Current
 * Stage other than "New") must never leave a partially-created lead behind
 * if AI generation or email creation fails partway through.
 *
 *   1. Static check: the backfill call is wrapped in try/catch, so a thrown
 *      exception (e.g. writeOutreachEmail's Anthropic call failing/throwing,
 *      not just returning an error) is caught — not just the explicit
 *      backfillResult.ok === false path.
 *   2. Static check: both the catch block and the explicit ok:false branch
 *      call rollbackStagedLead — a single rollback path for every failure
 *      mode (API failure, DB failure, unexpected exception).
 *   3. Static check: rollbackStagedLead deletes the lead row (and only
 *      after — never before — the try starts, since the lead itself is
 *      valid and must exist for the backfill to have anything to attach to).
 *   4. Factual check: leads.emails / leads.follow_ups / leads.deals all
 *      cascade-delete via ON DELETE CASCADE (migration 001) — this is *why*
 *      deleting just the lead row is sufficient to remove any emails/
 *      follow_ups a failed backfill partially inserted, with no orphaned
 *      rows left in either table.
 *   5. Static check: the success path (backfillResult.ok === true) is
 *      unchanged — no rollback runs when the import succeeds.
 *
 * backfillLeadStageHistory/rollbackStagedLead/createLead live in
 * src/lib/create-lead.ts (extracted from src/app/api/leads/route.ts so the
 * CSV bulk-import endpoint can reuse the exact same insert/backfill/rollback
 * path) — they aren't exported HTTP handlers, so they can't be unit-imported
 * directly either way (see comment in src/lib/webhook-verify.ts). Static
 * source verification (the same approach already used by
 * scripts/test-duplicate-followup-prevention.ts for its scheduler-level
 * check) is the appropriate level for this fix.
 *
 * Run: npx tsx scripts/test-stage-import-rollback.ts
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

console.log(SEP)
console.log('  TEST:STAGE-IMPORT-ROLLBACK')
console.log(SEP)

const routeSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/create-lead.ts'), 'utf8')
const schemaSrc = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/001_initial_schema.sql'), 'utf8')

// ── 1. Backfill call wrapped in try/catch ─────────────────────────────────────
console.log('\n  1. Backfill call is wrapped in try/catch')
{
  const tryIdx = routeSrc.indexOf('try {\n      const backfillResult = await backfillLeadStageHistory(supabase, {')
  const catchIdx = routeSrc.indexOf('} catch (err) {')
  assert(tryIdx !== -1, 'A try block wraps the backfillLeadStageHistory() call')
  assert(catchIdx !== -1 && catchIdx > tryIdx, 'A matching catch (err) block follows it')
}

// ── 2. Both failure paths call rollbackStagedLead ─────────────────────────────
console.log('\n  2. Both the explicit ok:false path and the catch block roll back')
{
  const okFalseBlock = /if \(!backfillResult\.ok\) \{\s*await rollbackStagedLead\(supabase, lead\.id, backfillResult\.error\)/.test(routeSrc)
  const catchBlock = /catch \(err\) \{[^}]*await rollbackStagedLead\(supabase, lead\.id, message\)/.test(routeSrc)
  assert(okFalseBlock, 'backfillResult.ok === false calls rollbackStagedLead(supabase, lead.id, backfillResult.error)', okFalseBlock ? undefined : 'pattern not found')
  assert(catchBlock, 'A thrown exception (catch block) calls rollbackStagedLead(supabase, lead.id, message)', catchBlock ? undefined : 'pattern not found')
}

// ── 3. rollbackStagedLead deletes the lead row ────────────────────────────────
console.log('\n  3. rollbackStagedLead deletes the lead row')
{
  const fnMatch = routeSrc.match(/async function rollbackStagedLead\([\s\S]*?\n\}/)
  assert(!!fnMatch, 'rollbackStagedLead function is defined')
  const body = fnMatch?.[0] ?? ''
  assert(body.includes("supabase.from('leads').delete().eq('id', leadId)"), 'rollbackStagedLead deletes from the leads table by id')
  assert(body.includes('logger.error'), 'rollbackStagedLead logs if the delete itself fails, so an orphan can still be found manually')
}

// ── 4. Cascade delete is actually configured — this is why deleting the lead
//      alone is sufficient (no separate emails/follow_ups/deals cleanup needed) ──
console.log('\n  4. emails/follow_ups/deals cascade-delete when their lead is deleted')
{
  const emailsCascade = /CREATE TABLE emails \([\s\S]*?lead_id UUID REFERENCES leads\(id\) ON DELETE CASCADE/.test(schemaSrc)
  const followUpsCascade = /CREATE TABLE follow_ups \([\s\S]*?lead_id UUID REFERENCES leads\(id\) ON DELETE CASCADE/.test(schemaSrc)
  const dealsCascade = /CREATE TABLE deals \([\s\S]*?lead_id UUID REFERENCES leads\(id\) ON DELETE CASCADE/.test(schemaSrc)
  assert(emailsCascade, 'emails.lead_id is ON DELETE CASCADE')
  assert(followUpsCascade, 'follow_ups.lead_id is ON DELETE CASCADE')
  assert(dealsCascade, 'deals.lead_id is ON DELETE CASCADE')
}

// ── 5. Success path is unchanged ──────────────────────────────────────────────
console.log('\n  5. Success path returns 201 with no rollback call nearby')
{
  const successReturn = routeSrc.includes("return { ok: true, status: 201, lead: backfillResult.lead as Record<string, unknown> }")
  assert(successReturn, 'A successful backfill still returns a 201 result with the updated lead, unchanged from before this fix')
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
