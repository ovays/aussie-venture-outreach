import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildEmailReportActivityRows,
  completeEmailReport,
  EMAIL_REPORT_MAX_DAYS,
  EMAIL_REPORT_PUBLIC_DOMAINS,
  emailReportBusinessDomain,
  EmailReportValidationError,
  fetchEmailReportLeads,
  normalizeEmailReportAddress,
  normalizeEmailReportDomain,
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
assert.deepEqual(grouped.email_addresses, ['abc@company.com'])

const businessDomainRows = buildEmailReportActivityRows(mailbox(
  [
    received(2, '2026-09-01T01:00:00.000Z', 'marketing@immersivegamebox.com'),
    received(4, '2026-09-01T03:00:00.000Z', 'bookings@immersivegamebox.com'),
  ],
  [
    sent(1, '2026-09-01T00:00:00.000Z', 'help@immersivegamebox.com'),
    sent(3, '2026-09-01T02:00:00.000Z', 'marketing@immersivegamebox.com'),
    sent(5, '2026-09-01T04:00:00.000Z', 'bookings@immersivegamebox.com'),
  ],
))
assert.equal(businessDomainRows.length, 1, 'addresses on one business-owned domain combine into one row')
const businessDomainRow = businessDomainRows[0]
assert.deepEqual(businessDomainRow.email_addresses, [
  'bookings@immersivegamebox.com',
  'help@immersivegamebox.com',
  'marketing@immersivegamebox.com',
])
assert.equal(businessDomainRow.received_count, 2, 'received counts aggregate across domain addresses')
assert.equal(businessDomainRow.sent_count, 3, 'sent counts aggregate across domain addresses')
assert.equal(businessDomainRow.last_activity_at, '2026-09-01T04:00:00.000Z', 'latest domain activity wins')
assert.equal(businessDomainRow.last_direction, 'sent', 'latest domain activity determines direction')
assert.equal(businessDomainRow.email_status, 'replied', 'status is recalculated from combined chronological activity')

const publicDomainRows = buildEmailReportActivityRows(mailbox(
  [
    received(1, '2026-09-01T00:00:00.000Z', 'business-one@gmail.com'),
    received(2, '2026-09-01T01:00:00.000Z', 'business-two@gmail.com'),
    received(3, '2026-09-01T02:00:00.000Z', 'one@outlook.com'),
    received(4, '2026-09-01T03:00:00.000Z', 'two@outlook.com'),
    received(5, '2026-09-01T04:00:00.000Z', 'one@hotmail.com'),
    received(6, '2026-09-01T05:00:00.000Z', 'two@hotmail.com'),
  ],
  [],
))
assert.equal(publicDomainRows.length, 6, 'public-provider addresses remain separate contact-level rows')
assert.equal(publicDomainRows.filter((row) => row.email.endsWith('@gmail.com')).length, 2, 'Gmail contacts stay separate')
assert.equal(publicDomainRows.filter((row) => /@(outlook|hotmail)\.com$/.test(row.email)).length, 4, 'Outlook and Hotmail contacts stay separate')
for (const domain of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'me.com', 'msn.com', 'proton.me', 'protonmail.com']) {
  assert.equal(EMAIL_REPORT_PUBLIC_DOMAINS.has(domain), true, `${domain} is configured as a public domain`)
}

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

const vrQuestRow = rowFor(
  [received(10, '2026-09-01T05:00:00.000Z', 'admin@vrquest.com.au')],
  [],
)
const vrQuestReport = completeEmailReport(range, [vrQuestRow], [{
  id: 'lead-vr-quest',
  business_name: 'VR Quest',
  email: 'Enquiry@VRQUEST.COM.AU',
  status: 'replied',
}])
assert.equal(vrQuestReport.rows[0].lead_id, 'lead-vr-quest', 'a unique business-domain lead resolves a different mailbox')
assert.equal(vrQuestReport.rows[0].business_name, 'VR Quest', 'domain fallback uses the ReachAgent business name')
assert.equal(vrQuestReport.rows[0].reachagent_status, 'replied', 'domain fallback uses the current ReachAgent status')
assert.equal(vrQuestReport.rows[0].email, 'admin@vrquest.com.au', 'the actual communication email remains primary')
assert.deepEqual(vrQuestReport.rows[0].email_addresses, ['admin@vrquest.com.au'])

const exactPrecedenceReport = completeEmailReport(range, [vrQuestRow], [
  { id: 'lead-exact', business_name: 'Exact VR Quest', email: 'admin@vrquest.com.au', status: 'contacted' },
  { id: 'lead-domain', business_name: 'Other VR Quest', email: 'enquiry@vrquest.com.au', status: 'replied' },
])
assert.equal(exactPrecedenceReport.rows[0].lead_id, 'lead-exact', 'one exact email match wins over conflicting domain leads')
assert.equal(exactPrecedenceReport.rows[0].reachagent_status, 'contacted')

const sameDomainLeadReport = completeEmailReport(range, [vrQuestRow], [
  { id: 'lead-vr-quest', business_name: 'VR Quest', email: 'enquiry@vrquest.com.au', status: 'replied' },
  { id: 'lead-vr-quest', business_name: 'VR Quest', email: 'bookings@vrquest.com.au', status: 'replied' },
])
assert.equal(sameDomainLeadReport.rows[0].lead_id, 'lead-vr-quest', 'multiple domain addresses for the same lead ID remain safe')

