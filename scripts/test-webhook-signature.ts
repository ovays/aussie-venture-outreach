/**
 * scripts/test-webhook-signature.ts
 *
 * Verifies src/lib/webhook-verify.ts's verifyResendWebhook — the fix for the
 * Critical audit finding that the old hand-rolled HMAC check never matched
 * real Resend/Svix signatures (wrong signed-content string, wrong secret
 * decoding, wrong digest encoding, wrong header).
 *
 * Signs test payloads with the same `Webhook` class Resend's own SDK uses
 * (via svix -> standardwebhooks), so "valid signature" here means "a
 * signature Resend would actually produce" — not just "matches our own logic".
 *
 * Pure / in-memory — no network, no DB.
 *
 * Run: npx tsx scripts/test-webhook-signature.ts
 */

import { Webhook } from 'svix'
import { verifyResendWebhook } from '@/lib/webhook-verify'

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

function makeHeaders(obj: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => obj[name] ?? obj[name.toLowerCase()] ?? null }
}

// Same secret format Resend issues: "whsec_" + base64.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const WRONG_SECRET = 'whsec_' + Buffer.from('completely-different-secret-bytes').toString('base64')

const payload = JSON.stringify({
  type: 'email.bounced',
  created_at: '2026-07-20T00:00:00Z',
  data: { email_id: 'em_123', from: 'hello@aussieventure.com', to: ['biz@example.com'], subject: 'Hi', tags: { lead_id: 'lead-abc' }, bounce: { message: 'bounced', subType: 'general', type: 'HardBounce' } },
})

function sign(secret: string, id: string, ts: Date, body: string): string {
  return new Webhook(secret).sign(id, ts, body)
}

console.log(SEP)
console.log('  TEST:WEBHOOK-SIGNATURE')
console.log(SEP)

// ── 1. Valid signature is accepted ──────────────────────────────────────────
{
  const id = 'msg_1'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  try {
    const event = verifyResendWebhook(payload, headers, SECRET)
    assert(event.type === 'email.bounced', 'Valid signature is accepted and payload is parsed')
  } catch (err) {
    assert(false, 'Valid signature is accepted and payload is parsed', err instanceof Error ? err.message : String(err))
  }
}

// ── 2. Duplicate delivery: verifying the same valid payload twice both succeed ──
{
  const id = 'msg_2'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let firstOk = false
  let secondOk = false
  try {
    verifyResendWebhook(payload, headers, SECRET)
    firstOk = true
  } catch { /* handled below */ }
  try {
    verifyResendWebhook(payload, headers, SECRET)
    secondOk = true
  } catch { /* handled below */ }

  assert(firstOk && secondOk, 'Redelivered webhook (same event, same signature) verifies successfully both times', `first=${firstOk} second=${secondOk}`)
}

// ── 3. Tampered body is rejected ────────────────────────────────────────────
{
  const id = 'msg_3'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const tampered = payload.replace('lead-abc', 'lead-xyz')
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let threw = false
  try {
    verifyResendWebhook(tampered, headers, SECRET)
  } catch {
    threw = true
  }
  assert(threw, 'Tampered body is rejected')
}

// ── 4. Wrong secret is rejected ─────────────────────────────────────────────
{
  const id = 'msg_4'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let threw = false
  try {
    verifyResendWebhook(payload, headers, WRONG_SECRET)
  } catch {
    threw = true
  }
  assert(threw, 'Wrong secret is rejected')
}

// ── 5. Missing svix-signature header is rejected ────────────────────────────
{
  const id = 'msg_5'
  const ts = new Date()
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
  })

  let threw = false
  try {
    verifyResendWebhook(payload, headers, SECRET)
  } catch {
    threw = true
  }
  assert(threw, 'Missing svix-signature header is rejected')
}

// ── 6. Missing svix-id header is rejected ───────────────────────────────────
{
  const id = 'msg_6'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let threw = false
  try {
    verifyResendWebhook(payload, headers, SECRET)
  } catch {
    threw = true
  }
  assert(threw, 'Missing svix-id header is rejected')
}

// ── 7. Stale timestamp (replay window) is rejected ──────────────────────────
{
  const id = 'msg_7'
  const ts = new Date(Date.now() - 10 * 60_000) // 10 minutes old, tolerance is 5 minutes
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let threw = false
  try {
    verifyResendWebhook(payload, headers, SECRET)
  } catch {
    threw = true
  }
  assert(threw, 'Stale timestamp outside the replay tolerance window is rejected')
}

// ── 8. RESEND_WEBHOOK_SECRET not configured is rejected, not silently allowed ──
{
  const id = 'msg_8'
  const ts = new Date()
  const sig = sign(SECRET, id, ts, payload)
  const headers = makeHeaders({
    'svix-id': id,
    'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
    'svix-signature': sig,
  })

  let threw = false
  try {
    verifyResendWebhook(payload, headers, undefined)
  } catch {
    threw = true
  }
  assert(threw, 'Missing RESEND_WEBHOOK_SECRET env var is rejected (fails closed, not open)')
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + SEP)
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
console.log(SEP)

if (failed > 0) {
  console.error('\n  ✗ Some tests failed — review output above.')
  process.exit(1)
} else {
  console.log('\n  ✓ All tests passed.')
}
