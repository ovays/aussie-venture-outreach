/**
 * Simulates follow-up queue allocation with no DB, email, or external API calls.
 * Models the same logic as agents/sender.ts + agents/followup.ts.
 */

interface TestCase {
  label: string
  globalDailyLimit: number
  initialOutreachLimit: number
  fu1Limit: number
  fu2Limit: number
  fu3Limit: number
  alreadySentToday: number
  initialPending: number
  fu1Pending: number
  fu2Pending: number
  fu3Pending: number
  expected: {
    initial: number
    fu1: number
    fu2: number
    fu3: number
    total: number
  }
}

const TEST_CASES: TestCase[] = [
  {
    label: 'Test 1: initial_outreach_limit=0, FU1 has capacity',
    globalDailyLimit: 50,
    initialOutreachLimit: 0,
    fu1Limit: 40,
    fu2Limit: 0,
    fu3Limit: 0,
    alreadySentToday: 0,
    initialPending: 10,
    fu1Pending: 50,
    fu2Pending: 0,
    fu3Pending: 0,
    expected: { initial: 0, fu1: 40, fu2: 0, fu3: 0, total: 40 },
  },
  {
    label: 'Test 2: global cap shared between initial and FU1',
    globalDailyLimit: 30,
    initialOutreachLimit: 10,
    fu1Limit: 40,
    fu2Limit: 0,
    fu3Limit: 0,
    alreadySentToday: 0,
    initialPending: 10,
    fu1Pending: 50,
    fu2Pending: 0,
    fu3Pending: 0,
    expected: { initial: 10, fu1: 20, fu2: 0, fu3: 0, total: 30 },
  },
  {
    label: 'Test 3: global cap distributes across all 4 queues',
    globalDailyLimit: 50,
    initialOutreachLimit: 10,
    fu1Limit: 10,
    fu2Limit: 10,
    fu3Limit: 20,
    alreadySentToday: 0,
    initialPending: 10,
    fu1Pending: 20,
    fu2Pending: 20,
    fu3Pending: 20,
    expected: { initial: 10, fu1: 10, fu2: 10, fu3: 20, total: 50 },
  },
]

function simulate(tc: TestCase) {
  let globalRemaining = Math.max(0, tc.globalDailyLimit - tc.alreadySentToday)

  const initialAllowed = Math.min(tc.initialOutreachLimit, globalRemaining, tc.initialPending)
  globalRemaining -= initialAllowed

  const fu1Allowed = Math.min(tc.fu1Limit, globalRemaining, tc.fu1Pending)
  globalRemaining -= fu1Allowed

  const fu2Allowed = Math.min(tc.fu2Limit, globalRemaining, tc.fu2Pending)
  globalRemaining -= fu2Allowed

  const fu3Allowed = Math.min(tc.fu3Limit, globalRemaining, tc.fu3Pending)
  globalRemaining -= fu3Allowed

  const total = initialAllowed + fu1Allowed + fu2Allowed + fu3Allowed

  return { initial: initialAllowed, fu1: fu1Allowed, fu2: fu2Allowed, fu3: fu3Allowed, total, globalRemaining }
}

let allPassed = true

for (const tc of TEST_CASES) {
  const result = simulate(tc)
  const pass =
    result.initial === tc.expected.initial &&
    result.fu1 === tc.expected.fu1 &&
    result.fu2 === tc.expected.fu2 &&
    result.fu3 === tc.expected.fu3 &&
    result.total === tc.expected.total

  const status = pass ? '✅ PASS' : '❌ FAIL'
  if (!pass) allPassed = false

  console.log(`\n${status}  ${tc.label}`)
  console.log('  Settings:')
  console.log(`    GLOBAL_DAILY_SEND_LIMIT   = ${tc.globalDailyLimit}`)
  console.log(`    INITIAL_OUTREACH_LIMIT    = ${tc.initialOutreachLimit}`)
  console.log(`    FU1_LIMIT                 = ${tc.fu1Limit}`)
  console.log(`    FU2_LIMIT                 = ${tc.fu2Limit}`)
  console.log(`    FU3_LIMIT                 = ${tc.fu3Limit}`)
  console.log(`    already_sent_today        = ${tc.alreadySentToday}`)
  console.log('  Pending queue sizes:')
  console.log(`    initial_pending           = ${tc.initialPending}`)
  console.log(`    fu1_pending               = ${tc.fu1Pending}`)
  console.log(`    fu2_pending               = ${tc.fu2Pending}`)
  console.log(`    fu3_pending               = ${tc.fu3Pending}`)
  console.log('  Allocation:')
  console.log(`    initial  requested=${tc.initialPending}  allowed=${result.initial}`)
  console.log(`    FU1      requested=${tc.fu1Pending}  allowed=${result.fu1}`)
  console.log(`    FU2      requested=${tc.fu2Pending}  allowed=${result.fu2}`)
  console.log(`    FU3      requested=${tc.fu3Pending}  allowed=${result.fu3}`)
  console.log(`    global_remaining_after_all = ${result.globalRemaining}`)
  console.log(`    total_outbound = ${result.total}`)
  if (!pass) {
    console.log('  Expected:')
    console.log(`    initial=${tc.expected.initial}  FU1=${tc.expected.fu1}  FU2=${tc.expected.fu2}  FU3=${tc.expected.fu3}  total=${tc.expected.total}`)
    console.log('  Got:')
    console.log(`    initial=${result.initial}  FU1=${result.fu1}  FU2=${result.fu2}  FU3=${result.fu3}  total=${result.total}`)
  }
}

console.log(`\n${allPassed ? '✅ All tests passed' : '❌ Some tests failed'}`)
if (!allPassed) process.exitCode = 1