const ambiguousDomainFallback = completeEmailReport(range, [vrQuestRow], [
  { id: 'lead-vr-one', business_name: 'VR One', email: 'enquiry@vrquest.com.au', status: 'contacted' },
  { id: 'lead-vr-two', business_name: 'VR Two', email: 'bookings@vrquest.com.au', status: 'replied' },
])
assert.equal(ambiguousDomainFallback.rows[0].reachagent_status, 'ambiguous', 'distinct domain-only leads are ambiguous')
assert.equal(ambiguousDomainFallback.rows[0].lead_id, null)
assert.equal(ambiguousDomainFallback.rows[0].matching_lead_count, 2)

for (const domain of EMAIL_REPORT_PUBLIC_DOMAINS) {
  const publicRow = rowFor(
    [received(11, '2026-09-01T06:00:00.000Z', `communication@${domain}`)],
    [],
  )
  const publicFallbackReport = completeEmailReport(range, [publicRow], [{
    id: `lead-${domain}`,
    business_name: 'Unrelated public mailbox',
    email: `different@${domain}`,
    status: 'replied',
  }])
  assert.equal(publicFallbackReport.rows[0].reachagent_status, 'not_found', `${domain} never uses domain fallback`)
}

assert.equal(normalizeEmailReportDomain('  VRQUEST.COM.AU  '), 'vrquest.com.au', 'domains normalize case and whitespace')
assert.equal(emailReportBusinessDomain(['ADMIN@VRQUEST.COM.AU']), 'vrquest.com.au')
const substringDomainReport = completeEmailReport(range, [vrQuestRow], [
  { id: 'lead-prefix', business_name: 'Prefix', email: 'hello@fakevrquest.com.au', status: 'replied' },
  { id: 'lead-suffix', business_name: 'Suffix', email: 'hello@vrquest.com.au.example.com', status: 'replied' },
])
assert.equal(substringDomainReport.rows[0].reachagent_status, 'not_found', 'domain comparison is exact rather than substring based')

const groupedLeadReport = completeEmailReport(range, [businessDomainRow], [
  { id: 'lead-gamebox', business_name: 'Immersive Gamebox Sydney', email: 'marketing@immersivegamebox.com', status: 'contacted' },
])
assert.equal(groupedLeadReport.rows[0].lead_id, 'lead-gamebox', 'one associated address can resolve the grouped business')
assert.equal(groupedLeadReport.rows[0].business_name, 'Immersive Gamebox Sydney')

const sameLeadReport = completeEmailReport(range, [businessDomainRow], [
  { id: 'lead-gamebox', business_name: 'Immersive Gamebox Sydney', email: 'help@immersivegamebox.com', status: 'contacted' },
  { id: 'lead-gamebox', business_name: 'Immersive Gamebox Sydney', email: 'marketing@immersivegamebox.com', status: 'contacted' },
])
assert.equal(sameLeadReport.rows[0].lead_id, 'lead-gamebox', 'multiple associated addresses resolving to the same lead remain safe')
assert.equal(sameLeadReport.rows[0].reachagent_status, 'contacted')

const conflictingDomainReport = completeEmailReport(range, [businessDomainRow], [
  { id: 'lead-one', business_name: 'First Lead', email: 'help@immersivegamebox.com', status: 'contacted' },
  { id: 'lead-two', business_name: 'Second Lead', email: 'marketing@immersivegamebox.com', status: 'replied' },
])
assert.equal(conflictingDomainReport.rows[0].reachagent_status, 'ambiguous', 'different leads under one domain are explicit')
assert.equal(conflictingDomainReport.rows[0].lead_id, null, 'a conflicting lead identity is never selected')
assert.equal(conflictingDomainReport.rows[0].matching_lead_count, 2)

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
  const migrationSource = readFileSync(resolve('supabase/migrations/047_email_report_lead_domain_lookup.sql'), 'utf8')
  assert.doesNotMatch(
    `${reportSource}\n${routeSource}`,
    /\.\s*(?:insert|update|upsert|delete)\s*\(/,
    'email report logic contains no Supabase write methods',
  )
  assert.match(reportSource, /\.rpc\('get_email_report_leads'/, 'lead matching uses the report-scoped batched RPC')
  assert.match(migrationSource, /leads_email_report_address_idx/, 'exact email lookup has an expression index')
  assert.match(migrationSource, /leads_email_report_domain_idx/, 'domain lookup has an expression index')
  assert.match(migrationSource, /= ANY \(p_domains\)/, 'eligible domains are compared as a batch')
  assert.doesNotMatch(reportSource, /from\('emails'\)|from\('activity_log'\)/, 'report does not touch outreach or reply records')

  const rpcCalls: Array<{ name: string; args: { p_addresses: string[]; p_domains: string[] } }> = []
  const fakeSupabase = {
    rpc(name: string, args: { p_addresses: string[]; p_domains: string[] }) {
      rpcCalls.push({ name, args })
      return {
        async range() {
          return { data: [], error: null }
        },
      }
    },
  }
  await fetchEmailReportLeads(fakeSupabase as never, [vrQuestRow, ...publicDomainRows])
  assert.equal(rpcCalls.length, 1, 'all report rows use one lookup request rather than N+1 requests')
  assert.equal(rpcCalls[0].name, 'get_email_report_leads')
  assert.deepEqual(rpcCalls[0].args.p_domains, ['vrquest.com.au'], 'only eligible unique business domains are sent')
  assert.ok(rpcCalls[0].args.p_addresses.includes('admin@vrquest.com.au'), 'exact addresses are included in the same lookup')
  assert.ok(rpcCalls[0].args.p_addresses.includes('business-one@gmail.com'), 'public addresses remain eligible for exact matching')

  console.log('Email report tests passed')
}

testPaginationAndReadOnlyContract().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
