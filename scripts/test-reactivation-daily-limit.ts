/**
 * scripts/test-reactivation-daily-limit.ts
 *
 * Pure-unit test for the daily_reactivation_limit cap added to
 * agents/reactivation.ts — no DB, no email sends.
 *
 * Verifies:
 *   1. Remaining budget math: max(0, daily_reactivation_limit - sent_today)
 *   2. Capping: only the first N eligible leads are sent; the rest are left
 *      untouched (deferred) for the next scheduled run — same shape as the
 *      real agent's `eligibleForSend.slice(0, remainingReactivationBudget)`.
 *   3. Independence from daily_initial_outreach_limit — changing one setting
 *      never changes the other's computed budget.
 *
 * Run: npm run test:reactivation-daily-limit
 */

const SEP = '═'.repeat(68)
const DIV = '─'.repeat(68)

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// Mirrors agents/reactivation.ts's remaining-budget calculation exactly.
function computeRemainingBudget(dailyLimit: number, sentToday: number): number {
  return Math.max(0, dailyLimit - sentToday)
}

// Mirrors agents/reactivation.ts's Phase 2 capping: `eligibleForSend.slice(0, remainingBudget)`.
function applyDailyCap<T>(eligible: T[], remainingBudget: number): { toSend: T[]; deferred: T[] } {
  const toSend = eligible.slice(0, remainingBudget)
  const deferred = eligible.slice(toSend.length)
  return { toSend, deferred }
}

console.log(SEP)
console.log('  TEST:REACTIVATION-DAILY-LIMIT  —  no DB, no emails sent')
console.log(SEP)

// ── 1. Remaining budget math ──────────────────────────────────────────────────
console.log('\n' + DIV)
console.log('  1. Remaining budget = max(0, daily_reactivation_limit - sent_today)')
console.log(DIV)

const budgetCases: Array<{ label: string; dailyLimit: number; sentToday: number; expected: number }> = [
  { label: 'default limit, nothing sent yet',        dailyLimit: 10, sentToday: 0,  expected: 10 },
  { label: 'default limit, partially used',           dailyLimit: 10, sentToday: 4,  expected: 6 },
  { label: 'limit exactly reached',                   dailyLimit: 10, sentToday: 10, expected: 0 },
  { label: 'limit exceeded (e.g. manual re-run)',      dailyLimit: 10, sentToday: 15, expected: 0 },
  { label: 'limit set to 0 (feature effectively off)', dailyLimit: 0,  sentToday: 0,  expected: 0 },
]

for (const c of budgetCases) {
  const got = computeRemainingBudget(c.dailyLimit, c.sentToday)
  assert(got === c.expected, `${c.label}: limit=${c.dailyLimit} sentToday=${c.sentToday} → remaining=${c.expected}`, `got ${got}`)
}

// ── 2. Capping behaviour ──────────────────────────────────────────────────────
console.log('\n' + DIV)
console.log('  2. Only the first N eligible leads are sent; the rest are deferred')
console.log(DIV)

const eligibleLeads = ['lead-A', 'lead-B', 'lead-C', 'lead-D', 'lead-E']

{
  const { toSend, deferred } = applyDailyCap(eligibleLeads, 3)
  assert(toSend.length === 3, 'budget=3 of 5 eligible → 3 sent')
  assert(JSON.stringify(toSend) === JSON.stringify(['lead-A', 'lead-B', 'lead-C']), 'sent leads are the first 3 in order (earliest-eligible first)')
  assert(deferred.length === 2, 'budget=3 of 5 eligible → 2 deferred')
  assert(JSON.stringify(deferred) === JSON.stringify(['lead-D', 'lead-E']), 'deferred leads are exactly the remainder, untouched')
}

{
  const { toSend, deferred } = applyDailyCap(eligibleLeads, 0)
  assert(toSend.length === 0, 'budget=0 → nothing sent this run')
  assert(deferred.length === 5, 'budget=0 → all 5 eligible leads deferred to next run')
}

{
  const { toSend, deferred } = applyDailyCap(eligibleLeads, 100)
  assert(toSend.length === 5, 'budget far exceeds eligible count → all 5 sent')
  assert(deferred.length === 0, 'budget far exceeds eligible count → nothing deferred')
}

// ── 3. Independence from daily_initial_outreach_limit ─────────────────────────
console.log('\n' + DIV)
console.log('  3. daily_reactivation_limit is independent of daily_initial_outreach_limit')
console.log(DIV)

{
  // Simulates two settings rows loaded from the same `settings` table — changing
  // the initial-outreach limit must never move the reactivation budget, and vice
  // versa. agents/reactivation.ts never reads daily_initial_outreach_limit at all.
  const settingsA = { daily_reactivation_limit: 10, daily_initial_outreach_limit: 50 }
  const settingsB = { daily_reactivation_limit: 10, daily_initial_outreach_limit: 5 }

  const budgetA = computeRemainingBudget(settingsA.daily_reactivation_limit, 0)
  const budgetB = computeRemainingBudget(settingsB.daily_reactivation_limit, 0)

  assert(budgetA === budgetB, 'reactivation budget unchanged when daily_initial_outreach_limit changes (50 → 5)', `got ${budgetA} vs ${budgetB}`)
}

{
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const src = fs.readFileSync(path.resolve(process.cwd(), 'agents/reactivation.ts'), 'utf8')
  // The settings query array is the only place a setting key is actually *read* from
  // the DB — a mention of daily_initial_outreach_limit elsewhere (e.g. an explanatory
  // comment) doesn't count as reading it, so scope the check to that array's contents.
  const settingsQueryMatch = src.match(/\.in\('key',\s*\[([^\]]+)\]\)/)
  assert(!!settingsQueryMatch, 'agents/reactivation.ts has a settings .in(\'key\', [...]) query')
  const queriedKeys = settingsQueryMatch?.[1] ?? ''
  assert(queriedKeys.includes("'daily_reactivation_limit'"), 'the settings query reads daily_reactivation_limit')
  assert(!queriedKeys.includes('daily_initial_outreach_limit'), 'the settings query never reads daily_initial_outreach_limit')
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('\n' + SEP)
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
console.log(SEP)

if (failed > 0) process.exit(1)
