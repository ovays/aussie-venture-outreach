import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EmailReportRow } from '../src/lib/email-report'
import {
  EMAIL_REPORT_DISPLAY_TIME_ZONE,
  emailStatusLabel,
  filterEmailReportRows,
  formatSydneyTimestamp,
  generateEmailReportCsv,
  getEmailReportPresetRange,
  getSydneyCalendarDate,
  reachAgentStatusLabel,
  validateEmailReportUiRange,
} from '../src/lib/email-report-ui'

assert.equal(EMAIL_REPORT_DISPLAY_TIME_ZONE, 'Australia/Sydney')

const sydneySeptemberFirst = new Date('2026-08-31T14:30:00.000Z')
assert.equal(getSydneyCalendarDate(sydneySeptemberFirst), '2026-09-01', 'Today uses the Sydney calendar date')
assert.deepEqual(
  getEmailReportPresetRange('last_30_days', sydneySeptemberFirst),
  { from: '2026-08-03', to: '2026-09-01' },
  'default Last 30 Days is an inclusive Sydney calendar range',
)
assert.deepEqual(getEmailReportPresetRange('today', sydneySeptemberFirst), { from: '2026-09-01', to: '2026-09-01' })
assert.deepEqual(getEmailReportPresetRange('yesterday', sydneySeptemberFirst), { from: '2026-08-31', to: '2026-08-31' })
assert.deepEqual(getEmailReportPresetRange('this_month', sydneySeptemberFirst), { from: '2026-09-01', to: '2026-09-01' })

const sydneyNewYear = new Date('2025-12-31T13:30:00.000Z')
assert.equal(getSydneyCalendarDate(sydneyNewYear), '2026-01-01', 'Sydney calendar handling crosses the UTC year boundary')
assert.deepEqual(getEmailReportPresetRange('yesterday', sydneyNewYear), { from: '2025-12-31', to: '2025-12-31' })
assert.deepEqual(getEmailReportPresetRange('this_month', sydneyNewYear), { from: '2026-01-01', to: '2026-01-01' })
assert.deepEqual(
  getEmailReportPresetRange('yesterday', new Date('2026-02-28T13:30:00.000Z')),
  { from: '2026-02-28', to: '2026-02-28' },
  'Yesterday handles a Sydney month boundary',
)

assert.equal(formatSydneyTimestamp('2026-06-01T03:30:00.000Z'), '1 Jun 2026, 1:30 pm', 'AEST display is correct')
assert.equal(formatSydneyTimestamp('2026-01-01T02:30:00.000Z'), '1 Jan 2026, 1:30 pm', 'AEDT display is correct')
assert.equal(validateEmailReportUiRange({ from: '2026-09-02', to: '2026-09-01' }), 'From date must be on or before To date.')
assert.equal(validateEmailReportUiRange({ from: '2025-01-01', to: '2026-01-02' }), 'Date range cannot exceed 366 days.')
assert.equal(validateEmailReportUiRange({ from: '2026-02-30', to: '2026-03-01' }), 'Enter valid From and To dates.')
assert.equal(validateEmailReportUiRange({ from: '2026-01-01', to: '2026-12-31' }), null)

const baseRow: EmailReportRow = {
  email: 'hello@alpha.example',
  email_addresses: ['hello@alpha.example', 'sales@alpha.example'],
  business_name: 'Alpha Adventures',
  lead_id: 'lead-1',
  reachagent_status: 'contacted',
  received_count: 1,
  sent_count: 2,
  first_activity_at: '2026-08-01T00:00:00.000Z',
  last_activity_at: '2026-08-02T00:00:00.000Z',
  last_direction: 'sent',
  email_status: 'replied',
}
const rows: EmailReportRow[] = [
  baseRow,
  {
    ...baseRow,
    email: 'contact@beta.example',
    email_addresses: ['contact@beta.example'],
    business_name: 'Beta Bakery',
    lead_id: null,
    reachagent_status: 'not_found',
    email_status: 'sent_only',
    last_direction: 'sent',
    last_activity_at: '2026-08-03T00:00:00.000Z',
  },
  {
    ...baseRow,
    email: 'team@gamma.example',
    email_addresses: ['team@gamma.example'],
    business_name: null,
    lead_id: null,
    reachagent_status: 'ambiguous',
    matching_lead_count: 2,
    email_status: 'awaiting_reply',
    last_direction: 'received',
    last_activity_at: '2026-08-04T00:00:00.000Z',
  },
]

