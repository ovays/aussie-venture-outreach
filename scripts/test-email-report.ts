import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildEmailReportActivityRows,
  completeEmailReport,
  EMAIL_REPORT_MAX_DAYS,
  EmailReportValidationError,
  normalizeEmailReportAddress,
  parseEmailReportDateRange,
  type EmailReportLead,
} from '../src/lib/email-report'
import { collectHostingerPages } from '../src/lib/hostinger-pagination'
import type { HostingerMessageMetadata, HostingerReportMailboxMessages } from '../src/lib/hostinger-mail'

const OWN = 'hello@aussieventure.com'

function received(uid: number, date: string, from: string): HostingerMessageMetadata {
  return { uid, path: 'INBOX', date, from: { address: from }, to: [{ address: OWN }] }
}

function sent(uid: number, date: string, to: string): HostingerMessageMetadata {
  return { uid, path: 'INBOX.Sent', date, from: { address: OWN }, to: [{ address: to }] }
}

function mailbox(
  inbox: HostingerMessageMetadata[],
  sentMessages: HostingerMessageMetadata[],
): HostingerReportMailboxMessages {
  return { mailboxAddress: OWN, sentFolder: 'INBOX.Sent', received: inbox, sent: sentMessages }
}

function rowFor(inbox: HostingerMessageMetadata[], sentMessages: HostingerMessageMetadata[]) {
  const rows = buildEmailReportActivityRows(mailbox(inbox, sentMessages))
  assert.equal(rows.length, 1)
  return rows[0]
}

const replied = rowFor(
  [received(1, '2026-09-01T00:00:00.000Z', 'abc@company.com')],
  [sent(2, '2026-09-01T01:00:00.000Z', 'abc@company.com')],
)
assert.equal(replied.email_status, 'replied', 'received then sent is replied')
assert.equal(replied.last_direction, 'sent')

const awaiting = rowFor(
  [received(2, '2026-09-01T01:00:00.000Z', 'abc@company.com')],
  [sent(1, '2026-09-01T00:00:00.000Z', 'abc@company.com')],
)
assert.equal(awaiting.email_status, 'awaiting_reply', 'sent then received is awaiting reply')
assert.equal(awaiting.last_direction, 'received')

const sentOnly = rowFor([], [sent(1, '2026-09-01T00:00:00.000Z', 'abc@company.com')])
assert.equal(sentOnly.email_status, 'sent_only', 'outbound-only contact is sent only')

const grouped = rowFor(
  [
    received(1, '2026-09-01T00:00:00.000Z', 'ABC@Company.com'),
    received(2, '2026-09-01T00:30:00.000Z', 'abc@company.com'),
    received(3, '2026-09-01T01:00:00.000Z', 'ABC <abc@company.com>'),
  ],
  [
    sent(4, '2026-09-01T02:00:00.000Z', 'Abc@Company.Com'),
    sent(5, '2026-09-01T03:00:00.000Z', 'abc@company.com'),
  ],
)
assert.equal(grouped.email, 'abc@company.com', 'email normalization is case-insensitive and extracts display-name forms')
assert.equal(grouped.received_count, 3, 'all inbound messages count on one unique row')
assert.equal(grouped.sent_count, 2, 'all outbound messages count on one unique row')

const ownExcluded = buildEmailReportActivityRows(mailbox(
  [received(1, '2026-09-01T00:00:00.000Z', ' Hello <HELLO@AUSSIEVENTURE.COM> ')],
  [sent(2, '2026-09-01T01:00:00.000Z', 'hello@aussieventure.com')],
))
assert.deepEqual(ownExcluded, [], 'the configured mailbox address is excluded in either direction')
assert.equal(normalizeEmailReportAddress(' Example Person <TEST@Example.COM> '), 'test@example.com')

const range = { from: '2026-09-01', to: '2026-09-01' }
const matchingLead: EmailReportLead = {
  id: 'lead-1', business_name: 'ABC Company', email: 'ABC@COMPANY.COM', status: 'dead',
}
const matchedReport = completeEmailReport(range, [sentOnly], [matchingLead])
assert.equal(matchedReport.rows[0].lead_id, 'lead-1')
assert.equal(matchedReport.rows[0].business_name, 'ABC Company')
assert.equal(matchedReport.rows[0].reachagent_status, 'dead', 'current ReachAgent status is returned exactly')
assert.deepEqual(matchedReport.summary.reachagent_status_counts, { dead: 1 }, 'status totals are dynamic')

const noLeadReport = completeEmailReport(range, [sentOnly], [])
assert.equal(noLeadReport.rows[0].reachagent_status, 'not_found', 'unmatched email is explicit')
assert.equal(noLeadReport.rows[0].lead_id, null)

const ambiguousReport = completeEmailReport(range, [sentOnly], [
  matchingLead,
  { id: 'lead-2', business_name: 'Duplicate', email: 'abc@company.com', status: 'replied' },
])
assert.equal(ambiguousReport.rows[0].reachagent_status, 'ambiguous', 'duplicate leads are never selected arbitrarily')
assert.equal(ambiguousReport.rows[0].lead_id, null)
assert.equal(ambiguousReport.rows[0].business_name, null)
assert.equal(ambiguousReport.rows[0].matching_lead_count, 2)

const sydneyWinter = parseEmailReportDateRange('2026-09-01', '2026-09-01')
assert.equal(sydneyWinter.startInclusive.toISOString(), '2026-08-31T14:00:00.000Z', 'Sydney winter midnight is used')
assert.equal(sydneyWinter.endExclusive.toISOString(), '2026-09-01T14:00:00.000Z')
const sydneySummer = parseEmailReportDateRange('2026-01-01', '2026-01-01')
assert.equal(sydneySummer.startInclusive.toISOString(), '2025-12-31T13:00:00.000Z', 'Sydney daylight saving is used')

for (const values of [
  [null, '2026-09-01'],
  ['2026-02-30', '2026-03-01'],
  ['2026/09/01', '2026-09-01'],
  ['2026-09-02', '2026-09-01'],
] as Array<[string | null, string | null]>) {
  assert.throws(() => parseEmailReportDateRange(...values), EmailReportValidationError)
}
assert.throws(
  () => parseEmailReportDateRange('2025-01-01', '2026-01-02'),
  new RegExp(`${EMAIL_REPORT_MAX_DAYS}`),
  'date range is bounded to one leap-year-sized reporting window',
)

async function testPaginationAndReadOnlyContract(): Promise<void> {
  const requestedPages: number[] = []
  const paginated = await collectHostingerPages(async (page) => {
    requestedPages.push(page)
    return { items: [`page-${page}`], totalPages: 3 }
  })
  assert.deepEqual(requestedPages, [1, 2, 3], 'all Hostinger pagination pages are requested')
  assert.deepEqual(paginated, ['page-1', 'page-2', 'page-3'], 'messages from every page are retained')

  const reportSource = readFileSync(resolve('src/lib/email-report.ts'), 'utf8')
  const routeSource = readFileSync(resolve('src/app/api/email-report/route.ts'), 'utf8')
  assert.doesNotMatch(
    `${reportSource}\n${routeSource}`,
    /\.\s*(?:insert|update|upsert|delete)\s*\(/,
    'email report logic contains no Supabase write methods',
  )
  assert.match(reportSource, /\.from\('leads'\)[\s\S]*\.select\(/, 'lead matching uses a single batched read path')
  assert.doesNotMatch(reportSource, /from\('emails'\)|from\('activity_log'\)/, 'report does not touch outreach or reply records')

  console.log('Email report tests passed')
}

testPaginationAndReadOnlyContract().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
