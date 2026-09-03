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

function webhookRequest(payload: unknown, authenticated = true): Request {
  return new Request('https://reachagent.test/api/webhooks/hostinger', {
    method: 'POST',
    headers: {
      ...(authenticated ? { authorization: 'Bearer webhook-secret' } : {}),
      'content-type': 'application/json',
    },
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

interface TestHostingerMessage {
  uid: number
  path: string
  date?: string
  subject?: string | null
  from?: { name?: string; address?: string } | null
  to?: Array<{ name?: string; address?: string }>
  messageId?: string | null
  threadId?: string | null
  flags?: string[]
  unseen?: boolean
}

function metadataMessage(
  uid: number,
  overrides: Partial<TestHostingerMessage> = {},
): TestHostingerMessage {
  return {
    uid,
    path: 'INBOX',
    date: '2026-09-02T01:02:03.000Z',
    subject: 'Re: Partnership',
    from: { address: 'owner@example.test' },
    to: [{ address: 'hello@example.test' }],
    messageId: `<message-${uid}@example.test>`,
    flags: [],
    unseen: true,
    ...overrides,
  }
}

function hostingerMetadataFetch(
  messages: TestHostingerMessage[],
  options: { forcedPageSize?: number } = {},
): { fetch: typeof fetch; calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> } {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  const folders = [...new Set(messages.map((message) => message.path))]
  if (!folders.includes('INBOX')) folders.unshift('INBOX')

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input)
    const url = new URL(rawUrl)
    const method = init.method ?? (input instanceof Request ? input.method : 'GET')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ url: rawUrl, method, body })

    if (url.pathname.endsWith('/folders')) {
      return Response.json({
        data: folders.map((folder) => ({ path: folder })),
        pagination: { page: 1, totalPages: 1 },
      })
    }

    const direct = url.pathname.match(/\/folders\/([^/]+)\/messages\/(\d+)$/)
    if (direct) {
      const folder = decodeURIComponent(direct[1])
      const uid = Number(direct[2])
      const message = messages.find((candidate) => candidate.path === folder && candidate.uid === uid)
      return message ? Response.json({ data: message }) : Response.json({ error: 'not found' }, { status: 404 })
    }

    const search = url.pathname.match(/\/folders\/([^/]+)\/messages\/search$/)
    assert.ok(search, `unexpected Hostinger test URL: ${url.pathname}`)
    const folder = decodeURIComponent(search[1])
    let matching = messages.filter((message) => message.path === folder)
    const header = typeof body?.header === 'string' ? body.header : null
    if (header?.toLowerCase().startsWith('message-id:')) {
      const expected = header.slice(header.indexOf(':') + 1).trim()
      matching = matching.filter((message) => message.messageId?.trim() === expected)
    }

    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = options.forcedPageSize ?? 100
    const totalPages = matching.length ? Math.ceil(matching.length / pageSize) : 0
    const pageItems = matching.slice((page - 1) * pageSize, page * pageSize)
    return Response.json({
      data: pageItems,
      pagination: { page, perPage: pageSize, total: matching.length, totalPages },
    })
  }

  return { fetch: fetchImpl as typeof fetch, calls }
}