assert.deepEqual(filterEmailReportRows(rows, 'alpha', '', '').map((row) => row.email), ['hello@alpha.example'], 'searches by business')
assert.deepEqual(filterEmailReportRows(rows, 'sales@alpha.example', '', '').map((row) => row.email), ['hello@alpha.example'], 'searches secondary associated emails')
assert.deepEqual(filterEmailReportRows(rows, 'beta.example', '', '').map((row) => row.email), ['contact@beta.example'], 'searches by email')
assert.deepEqual(filterEmailReportRows(rows, '', 'awaiting_reply', '').map((row) => row.email), ['team@gamma.example'], 'filters Email Status')
assert.deepEqual(filterEmailReportRows(rows, '', '', 'contacted').map((row) => row.email), ['hello@alpha.example'], 'filters ReachAgent status')
assert.equal(filterEmailReportRows(rows, '', '', '')[0].email, 'team@gamma.example', 'newest activity sorts first')
assert.equal(emailStatusLabel('replied'), 'Replied')
assert.equal(emailStatusLabel('awaiting_reply'), 'Awaiting Reply')
assert.equal(emailStatusLabel('sent_only'), 'Sent Only')
assert.equal(reachAgentStatusLabel('not_found'), 'Not in ReachAgent')
assert.equal(reachAgentStatusLabel('ambiguous', 2), 'Multiple Leads (2)')

const filteredCsv = generateEmailReportCsv(filterEmailReportRows(rows, '', 'replied', 'contacted'))
assert.match(filteredCsv, /^Business,Email Addresses,ReachAgent Status,Received,Sent,Email Status,Last Activity,Last Direction\r\n/)
assert.match(filteredCsv, /Alpha Adventures,hello@alpha\.example; sales@alpha\.example,Contacted,1,2,Replied,"2 Aug 2026, 10:00 am",Sent/)
assert.doesNotMatch(filteredCsv, /Beta Bakery|gamma\.example/, 'CSV is generated from rows after active filters')
assert.equal(filteredCsv.split('\r\n').length, 2, 'grouped business exports as one CSV record')

const escapedCsv = generateEmailReportCsv([{
  ...baseRow,
  business_name: 'Alpha, "Adventure"\nSydney',
}])
assert.match(escapedCsv, /"Alpha, ""Adventure""\nSydney"/, 'CSV safely escapes commas, quotes, and newlines')
assert.match(escapedCsv, /hello@alpha\.example; sales@alpha\.example/, 'multiple addresses share one CSV field')
assert.match(escapedCsv, /"2 Aug 2026, 10:00 am"/, 'CSV timestamps use the Sydney formatter')

const pageSource = readFileSync(resolve('src/app/dashboard/email-report/page.tsx'), 'utf8')
const componentSource = readFileSync(resolve('src/components/email-report/EmailReportDashboard.tsx'), 'utf8')
const sidebarSource = readFileSync(resolve('src/components/layout/Sidebar.tsx'), 'utf8')

assert.match(pageSource, /EmailReportDashboard/, 'page renders the report dashboard')
assert.match(pageSource, /TopBar title="Email Report"/, 'page uses the existing dashboard header')
assert.match(sidebarSource, /\/dashboard\/email-report/, 'authenticated sidebar navigation is present')
assert.match(componentSource, /getEmailReportPresetRange\('last_30_days'\)/, 'page defaults to Last 30 Days')
assert.match(componentSource, /fetch\(`\/api\/email-report\?/, 'the report uses the single P1 endpoint')
assert.match(componentSource, /method: 'GET'/, 'the report request is explicitly read-only')
assert.doesNotMatch(componentSource, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/, 'no mutation requests exist')
assert.match(componentSource, /row\.lead_id[\s\S]*openLead\(row\.lead_id!\)/, 'lead navigation is only rendered when lead_id exists')
assert.match(componentSource, /LoadingRows/, 'loading state is rendered')
assert.match(componentSource, /No email activity found for this date range/, 'empty state is rendered')
assert.match(componentSource, /Unable to load email activity from Hostinger Mail/, 'Hostinger error state is rendered')
assert.match(componentSource, /formatSydneyTimestamp\(row\.last_activity_at\)/, 'all report timestamps use the Sydney formatter')
assert.match(componentSource, /row\.last_direction/, 'backend communication direction is displayed directly')
assert.match(componentSource, /Export CSV/, 'CSV export control exists')
assert.match(componentSource, /generateEmailReportCsv\(filteredRows\)/, 'CSV export respects currently filtered grouped rows')
assert.match(componentSource, /row\.email_addresses/, 'grouped addresses are displayed by the report UI')

console.log('Email report UI tests passed')
