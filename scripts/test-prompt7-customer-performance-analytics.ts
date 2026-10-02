import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(path, 'utf8')
const migration = read('supabase-v2/migrations/00000000000023_customer_performance_analytics.sql')
const leadsApi = read('src/app/api/customer-leads/route.ts')
const leadDetailApi = read('src/app/api/customer-leads/[id]/route.ts')
const inboxApi = read('src/app/api/customer-inbox/route.ts')
const inboxData = read('src/lib/customer-inbox.ts')
const analyticsPage = read('src/app/dashboard/analytics/page.tsx')
const analyticsData = read('src/lib/customer-analytics.ts')

assert.match(leadsApi, /defaultPageSize:\s*25/)
assert.match(leadsApi, /maxPageSize:\s*50/)
assert.match(leadsApi, /get_customer_leads_page/)
assert.ok(!/\.from\(['"]leads['"]\)/.test(leadsApi) || !/select\(['"]\*['"]\)/.test(leadsApi))
assert.match(inboxApi, /defaultPageSize:\s*CUSTOMER_INBOX_PAGE_SIZE/)
assert.match(inboxApi, /maxPageSize:\s*CUSTOMER_INBOX_PAGE_SIZE/)
assert.match(inboxData, /CUSTOMER_INBOX_PAGE_SIZE = 25/)
assert.match(inboxData, /CUSTOMER_INBOX_MESSAGE_LIMIT = 50/)
assert.match(inboxData, /get_customer_inbox_page/)
assert.doesNotMatch(inboxData, /emails!inner/)

assert.match(migration, /LEAST\(GREATEST\(COALESCE\(p_page_size,25\),1\),50\)/)
assert.match(migration, /LEAST\(GREATEST\(COALESCE\(p_page_size,25\),1\),25\)/)
assert.equal((migration.match(/page_number::bigint-1\)\*page_size::bigint/g) ?? []).length, 2)
assert.match(migration, /WHERE l\.workspace_id=p_workspace_id/)
assert.match(migration, /WHERE e\.workspace_id=p_workspace_id/)
assert.match(migration, /WHERE i\.workspace_id=p_workspace_id/)
assert.match(migration, /get_customer_analytics/)
assert.match(migration, /reactivation_delay_days'[\s\S]*?,90\)/)
assert.match(leadDetailApi, /settingMap\.get\('reactivation_delay_days'\) \?\? '90'/)
assert.match(migration, /CASE WHEN t\.contacted=0 THEN 0/)

const ownershipTransfer = migration.indexOf(
  'ALTER FUNCTION public.get_customer_leads_page(\n  uuid,\n  text,\n  text,\n  integer,\n  integer,\n  timestamptz\n) OWNER TO reachagent_function_owner;',
)
const schemaCreateGrant = migration.indexOf('GRANT CREATE ON SCHEMA public TO reachagent_function_owner;')
const setRole = migration.indexOf('SET ROLE reachagent_function_owner;')
assert.ok(
  schemaCreateGrant >= 0 && schemaCreateGrant < ownershipTransfer,
  'function owner needs schema CREATE before migration-21 function ownership transfer',
)
assert.ok(ownershipTransfer < setRole, 'migration-21 function ownership must transfer before SET ROLE')
assert.match(migration, /GRANT SELECT ON public\.leads, public\.emails, public\.activity_log,[\s\S]*public\.workspace_settings, public\.customer_inbound_messages[\s\S]*TO reachagent_function_owner;/)
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.literal_ilike_pattern\(text\)[\s\S]*TO reachagent_function_owner;/)
assert.doesNotMatch(migration, /emails_workspace_lead_created_at_idx/)
assert.match(migration, /array_agg\(e\.sent_at ORDER BY e\.created_at,e\.id\)[\s\S]*FILTER \(WHERE e\.type='initial_pitch' AND e\.sent_at IS NOT NULL\)\)\[1\]/)
assert.match(migration, /received_at IS NOT NULL OR replied_at IS NOT NULL THEN 'replied'/)
assert.match(migration, /GREATEST\(sent\.sent_at,sent\.replied_at,inbound\.received_at\)/)
assert.match(migration, /count\(\*\) FILTER\(WHERE contacted AND replied\) replies/)
assert.match(migration, /count\(\*\) FILTER\(WHERE contacted AND customer_outcome='interested'\) interested/)
assert.doesNotMatch(migration, /::date\s+day\b/)
assert.match(migration, /generate_series\(b\.start_day,b\.end_day,interval '1 day'\)::date AS activity_day/)
assert.match(migration, /reply_events GROUP BY reply_events\.activity_day,reply_events\.lead_id/)
assert.match(migration, /FROM days d LEFT JOIN contacted_daily c ON c\.activity_day=d\.activity_day LEFT JOIN reply_daily r ON r\.activity_day=d\.activity_day/)
assert.match(migration, /jsonb_build_object\('date',activity_day,'contacted',contacted,'replies',replies\) ORDER BY activity_day/)
assert.match(migration, /e\.replied_at AT TIME ZONE 'Australia\/Sydney'/)
assert.match(migration, /i\.received_at AT TIME ZONE 'Australia\/Sydney'/)
assert.equal((migration.match(/::date AS activity_day/g) ?? []).length, 4)
assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_customer_analytics\(uuid,timestamptz\) FROM PUBLIC,anon,authenticated;/)
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_customer_analytics\(uuid,timestamptz\) TO service_role;/)

assert.match(analyticsData, /get_customer_analytics/)
for (const label of ['Total leads', 'Contacted', 'Replies', 'Interested', 'Not interested', 'reply rate']) {
  assert.ok(analyticsPage.toLowerCase().includes(label.toLowerCase()), `missing customer metric: ${label}`)
}
for (const internal of ['pending_send', 'delivery_uncertain', 'idempotency', 'raw Email Log', 'follow_up_1', 'follow_up_2', 'follow_up_3']) {
  assert.ok(!analyticsPage.includes(internal), `analytics leaks internal term: ${internal}`)
}

console.log('Prompt 7 customer performance and analytics checks passed')
