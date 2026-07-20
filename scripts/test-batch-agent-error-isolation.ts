/**
 * scripts/test-batch-agent-error-isolation.ts
 *
 * Verifies the production-readiness-audit fix for a whole-batch-outage bug:
 * agents/followup.ts and agents/reactivation.ts iterate every eligible lead
 * in a for-loop, calling Supabase and Resend for each one, but (before this
 * fix) had no per-item try/catch — unlike agents/sender.ts, which explicitly
 * wraps each lead's send in try/catch specifically so one lead's transient
 * failure (e.g. a network-level Supabase exception, not just a returned
 * {error}) can't kill the loop for every other lead.
 *
 * Without isolation, one bad record anywhere in that day's follow-up run
 * throws out of the loop, is caught by runFollowUpAgent's top-level catch,
 * and RE-THROWN — which trigger/daily-pipeline.ts turns into an aborted
 * pipeline run, silently dropping every other lead queued for FU1/FU2/FU3
 * that day AND skipping the Reactivation stage that runs after it. The same
 * gap in agents/reactivation.ts drops the rest of that day's reactivation
 * batch.
 *
 * This is a static source check (consistent with this repo's existing
 * convention — see scripts/test-atomic-quota-enforcement.ts) since these
 * agent entry points construct their own Supabase client internally and
 * aren't dependency-injectable for a full dynamic run.
 *
 * Run: npx tsx scripts/test-batch-agent-error-isolation.ts
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

async function main() {
  console.log(SEP)
  console.log('  TEST:BATCH-AGENT-ERROR-ISOLATION')
  console.log(SEP)

  const followupSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/followup.ts'), 'utf8')

  console.log('\n  1. agents/followup.ts — per-candidate send loop is isolated')
  {
    const loopIdx = followupSrc.indexOf('for (const candidate of toSend) {')
    const tryIdx = followupSrc.indexOf('try {', loopIdx)
    const sendIdx = followupSrc.indexOf('await sendFollowUp(supabase, candidate, type)', loopIdx)
    const catchIdx = followupSrc.indexOf('} catch (error) {', sendIdx)

    assert(loopIdx !== -1, 'The per-candidate send loop still exists')
    assert(tryIdx !== -1 && tryIdx < sendIdx, 'The loop body opens a try block before calling sendFollowUp')
    assert(catchIdx !== -1 && catchIdx > sendIdx, 'The sendFollowUp call is followed by a catch block')

    // No rethrow inside this specific catch — it must log and let the loop continue.
    const catchBlockEnd = followupSrc.indexOf('\n      }', catchIdx)
    const catchBody = followupSrc.slice(catchIdx, catchBlockEnd)
    assert(!/throw /.test(catchBody), 'The per-candidate catch does not rethrow — the loop continues to the next candidate')
    assert(/logger\.error\(/.test(catchBody), 'The per-candidate catch logs the failure instead of silently swallowing it')
  }

  console.log('\n  2. agents/followup.ts — dead-marking block is isolated')
  {
    const blockIdx = followupSrc.indexOf("if (!reactivationEnabled && fu3Email?.sent_at")
    const tryIdx = followupSrc.indexOf('try {', blockIdx)
    const updateIdx = followupSrc.indexOf("await supabase.from('leads').update({ status: 'dead' })", blockIdx)
    const catchIdx = followupSrc.indexOf('} catch (error) {', updateIdx)

    assert(blockIdx !== -1, 'The dead-marking eligibility branch still exists')
    assert(tryIdx !== -1 && tryIdx < updateIdx, 'The dead-marking DB writes are inside a try block')
    assert(catchIdx !== -1 && catchIdx > updateIdx, 'The dead-marking writes are followed by a catch block')
  }

  console.log('\n  3. agents/reactivation.ts — per-lead loop is isolated')
  {
    const reactivationSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/reactivation.ts'), 'utf8')

    const loopIdx = reactivationSrc.indexOf('for (const lead of contactedLeads as ContactedLead[]) {')
    const tryIdx = reactivationSrc.indexOf('try {', loopIdx)
    const sendIdx = reactivationSrc.indexOf('await writeReactivationEmail(', loopIdx)
    const catchIdx = reactivationSrc.indexOf('} catch (error) {', sendIdx)

    assert(loopIdx !== -1, 'The per-lead reactivation loop still exists')
    assert(tryIdx !== -1 && tryIdx < sendIdx, 'The loop body opens a try block before generating/sending the reactivation email')
    assert(catchIdx !== -1 && catchIdx > sendIdx, 'The send is followed by a catch block')

    const catchBlockEnd = reactivationSrc.indexOf('\n    }', catchIdx)
    const catchBody = reactivationSrc.slice(catchIdx, catchBlockEnd)
    assert(!/throw /.test(catchBody), 'The per-lead catch does not rethrow — the loop continues to the next lead')
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
