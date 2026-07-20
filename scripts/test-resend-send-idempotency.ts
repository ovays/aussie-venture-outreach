/**
 * scripts/test-resend-send-idempotency.ts
 *
 * Verifies the production-readiness-audit fix for a duplicate-delivery bug
 * in src/lib/resend.ts: sendEmail() wraps the actual Resend API call in
 * withRetry({ maxAttempts: 3 }) with no isRetryable predicate, so ANY thrown
 * exception is retried — including a network timeout/reset AFTER Resend has
 * already accepted and is delivering the email, where the response was just
 * lost in transit. Before this fix, buildThreadingHeaders() (which mints the
 * Message-ID via randomUUID()) was called INSIDE the retried closure, so a
 * retried attempt generated a brand new Message-ID and, on success, would
 * overwrite the recorded id/messageId with the retry's — meaning two real
 * emails could be delivered to a prospect with only one ever appearing in
 * the emails table, no duplicate visible anywhere.
 *
 * The fix hoists buildThreadingHeaders() outside the retry closure (so the
 * same Message-ID is used on every attempt) and passes it as Resend's
 * `idempotencyKey`, so a retried request that Resend already processed
 * returns the original result instead of sending again server-side.
 *
 * This is a static source check (consistent with this repo's existing
 * convention) since sendEmail() calls the real Resend SDK directly with no
 * injection seam, so exercising the actual retry-after-timeout path would
 * require a live network fault, not a repeatable unit test.
 *
 * Run: npx tsx scripts/test-resend-send-idempotency.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { buildThreadingHeaders } from '../src/lib/resend'

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
  console.log('  TEST:RESEND-SEND-IDEMPOTENCY')
  console.log(SEP)

  console.log('\n  1. buildThreadingHeaders() is called once, outside the retry closure')
  {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/resend.ts'), 'utf8')

    const fnIdx = src.indexOf('export async function sendEmail(')
    const retryOpenIdx = src.indexOf('return await withRetry(async () => {', fnIdx)
    const buildHeadersIdx = src.indexOf('buildThreadingHeaders(params.references)', fnIdx)
    const idempotencyKeyDeclIdx = src.indexOf('const idempotencyKey = messageId', fnIdx)

    assert(fnIdx !== -1, 'sendEmail() still exists')
    assert(retryOpenIdx !== -1, 'sendEmail() still uses withRetry')
    assert(buildHeadersIdx !== -1, 'buildThreadingHeaders() is still called inside sendEmail()')
    assert(
      buildHeadersIdx < retryOpenIdx,
      'buildThreadingHeaders() (and its randomUUID() Message-ID) is generated BEFORE the retry closure opens, not inside it'
    )
    assert(idempotencyKeyDeclIdx !== -1 && idempotencyKeyDeclIdx < retryOpenIdx, 'idempotencyKey is derived once, before the retry closure')

    // Exactly one call site for buildThreadingHeaders in sendEmail — proves
    // it isn't ALSO being called again per-attempt inside the closure.
    const occurrences = src.slice(fnIdx, src.indexOf('\n}', retryOpenIdx)).split('buildThreadingHeaders(').length - 1
    assert(occurrences === 1, 'buildThreadingHeaders() appears exactly once inside sendEmail() — not re-invoked per retry attempt', `found ${occurrences} occurrences`)
  }

  console.log('\n  2. The Resend API call is given the stable idempotencyKey')
  {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/resend.ts'), 'utf8')
    const sendCallIdx = src.indexOf('resend.emails.send({')
    const optionsIdx = src.indexOf('{ idempotencyKey }', sendCallIdx)
    assert(sendCallIdx !== -1, 'resend.emails.send() is still called')
    assert(optionsIdx !== -1 && optionsIdx > sendCallIdx, 'resend.emails.send() is passed { idempotencyKey } as its second (options) argument')
  }

  console.log('\n  3. buildThreadingHeaders itself is unchanged (pure, deterministic per call)')
  {
    const a = buildThreadingHeaders(['<prior@aussieventure.com>'])
    assert(a.headers['In-Reply-To'] === '<prior@aussieventure.com>', 'In-Reply-To is set from the last reference when references are provided')
    assert(a.headers['Message-ID'] === a.messageId, 'The returned messageId matches the Message-ID header')

    const b = buildThreadingHeaders()
    assert(!('In-Reply-To' in b.headers), 'No In-Reply-To header when no references are given (new thread)')
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
