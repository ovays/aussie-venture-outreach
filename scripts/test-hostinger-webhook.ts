import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acceptHostingerInboundEvent, hostingerInboundReceiptKey, type HostingerInboundReceiptStore } from '../src/lib/hostinger-inbound-queue'
import { processHostingerInboundReceipt } from '../src/lib/hostinger-inbound-receipts'
import { handleHostingerWebhookRequest } from '../src/lib/hostinger-webhook-handler'
import { parseHostingerWebhookPayload } from '../src/lib/hostinger-webhook'
import { validateHostingerInboundTaskPayload } from '../src/lib/hostinger-inbound-payload'
import type { NormalizedInboundMessage } from '../agents/tracker'

type Row = Record<string, unknown>

class Query {
  private filters: Array<[string, unknown]> = []
  private action: 'select' | 'update' = 'select'
  private updateValue: Row = {}

  constructor(private rows: Row[]) {}

  select() { return this }
  update(value: Row) { this.action = 'update'; this.updateValue = value; return this }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this }
  private matching() { return this.rows.filter((row) => this.filters.every(([column, value]) => row[column] === value)) }
  private execute() {
    const matching = this.matching()
    if (this.action === 'update') matching.forEach((row) => Object.assign(row, this.updateValue))
    return matching
  }
  async single() {
    const matching = this.execute()
    return matching.length === 1 ? { data: matching[0], error: null } : { data: null, error: { message: 'not found' } }
  }
  async maybeSingle() {
    const matching = this.execute()
    return matching.length <= 1 ? { data: matching[0] ?? null, error: null } : { data: null, error: { message: 'multiple rows' } }
  }
  then(resolve: (value: { data: Row[]; error: null }) => void) { resolve({ data: this.execute(), error: null }) }
}

function fakeSupabase(receipts: Row[]) {
  return {
    from(table: string) { assert.equal(table, 'inbound_receipts'); return new Query(receipts) },
    rpc(name: string, args: { p_receipt_id: string; p_run_id: string; p_stale_before: string }) {
      assert.equal(name, 'claim_hostinger_inbound_receipt')
      const row = receipts.find((candidate) => candidate.id === args.p_receipt_id)
      const status = row?.status
      const startedAt = String(row?.processing_started_at ?? row?.updated_at ?? '')
      const isStale = status === 'processing' && !!startedAt && startedAt < args.p_stale_before
      const isSameRunRetry = status === 'processing' && row?.processing_run_id === args.p_run_id
      const claimable = status === 'pending' || status === 'queued' || status === 'failed' || isStale || isSameRunRetry
      return {
        async maybeSingle() {
          if (!row || !claimable) return { data: null, error: null }
          row.status = 'processing'
          row.processing_run_id = args.p_run_id
          row.processing_started_at = new Date().toISOString()
          row.updated_at = row.processing_started_at
          row.attempts = Number(row.attempts ?? 0) + 1
          row.last_error = null
          return { data: { receipt_id: row.id, attempt_count: row.attempts }, error: null }
        },
      }
    },
  } as never
}

