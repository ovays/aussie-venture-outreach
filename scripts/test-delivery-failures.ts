import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extractDeliveryFailureReason,
  mapDeliveryFailureRow,
  parseDeliveryFailureFilters,
} from '../src/lib/delivery-failure-report'

function params(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null }
}

const providerBase = {
  email_id: 'email-1',
  lead_id: 'lead-1',
  business_name: 'Original Business',
  recipient: 'old-address@example.com',
  category_name: 'Travel Agents',
  city: 'Sydney',
  email_type: 'initial_pitch',
  failure_date: '2026-08-30T01:00:00.000Z',
  resend_id: 're_123',
  has_provider_event: true,
}

const bounced = mapDeliveryFailureRow({
  ...providerBase,
  failure_status: 'bounced',
  failure_metadata: { provider_reason: { message: 'Mailbox does not exist' } },
})
assert.equal(bounced.failure_status, 'bounced', 'bounced email appears with bounced status')
assert.equal(bounced.email_address, 'old-address@example.com', 'historical recipient is used instead of a replacement lead email')
assert.equal(bounced.failure_reason, 'Mailbox does not exist', 'provider reason is extracted from nested metadata')
assert.equal(bounced.failure_source, 'provider', 'bounce is classified as a provider failure')

const suppressed = mapDeliveryFailureRow({
  ...providerBase,
  failure_status: 'suppressed',
  email_type: 'follow_up_2',
  failure_metadata: { provider_reason: { reason: 'Recipient is on the suppression list' } },
})
assert.equal(suppressed.failure_status, 'suppressed', 'suppressed email appears')
assert.equal(suppressed.email_type, 'follow_up_2', 'follow-up email type is retained')

const providerFailed = mapDeliveryFailureRow({
  ...providerBase,
  failure_status: 'failed',
  email_type: 'reactivation',
  failure_metadata: { provider_reason: { response: { error: { message: 'Rejected by recipient server' } } } },
})
assert.equal(providerFailed.failure_source, 'provider', 'failed row with terminal event is classified as provider failure')
assert.equal(providerFailed.failure_reason, 'Rejected by recipient server')

const localFailed = mapDeliveryFailureRow({
  ...providerBase,
  failure_status: 'failed',
  has_provider_event: false,
  resend_id: null,
  failure_metadata: null,
})
assert.equal(localFailed.failure_source, 'local_api', 'failed row without terminal audit event is classified as local/API failure')
assert.equal(localFailed.provider, 'Local/API')
assert.equal(localFailed.failure_reason, 'No local/API reason recorded', 'missing local failure reason is safe')

assert.equal(extractDeliveryFailureReason(null, 'provider'), 'No provider reason recorded', 'missing provider reason is safe')
assert.equal(extractDeliveryFailureReason('{malformed', 'provider'), '{malformed', 'malformed-looking string metadata does not crash')

const missingLead = mapDeliveryFailureRow({
  ...providerBase,
  lead_id: null,
  business_name: null,
  failure_status: 'bounced',
  failure_metadata: {},
})
assert.equal(missingLead.lead_id, null, 'missing/deleted lead is represented without crashing')
assert.equal(missingLead.business_name, null)

const filtered = parseDeliveryFailureFilters(params({
  status: 'suppressed',
  type: 'follow_up_3',
  search: '  Business@example.com  ',
  page: '3',
  page_size: '25',
}))
assert.deepEqual(filtered, {
  status: 'suppressed',
  emailType: 'follow_up_3',
  search: 'Business@example.com',
  page: 3,
  pageSize: 25,
}, 'status, email type, business/email search, and pagination are parsed server-side')

const invalidFilters = parseDeliveryFailureFilters(params({ status: 'sent', type: 'newsletter', page: '-1', page_size: '1000' }))
assert.equal(invalidFilters.status, null, 'non-terminal status cannot enter the report query')
assert.equal(invalidFilters.emailType, null, 'unsupported email type is ignored')
assert.equal(invalidFilters.page, 1)
assert.equal(invalidFilters.pageSize, 100, 'page size remains bounded')

const migration = readFileSync(resolve('supabase/migrations/044_delivery_failure_report.sql'), 'utf8')
assert.match(migration, /emails\.status IN \('bounced', 'failed', 'suppressed'\)/, 'only failure statuses are queried; sent/delivered rows cannot appear')
assert.match(migration, /p_status[\s\S]*p_email_type[\s\S]*p_search[\s\S]*p_page[\s\S]*p_page_size/, 'RPC supports server-side filters and pagination')
assert.match(migration, /ORDER BY failures\.failure_date DESC/, 'failures are ordered most recent first')
assert.match(migration, /metadata ->> 'recipient'/, 'historical recipient is preferred in query and search')
assert.match(migration, /metadata ->> 'persisted_status'/, 'historical rows use the absorbing status that was actually persisted')
assert.match(migration, /LEFT JOIN public\.leads/, 'missing leads do not remove or crash otherwise-retained report rows')
assert.match(migration, /historical_provider_events[\s\S]*activity_log\.lead_id IS NULL/, 'orphaned terminal audit events remain in the historical report')
assert.match(migration, /COUNT\(\*\) FILTER \(WHERE failure_status = 'bounced'\)/, 'summary counts are computed in the database')
assert.match(migration, /activity_log_delivery_email_created_at_idx/, 'terminal metadata correlation has a focused index')

const route = readFileSync(resolve('src/app/api/delivery-failures/route.ts'), 'utf8')
assert.match(route, /get_delivery_failure_report/, 'API uses the bounded report RPC instead of loading all emails')
assert.doesNotMatch(route, /failure_metadata\s*:/, 'API does not expose raw metadata fields')

const component = readFileSync(resolve('src/components/delivery-failures/DeliveryFailuresTable.tsx'), 'utf8')
assert.match(component, /fetch\(`\/api\/leads\/\$\{deleteTarget\.lead_id\}`/, 'Delete Lead reuses the established lead deletion endpoint')
assert.match(component, /title="Delete lead\?"/, 'Delete Lead requires confirmation')
assert.match(component, /No delivery failures found\./, 'report has a clean empty state')
assert.match(component, /Local\/API send failure/, 'local/API failures are visibly distinguished')

const leadRoute = readFileSync(resolve('src/app/api/leads/[id]/route.ts'), 'utf8')
const deleteHandler = leadRoute.slice(leadRoute.indexOf('export async function DELETE'))
assert.doesNotMatch(deleteHandler, /from\('activity_log'\)\.delete\(\)/, 'shared lead deletion preserves audit history through ON DELETE SET NULL')

console.log('Delivery failure report tests passed')
