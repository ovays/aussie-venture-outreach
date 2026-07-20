/**
 * scripts/test-writer-dedupe-index-refresh.ts
 *
 * Verifies the production-readiness-audit fix for a stale-dedupe-index bug:
 * the Writer stage (agents/writer.ts) fetches one LeadDedupeIndex snapshot
 * for the whole batch, then loops writeOneLead() over every researched lead.
 * Before this fix, writeOneLead() never registered the lead it just queued
 * an email for back into that shared index — so if two different leads in
 * the same batch resolved to the same email/root domain (e.g. two Google
 * Maps listings for one franchise), BOTH would pass checkLeadDedupe() and
 * both would get an outreach email queued, i.e. a real duplicate cold email
 * to one external recipient.
 *
 * The fix (src/lib/write-lead.ts) calls addLeadToDedupeIndex() right after
 * successfully queuing the email, before writeOneLead() returns — so any
 * later lead in the same batch iteration sees it.
 *
 *   1. Dynamic: replays the exact index-update sequence writeOneLead() now
 *      performs and proves a same-batch duplicate is caught by the SECOND
 *      lookup, not just against leads that existed before the batch started.
 *   2. Static: confirms src/lib/write-lead.ts actually calls
 *      addLeadToDedupeIndex() after a successful email insert and before
 *      returning success — i.e. the fix is wired in, not just provably
 *      correct in isolation.
 *
 * Run: npx tsx scripts/test-writer-dedupe-index-refresh.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  addLeadToDedupeIndex,
  checkLeadDedupe,
  createLeadDedupeIndex,
  type DedupeLead,
} from '../src/lib/deduplication'

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

async function main() {
  console.log(SEP)
  console.log('  TEST:WRITER-DEDUPE-INDEX-REFRESH')
  console.log(SEP)

  // ── 1. Same-batch duplicate is caught once the index is refreshed ──────────
  console.log('\n  1. A second lead in the same batch, sharing an email with the first, is caught')
  {
    // Batch fetched once at the start of the Writer run — mirrors
    // fetchPipelineDedupeIndex() returning leads that existed BEFORE this run.
    const preExisting: DedupeLead[] = [
      { id: 'lead-other', business_name: 'Unrelated Cafe', email: 'hello@unrelated.com.au', status: 'contacted' },
    ]
    const dedupeIndex = createLeadDedupeIndex(preExisting)

    const franchiseA: DedupeLead = { id: 'lead-A', business_name: 'Franchise Bondi', email: 'info@franchise.com.au', status: 'researched' }
    const franchiseB: DedupeLead = { id: 'lead-B', business_name: 'Franchise Manly', email: 'info@franchise.com.au', status: 'researched' }

    // Lead A is processed first: not a duplicate against the pre-existing index.
    const decisionA = checkLeadDedupe(franchiseA.email, dedupeIndex, franchiseA.id)
    assert(decisionA.duplicate === false, 'First franchise lead (A) is not a duplicate — nothing has claimed this email yet')

    // This is the exact call the fix adds to write-lead.ts, right after
    // successfully queuing A's email — BEFORE the loop moves on to B.
    addLeadToDedupeIndex(dedupeIndex, franchiseA)

    // Lead B is processed next, in the SAME batch/run, same shared index.
    const decisionB = checkLeadDedupe(franchiseB.email, dedupeIndex, franchiseB.id)
    assert(decisionB.duplicate === true, 'Second franchise lead (B), same email, same batch, is now caught as a duplicate')
    assert(
      decisionB.duplicate && decisionB.reason === 'DUPLICATE_EMAIL_SKIPPED' && decisionB.match.id === 'lead-A',
      'B is flagged specifically against A (the same-batch write), not the pre-existing unrelated lead'
    )
  }

  // ── 2. Without the fix, the same scenario would NOT be caught ──────────────
  console.log('\n  2. Sanity check: omitting the addLeadToDedupeIndex call reproduces the original bug')
  {
    const dedupeIndex = createLeadDedupeIndex([])
    const franchiseA: DedupeLead = { id: 'lead-A2', business_name: 'Franchise Bondi', email: 'info@franchise2.com.au', status: 'researched' }
    const franchiseB: DedupeLead = { id: 'lead-B2', business_name: 'Franchise Manly', email: 'info@franchise2.com.au', status: 'researched' }

    checkLeadDedupe(franchiseA.email, dedupeIndex, franchiseA.id)
    // Deliberately NOT calling addLeadToDedupeIndex here, to prove the index
    // by itself does nothing automatically — the write-lead.ts call site is
    // what makes lookup #2 below actually catch this.
    const decisionB = checkLeadDedupe(franchiseB.email, dedupeIndex, franchiseB.id)
    assert(decisionB.duplicate === false, 'Confirms the index never self-updates — the explicit addLeadToDedupeIndex call is load-bearing')
  }

  // ── 3. Static: the fix is actually wired into write-lead.ts ────────────────
  console.log('\n  3. src/lib/write-lead.ts calls addLeadToDedupeIndex after queuing the email, before returning')
  {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/write-lead.ts'), 'utf8')

    assert(src.includes("addLeadToDedupeIndex, checkLeadDedupe") || /import\s*{[^}]*addLeadToDedupeIndex[^}]*}\s*from\s*'@\/lib\/deduplication'/.test(src),
      'write-lead.ts imports addLeadToDedupeIndex from @/lib/deduplication')

    const insertIdx = src.indexOf("await supabase.from('emails').insert(")
    const addToIndexIdx = src.indexOf('addLeadToDedupeIndex(dedupeIndex,')
    const returnEmailIdx = src.indexOf("return { success: true, channel: 'email' }")

    assert(insertIdx !== -1, 'write-lead.ts still inserts the queued email row')
    assert(addToIndexIdx !== -1, 'write-lead.ts calls addLeadToDedupeIndex(dedupeIndex, ...)')
    assert(returnEmailIdx !== -1, "write-lead.ts still returns { success: true, channel: 'email' }")
    assert(insertIdx < addToIndexIdx, 'The index is updated only after the email insert (so a failed insert never falsely marks the email as claimed)')
    assert(addToIndexIdx < returnEmailIdx, 'The index is updated before writeOneLead returns, so the very next loop iteration sees it')
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
}

main()