function webhookRequest(payload: unknown): Request {
  return new Request('https://reachagent.test/api/webhooks/hostinger', {
    method: 'POST',
    headers: { authorization: 'Bearer webhook-secret', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

const payload = {
  event: 'message.received',
  account_resource_id: 'AC_mailbox',
  message: {
    uid: 42,
    path: 'INBOX',
    message_id: '<reply@example.test>',
    from: { address: 'owner@example.test' },
    subject: 'Re: Hello',
    in_reply_to: '<outbound@reachagent.test>',
    references: '<first@reachagent.test> <outbound@reachagent.test>',
    headers: { 'Auto-Submitted': 'no' },
  },
}

async function main() {
  console.log('Hostinger webhook and unread-state tests')

  let accepted = 0
  const started = performance.now()
  const response = await handleHostingerWebhookRequest(webhookRequest(payload), {
    webhookSecret: 'webhook-secret', mailboxId: 'AC_mailbox', mailboxAddress: 'hello@example.test',
    accept: async () => { accepted += 1; return { receiptId: 'receipt-1', runId: 'run-1', duplicate: false, status: 'queued' } },
  })
  assert.equal(response.status, 202)
  assert.equal(accepted, 1)
  assert.ok(performance.now() - started < 250, 'acknowledgement should only wait for durable enqueue work')

  const locator = parseHostingerWebhookPayload(payload)
  assert.equal(locator.uid, 42)
  assert.deepEqual(locator.inReplyTo, ['<outbound@reachagent.test>'])
  assert.deepEqual(locator.references, ['<first@reachagent.test> <outbound@reachagent.test>'])
  assert.equal(locator.headers['auto-submitted'], 'no')

  let status: 'pending' | 'queued' = 'pending'
  let enqueueCount = 0
  const store: HostingerInboundReceiptStore = {
    async register(value) {
      return { id: 'receipt-1', receiptKey: hostingerInboundReceiptKey(value), status, duplicate: status !== 'pending', attemptCount: 0, replayable: status === 'pending' }
    },
    async markQueued(_id, runId) { assert.equal(runId, 'run-1'); status = 'queued'; return status },
    async recordEnqueueError() { throw new Error('unexpected enqueue failure') },
  }
  const first = await acceptHostingerInboundEvent(locator, store, async () => { enqueueCount += 1; return { id: 'run-1' } })
  const duplicate = await acceptHostingerInboundEvent(locator, store, async () => { enqueueCount += 1; return { id: 'run-2' } })
  assert.equal(first.status, 'queued')
  assert.equal(duplicate.duplicate, true)
  assert.equal(enqueueCount, 1, 'duplicate webhook must not enqueue a second task')

  for (const terminalStatus of ['processed', 'ignored'] as const) {
    let terminalEnqueues = 0
    const terminalStore: HostingerInboundReceiptStore = {
      async register(value) {
        return { id: `receipt-${terminalStatus}`, receiptKey: hostingerInboundReceiptKey(value), status: terminalStatus, duplicate: true, attemptCount: 1, replayable: false }
      },
      async markQueued() { throw new Error('terminal receipt must not be queued') },
      async recordEnqueueError() { throw new Error('terminal receipt must not record enqueue errors') },
    }
    const terminal = await acceptHostingerInboundEvent(locator, terminalStore, async () => {
      terminalEnqueues += 1
      return { id: 'unexpected' }
    })
    assert.equal(terminal.status, terminalStatus)
    assert.equal(terminalEnqueues, 0, `${terminalStatus} receipt must not replay`)
  }

  let failedStatus: 'failed' | 'queued' = 'failed'
  const replayKeys: string[] = []
  const failedStore: HostingerInboundReceiptStore = {
    async register(value) {
      return { id: 'receipt-failed', receiptKey: hostingerInboundReceiptKey(value), status: failedStatus, duplicate: true, attemptCount: 2, replayable: failedStatus === 'failed' }
    },
    async markQueued() { failedStatus = 'queued'; return failedStatus },
    async recordEnqueueError() { throw new Error('unexpected failed replay enqueue error') },
  }
  const failedReplay = await acceptHostingerInboundEvent(locator, failedStore, async (_id, key) => {
    replayKeys.push(key)
    return { id: 'run-failed-replay' }
  })
  assert.equal(failedReplay.status, 'queued')
  assert.match(replayKeys[0], /attempt-2$/)

  let recoveryStatus: 'pending' | 'queued' = 'pending'
  let queueWrites = 0
  const recoveryKeys: string[] = []
  const recoveryStore: HostingerInboundReceiptStore = {
    async register(value) {
      return { id: 'receipt-recovery', receiptKey: hostingerInboundReceiptKey(value), status: recoveryStatus, duplicate: true, attemptCount: 0, replayable: recoveryStatus === 'pending' }
    },
    async markQueued() {
      queueWrites += 1
      if (queueWrites === 1) throw new Error('queued state write failed')
      recoveryStatus = 'queued'
      return recoveryStatus
    },
    async recordEnqueueError() {},
  }
  await assert.rejects(acceptHostingerInboundEvent(locator, recoveryStore, async (_id, key) => {
    recoveryKeys.push(key)
    return { id: 'same-trigger-run' }
  }), /queued state write failed/)
  const recovered = await acceptHostingerInboundEvent(locator, recoveryStore, async (_id, key) => {
    recoveryKeys.push(key)
    return { id: 'same-trigger-run' }
  })
  assert.equal(recovered.status, 'queued')
  assert.equal(recoveryKeys[0], recoveryKeys[1], 'state-write recovery must reuse the Trigger idempotency key')

  let staleReplayEnqueues = 0
  const staleReplayStore: HostingerInboundReceiptStore = {
    async register(value) {
      return { id: 'receipt-stale-webhook', receiptKey: hostingerInboundReceiptKey(value), status: 'processing', duplicate: true, attemptCount: 1, replayable: true }
    },
    async markQueued() { return 'processing' },
    async recordEnqueueError() { throw new Error('unexpected stale replay enqueue error') },
  }
  const staleReplay = await acceptHostingerInboundEvent(locator, staleReplayStore, async () => {
    staleReplayEnqueues += 1
    return { id: 'run-stale-replay' }
  })
  assert.equal(staleReplay.runId, 'run-stale-replay')
  assert.equal(staleReplayEnqueues, 1, 'stale processing duplicate webhook enqueues a reclaim run')

  const processingPayload = parseHostingerWebhookPayload(payload)
  const receipts: Row[] = [{ id: 'receipt-bg', status: 'queued', payload: processingPayload, processing_run_id: null, attempts: 0 }]
  let fetchCount = 0
  let processCount = 0
  const fetchMessage = async (): Promise<NormalizedInboundMessage> => {
    fetchCount += 1
    return { provider: 'hostinger', providerMessageId: '<reply@example.test>', from: 'owner@example.test', headers: {} }
  }
  const processReply = async () => { processCount += 1; return { outcome: 'processed' as const, leadId: 'lead-1' } }
  const completed = await processHostingerInboundReceipt('receipt-bg', 'run-bg', {
    supabase: fakeSupabase(receipts), fetchMessage, processReply: processReply as never,
  })
  const replay = await processHostingerInboundReceipt('receipt-bg', 'run-bg', {
    supabase: fakeSupabase(receipts), fetchMessage, processReply: processReply as never,
  })
  assert.equal(completed.status, 'processed')
  assert.equal(replay.skipped, true)
  assert.equal(fetchCount, 1)
  assert.equal(processCount, 1, 'completed task replay must not process twice')
  assert.equal(receipts[0].attempts, 1)

  const retryRows: Row[] = [{ id: 'receipt-retry', status: 'queued', payload: processingPayload, processing_run_id: null, attempts: 0 }]
  let attempts = 0
  const retryProcessor = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary failure')
    return { outcome: 'processed' as const }
  }
  await assert.rejects(processHostingerInboundReceipt('receipt-retry', 'run-retry', {
    supabase: fakeSupabase(retryRows), fetchMessage, processReply: retryProcessor as never,
  }))
  assert.equal(retryRows[0].status, 'failed')
  const retryResult = await processHostingerInboundReceipt('receipt-retry', 'run-retry', {
    supabase: fakeSupabase(retryRows), fetchMessage, processReply: retryProcessor as never,
  })
  assert.equal(retryResult.status, 'processed')
  assert.equal(attempts, 2)
  assert.equal(retryRows[0].attempts, 2)

  const missingLeadRows: Row[] = [{ id: 'receipt-missing', status: 'queued', payload: processingPayload, attempts: 0 }]
  await assert.rejects(processHostingerInboundReceipt('receipt-missing', 'run-missing', {
    supabase: fakeSupabase(missingLeadRows), fetchMessage,
    processReply: (async () => { throw new Error('Matched inbound reply lead lead-gone could not be loaded: not found') }) as never,
  }), /lead-gone/)
  assert.equal(missingLeadRows[0].status, 'failed', 'missing matched lead receipt must not become processed')
  assert.match(String(missingLeadRows[0].last_error), /lead-gone/, 'missing lead diagnostic is retained')

  const freshRows: Row[] = [{
    id: 'receipt-fresh', status: 'processing', payload: processingPayload,
    processing_run_id: 'run-active', processing_started_at: new Date().toISOString(), attempts: 1,
  }]
  const fresh = await processHostingerInboundReceipt('receipt-fresh', 'run-other', {
    supabase: fakeSupabase(freshRows), fetchMessage, processReply: processReply as never,
  })
  assert.equal(fresh.skipped, true)
  assert.equal(freshRows[0].processing_run_id, 'run-active', 'fresh processing receipt cannot be reclaimed')

  const sameRunRows: Row[] = [{
    id: 'receipt-same-run', status: 'processing', payload: processingPayload,
    processing_run_id: 'run-retry', processing_started_at: new Date().toISOString(), attempts: 1,
  }]
  const sameRun = await processHostingerInboundReceipt('receipt-same-run', 'run-retry', {
    supabase: fakeSupabase(sameRunRows), fetchMessage, processReply: processReply as never,
  })
  assert.equal(sameRun.status, 'processed')
  assert.equal(sameRunRows[0].attempts, 2, 'same Trigger run can resume after a hard attempt crash')

  const staleRows: Row[] = [{
    id: 'receipt-stale', status: 'processing', payload: processingPayload,
    processing_run_id: 'run-crashed', processing_started_at: '2026-01-01T00:00:00.000Z', attempts: 1,
  }]
  const stale = await processHostingerInboundReceipt('receipt-stale', 'run-reclaim', {
    supabase: fakeSupabase(staleRows), fetchMessage, processReply: processReply as never,
  })
  assert.equal(stale.status, 'processed')
  assert.equal(staleRows[0].attempts, 2, 'stale processing reclaim increments attempts')

  assert.throws(() => validateHostingerInboundTaskPayload(undefined), /expected an object/)
  assert.throws(() => validateHostingerInboundTaskPayload({}), /receiptId/)
  assert.throws(() => validateHostingerInboundTaskPayload({ receiptId: '   ' }), /receiptId/)
  assert.throws(() => validateHostingerInboundTaskPayload({ receiptId: 'receipt-ok', extra: true }), /receiptId/)
  assert.deepEqual(validateHostingerInboundTaskPayload({ receiptId: ' receipt-ok ' }), { receiptId: 'receipt-ok' })

  const mailSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/hostinger-mail.ts'), 'utf8')
  assert.doesNotMatch(mailSource, /messages[^\n]*\/source/)
  assert.doesNotMatch(mailSource, /messages[^\n]*\/text/)
  assert.doesNotMatch(mailSource, /method:\s*['"]PATCH['"]/)
  assert.doesNotMatch(mailSource, /\/messages\/flags/)
  assert.match(mailSource, /getMessageMetadata\(locator, config, fetchImpl\)/)
  assert.match(mailSource, /metadataHeaders\(message, locator\)/)

  const migrationSource = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/052_hostinger_inbound_reliability.sql'), 'utf8')
  assert.match(migrationSource, /CREATE INDEX IF NOT EXISTS emails_message_id_not_null_idx/)
  assert.match(migrationSource, /WHERE message_id IS NOT NULL/)

  console.log('✓ fast acknowledgement, durable queueing, dedupe, retry, metadata-only retrieval, and unchanged flags')
}

main().catch((error) => { console.error(error); process.exit(1) })