async function main() {
  console.log('Hostinger webhook and unread-state tests')

  const fixtures = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'scripts/fixtures/hostinger-webhook-payloads.json'),
    'utf8',
  )) as Record<string, unknown>
  const handlerDependencies = (accept: (locator: ReturnType<typeof parseHostingerWebhookPayload>) => Promise<{
    receiptId: string; runId?: string; duplicate: boolean; status: string
  }>) => ({
    webhookSecret: 'webhook-secret',
    mailboxId: 'AC_mailbox',
    mailboxAddress: 'hello@example.test',
    accept,
  })

  let fixtureAccepts = 0
  const fixtureAccept = async () => {
    fixtureAccepts += 1
    return { receiptId: 'fixture-receipt', runId: 'fixture-run', duplicate: false, status: 'queued' }
  }
  const testResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.hostingerTest),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(testResponse.status, 200)
  assert.deepEqual(await testResponse.json(), { ok: true, test: true })
  assert.equal(fixtureAccepts, 0, 'an explicit Hostinger test must not create a receipt or enqueue')

  const realResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.realMessageReceived),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(realResponse.status, 202)
  assert.equal(fixtureAccepts, 1, 'a realistic address-only Hostinger payload reaches acceptance')

  const malformedResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.malformed),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(malformedResponse.status, 400)
  assert.equal((await malformedResponse.json()).error, 'Missing event type')

  const invalidJsonResponse = await handleHostingerWebhookRequest(new Request(
    'https://reachagent.test/api/webhooks/hostinger',
    {
      method: 'POST',
      headers: { authorization: 'Bearer webhook-secret', 'content-type': 'application/json' },
      body: '{',
    },
  ), handlerDependencies(fixtureAccept))
  assert.equal(invalidJsonResponse.status, 400)
  assert.equal((await invalidJsonResponse.json()).error, 'Invalid JSON')

  const missingMailboxResponse = await handleHostingerWebhookRequest(webhookRequest({
    event: 'message.received',
    message: { id: 'message-1' },
  }), handlerDependencies(fixtureAccept))
  assert.equal(missingMailboxResponse.status, 400)
  assert.equal((await missingMailboxResponse.json()).error, 'Missing mailbox identifier or address')

  const missingLocatorResponse = await handleHostingerWebhookRequest(webhookRequest({
    event: 'message.received',
    mailbox: 'hello@example.test',
    message: { from: 'owner@example.test', subject: 'No stable locator' },
  }), handlerDependencies(fixtureAccept))
  assert.equal(missingLocatorResponse.status, 400)
  assert.equal((await missingLocatorResponse.json()).error, 'Missing stable message locator')

  const wrongMailboxResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.wrongMailbox),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(wrongMailboxResponse.status, 200)
  assert.equal((await wrongMailboxResponse.json()).ignored, true)

  const wrongEventResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.wrongEvent),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(wrongEventResponse.status, 200)
  assert.equal((await wrongEventResponse.json()).ignored, true)

  const missingAuthResponse = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.missingAuth, false),
    handlerDependencies(fixtureAccept),
  )
  assert.equal(missingAuthResponse.status, 401)

  let fixtureStatus: 'pending' | 'queued' = 'pending'
  let fixtureEnqueues = 0
  const fixtureStore: HostingerInboundReceiptStore = {
    async register(value) {
      return {
        id: 'fixture-dedup-receipt',
        receiptKey: hostingerInboundReceiptKey(value),
        status: fixtureStatus,
        duplicate: fixtureStatus !== 'pending',
        attemptCount: 0,
        replayable: fixtureStatus === 'pending',
      }
    },
    async markQueued() { fixtureStatus = 'queued'; return fixtureStatus },
    async recordEnqueueError() { throw new Error('unexpected fixture enqueue failure') },
  }
  const deduplicatingAccept = (value: ReturnType<typeof parseHostingerWebhookPayload>) => acceptHostingerInboundEvent(
    value,
    fixtureStore,
    async () => { fixtureEnqueues += 1; return { id: 'fixture-dedup-run' } },
  )
  const firstFixture = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.realMessageReceived),
    handlerDependencies(deduplicatingAccept),
  )
  const duplicateFixture = await handleHostingerWebhookRequest(
    webhookRequest(fixtures.duplicateValidEvent),
    handlerDependencies(deduplicatingAccept),
  )
  assert.equal(firstFixture.status, 202)
  assert.equal(duplicateFixture.status, 202)
  assert.equal((await duplicateFixture.json()).duplicate, true)
  assert.equal(fixtureEnqueues, 1, 'duplicate realistic webhook enqueues exactly once')

  let accepted = 0
  const started = performance.now()
  const response = await handleHostingerWebhookRequest(webhookRequest(payload), {
    webhookSecret: 'webhook-secret', mailboxId: 'AC_mailbox', mailboxAddress: 'hello@example.test',
    accept: async () => { accepted += 1; return { receiptId: 'receipt-1', runId: 'run-1', duplicate: false, status: 'queued' } },
  })
  assert.equal(response.status, 202)
  assert.equal(accepted, 1)
  assert.ok(performance.now() - started < 250, 'acknowledgement should only wait for durable enqueue work')

  for (const folder of ['INBOX.Trash', 'Trash', 'Junk', 'Spam', 'INBOX.Sent', 'Sent', 'Drafts', 'Archive']) {
    const nonInboxResponse = await handleHostingerWebhookRequest(webhookRequest({
      ...payload,
      message: { ...payload.message, path: folder },
    }), {
      webhookSecret: 'webhook-secret', mailboxId: 'AC_mailbox', mailboxAddress: 'hello@example.test',
      accept: async () => { accepted += 1; throw new Error('non-Inbox webhook must not be accepted') },
    })
    assert.equal(nonInboxResponse.status, 200)
    assert.deepEqual(await nonInboxResponse.json(), { ok: true, ignored: true, reason: 'non_inbox_folder' })
  }
  assert.equal(accepted, 1, 'explicit Trash/Junk/Spam/Sent/Drafts/Archive webhooks are ignored before queueing')

  const locator = parseHostingerWebhookPayload(payload)
  assert.equal(locator.uid, 42)
  assert.deepEqual(locator.inReplyTo, ['<outbound@reachagent.test>'])
  assert.deepEqual(locator.references, ['<first@reachagent.test> <outbound@reachagent.test>'])
  assert.equal(locator.headers['auto-submitted'], 'no')

  const realLocator = parseHostingerWebhookPayload(fixtures.realMessageReceived)
  assert.equal(realLocator.mailboxAddress, 'hello@example.test')
  assert.equal(realLocator.from, 'owner@example.test')
  assert.equal(realLocator.subject, 'Re: Partnership')
  assert.equal(realLocator.receivedAt, '2026-09-02T01:02:03Z')
  assert.equal(realLocator.threadId, 'thr_8fk2m01x')
  assert.equal(realLocator.folder, 'INBOX')
  assert.equal(realLocator.folderProvided, false)

  const completeLocator = parseHostingerWebhookPayload({
    event: 'message.received',
    event_id: 'delivery-1',
    mailbox: 'hello@example.test',
    timestamp: '2026-09-02T01:02:03Z',
    message: {
      uid: 99,
      folder: 'INBOX.Support',
      message_id: '<complete@example.test>',
      thread_id: 'thread-1',
      from: 'Owner <owner@example.test>',
      to: ['hello@example.test'],
      subject: 'Complete locator',
    },
  })
  assert.deepEqual({
    uid: completeLocator.uid,
    providerMessageId: completeLocator.providerMessageId,
    eventId: completeLocator.eventId,
    threadId: completeLocator.threadId,
    from: completeLocator.from,
    to: completeLocator.to,
    mailboxAddress: completeLocator.mailboxAddress,
    subject: completeLocator.subject,
    receivedAt: completeLocator.receivedAt,
    folder: completeLocator.folder,
    folderProvided: completeLocator.folderProvided,
  }, {
    uid: 99,
    providerMessageId: '<complete@example.test>',
    eventId: 'delivery-1',
    threadId: 'thread-1',
    from: 'Owner <owner@example.test>',
    to: ['hello@example.test'],
    mailboxAddress: 'hello@example.test',
    subject: 'Complete locator',
    receivedAt: '2026-09-02T01:02:03Z',
    folder: 'INBOX.Support',
    folderProvided: true,
  }, 'all safe webhook locator metadata survives normalization')

  process.env.HOSTINGER_MAIL_API_TOKEN = 'test-token'
  process.env.HOSTINGER_MAILBOX_ID = 'mailbox-test'
  process.env.HOSTINGER_MAILBOX_ADDRESS = 'hello@example.test'
  process.env.HOSTINGER_MAIL_API_BASE_URL = 'https://mail.example.test'
  const { fetchHostingerInboundMessage, HOSTINGER_WEBHOOK_MATCH_TOLERANCE_MS } = await import('../src/lib/hostinger-mail')
  assert.equal(HOSTINGER_WEBHOOK_MATCH_TOLERANCE_MS, 2 * 60_000)

  const directMessage = metadataMessage(42)
  const directApi = hostingerMetadataFetch([directMessage])
  const directFlags = [...(directMessage.flags ?? [])]
  const directResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true, uid: 42, headers: {},
  }, directApi.fetch)
  assert.equal(directResult.uid, 42, 'direct webhook UID resolves through metadata detail')
  assert.equal(directApi.calls.length, 1)
  assert.deepEqual(directMessage.flags, directFlags, 'direct Inbox resolution leaves unread flags unchanged')
  assert.equal(directMessage.unseen, true)

  const messageIdApi = hostingerMetadataFetch([metadataMessage(43, { messageId: '<exact@example.test>' })])
  const messageIdResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    providerMessageId: '<exact@example.test>', headers: {},
  }, messageIdApi.fetch)
  assert.equal(messageIdResult.uid, 43, 'exact provider Message-ID resolves uniquely')

  const defaultInboxLocator = parseHostingerWebhookPayload({
    event: 'message.received',
    mailbox: 'hello@example.test',
    message: { message_id: '<default-inbox@example.test>' },
  })
  const defaultInboxApi = hostingerMetadataFetch([
    metadataMessage(430, { messageId: '<default-inbox@example.test>' }),
  ])
  const defaultInboxResult = await fetchHostingerInboundMessage(defaultInboxLocator, defaultInboxApi.fetch)
  assert.equal(defaultInboxResult.uid, 430, 'missing webhook folder resolves against INBOX')
  assert.ok(defaultInboxApi.calls.every((call) => new URL(call.url).pathname.includes('/folders/INBOX/messages/')))

  const threadApi = hostingerMetadataFetch([
    metadataMessage(44, { threadId: 'thread-match', subject: 'Different subject' }),
    metadataMessage(45, { threadId: 'other-thread' }),
  ])
  const threadResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    threadId: 'thread-match', from: 'Owner <owner@example.test>', receivedAt: '2026-09-02T01:02:03Z',
    headers: {},
  }, threadApi.fetch)
  assert.equal(threadResult.uid, 44, 'thread + exact sender + close timestamp resolves uniquely')

  const subjectApi = hostingerMetadataFetch([
    metadataMessage(46, { subject: '  RE: PARTNERSHIP  ' }),
    metadataMessage(47, { subject: 'Unrelated' }),
  ])
  const subjectResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    from: 'owner@example.test', subject: 're: partnership', receivedAt: '2026-09-02T01:02:03Z', headers: {},
  }, subjectApi.fetch)
  assert.equal(subjectResult.uid, 46, 'sender + conservatively normalized subject + timestamp resolves uniquely')

  const offsetApi = hostingerMetadataFetch([metadataMessage(48, { date: '2026-09-02T01:02:03.750Z' })])
  const offsetResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    from: 'Owner Name <OWNER@example.test>', receivedAt: '2026-09-02T11:02:03+10:00', headers: {},
  }, offsetApi.fetch)
  assert.equal(offsetResult.uid, 48, 'timezone offsets and millisecond differences compare as instants')

  const displaySenderApi = hostingerMetadataFetch([metadataMessage(49, { from: { address: 'owner@example.test' } })])
  const displaySenderResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    from: 'Owner Name <OWNER@example.test>', receivedAt: '2026-09-02T01:02:03Z', headers: {},
  }, displaySenderApi.fetch)
  assert.equal(displaySenderResult.uid, 49, 'display-name sender normalizes to the exact lowercase address')

  const ambiguousApi = hostingerMetadataFetch([metadataMessage(50), metadataMessage(51)])
  await assert.rejects(fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    from: 'owner@example.test', subject: 'Re: Partnership', receivedAt: '2026-09-02T01:02:03Z', headers: {},
  }, ambiguousApi.fetch), /could not be uniquely resolved/)
  assert.equal(
    ambiguousApi.calls.some((call) => /\/messages\/\d+$/.test(new URL(call.url).pathname)),
    false,
    'ambiguous resolution never selects the first result for detail retrieval',
  )

  const paginatedApi = hostingerMetadataFetch([
    metadataMessage(52, { from: { address: 'other@example.test' } }),
    metadataMessage(53),
  ], { forcedPageSize: 1 })
  const paginatedResult = await fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true,
    from: 'owner@example.test', receivedAt: '2026-09-02T01:02:03Z', headers: {},
  }, paginatedApi.fetch)
  assert.equal(paginatedResult.uid, 53, 'bounded date search follows pagination to an older result')
  assert.ok(paginatedApi.calls.some((call) => new URL(call.url).searchParams.get('page') === '2'))

  const movedMessage = metadataMessage(524, {
    path: 'INBOX.Trash',
    date: '2026-09-02T11:44:13Z',
    subject: 'Aussie Venture enquiry: Other',
    from: { address: 'website@aussieventure.com' },
    messageId: '<moved@example.test>',
    flags: ['\\Seen'],
    unseen: false,
  })
  const movedApi = hostingerMetadataFetch([
    movedMessage,
    metadataMessage(525, { path: 'Spam', messageId: '<spam@example.test>' }),
    metadataMessage(526, { path: 'Junk', messageId: '<junk@example.test>' }),
    metadataMessage(527, { path: 'INBOX.Sent', messageId: '<sent@example.test>' }),
  ])
  const originalFlags = [...(movedMessage.flags ?? [])]
  await assert.rejects(fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX',
    providerMessageId: '<moved@example.test>', from: 'Aussie Venture Website <website@aussieventure.com>',
    subject: 'Aussie Venture enquiry: Other', receivedAt: 'Wed, 2 Sep 2026 11:44:13 +0000', headers: {},
  }, movedApi.fetch), /could not be uniquely resolved/)
  assert.deepEqual(movedMessage.flags, originalFlags, 'failed Inbox-only resolution leaves mailbox flags unchanged')
  assert.equal(movedMessage.unseen, false)
  assert.ok(movedApi.calls.every((call) => call.method === 'GET' || call.method === 'POST'))
  assert.ok(movedApi.calls.every((call) => new URL(call.url).pathname.includes('/folders/INBOX/messages/')),
    'Trash, Spam, Junk, and Sent are never searched as fallback folders')
  assert.ok(movedApi.calls.every((call) => !new URL(call.url).pathname.endsWith('/folders')),
    'inbound resolution never enumerates mailbox folders')
  assert.ok(movedApi.calls.every((call) => !/\/(text|source|attachments)(?:\/|$)/.test(new URL(call.url).pathname)))

  const movedDirectApi = hostingerMetadataFetch([movedMessage])
  await assert.rejects(fetchHostingerInboundMessage({
    eventType: 'message.received', folder: 'INBOX', folderProvided: true, uid: 524, headers: {},
  }, movedDirectApi.fetch), /not found in Inbox; it may have been moved or deleted/)
  assert.equal(movedDirectApi.calls.length, 1)
  assert.ok(new URL(movedDirectApi.calls[0].url).pathname.includes('/folders/INBOX/messages/524'),
    'a moved direct UID is checked only in INBOX and is not recovered from Trash')

  for (const folder of ['INBOX.Trash', 'Trash', 'Junk', 'Spam', 'INBOX.Sent', 'Sent']) {
    const explicitNonInboxApi = hostingerMetadataFetch([movedMessage])
    await assert.rejects(fetchHostingerInboundMessage({
      eventType: 'message.received', folder, folderProvided: true, uid: 524, headers: {},
    }, explicitNonInboxApi.fetch), /webhook folder is not Inbox/)
    assert.equal(explicitNonInboxApi.calls.length, 0, `${folder} locator is rejected without an API request`)
  }

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
  assert.doesNotMatch(mailSource, /resolutionFolders/)
  assert.match(mailSource, /getMessageMetadata\(locator, config, fetchImpl\)/)
  assert.match(mailSource, /metadataHeaders\(message, locator\)/)

  const migrationSource = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/052_hostinger_inbound_reliability.sql'), 'utf8')
  assert.match(migrationSource, /CREATE INDEX IF NOT EXISTS emails_message_id_not_null_idx/)
  assert.match(migrationSource, /WHERE message_id IS NOT NULL/)

  console.log('✓ fast acknowledgement, durable queueing, dedupe, retry, metadata-only retrieval, and unchanged flags')
}

main().catch((error) => { console.error(error); process.exit(1) })
