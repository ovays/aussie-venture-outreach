import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acceptHostingerInboundEvent, hostingerInboundReceiptKey, type HostingerInboundReceiptStore } from '../src/lib/hostinger-inbound-queue'
import { processHostingerInboundReceipt } from '../src/lib/hostinger-inbound-receipts'
import { handleHostingerWebhookRequest } from '../src/lib/hostinger-webhook-handler'
import { parseHostingerWebhookPayload } from '../src/lib/hostinger-webhook'
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
  return { from(table: string) { assert.equal(table, 'inbound_receipts'); return new Query(receipts) } } as never
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
      return { id: 'receipt-1', receiptKey: hostingerInboundReceiptKey(value), status, duplicate: status !== 'pending' }
    },
    async markQueued(_id, runId) { assert.equal(runId, 'run-1'); status = 'queued' },
    async recordEnqueueError() { throw new Error('unexpected enqueue failure') },
  }
  const first = await acceptHostingerInboundEvent(locator, store, async () => { enqueueCount += 1; return { id: 'run-1' } })
  const duplicate = await acceptHostingerInboundEvent(locator, store, async () => { enqueueCount += 1; return { id: 'run-2' } })
  assert.equal(first.status, 'queued')
  assert.equal(duplicate.duplicate, true)
  assert.equal(enqueueCount, 1, 'duplicate webhook must not enqueue a second task')

  const processingPayload = parseHostingerWebhookPayload(payload)
  const receipts: Row[] = [{ id: 'receipt-bg', status: 'queued', payload: processingPayload, processing_run_id: null }]
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

  const retryRows: Row[] = [{ id: 'receipt-retry', status: 'queued', payload: processingPayload, processing_run_id: null }]
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

  const mailSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/hostinger-mail.ts'), 'utf8')
  assert.doesNotMatch(mailSource, /messages[^\n]*\/source/)
  assert.doesNotMatch(mailSource, /messages[^\n]*\/text/)
  assert.doesNotMatch(mailSource, /method:\s*['"]PATCH['"]/)
  assert.doesNotMatch(mailSource, /\/messages\/flags/)
  assert.match(mailSource, /getMessageMetadata\(locator, config, fetchImpl\)/)
  assert.match(mailSource, /metadataHeaders\(message, locator\)/)

  console.log('✓ fast acknowledgement, durable queueing, dedupe, retry, metadata-only retrieval, and unchanged flags')
}

main().catch((error) => { console.error(error); process.exit(1) })
