import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getDashboardSummary } from '../src/lib/dashboard-summary'

const migration = readFileSync(
  'supabase-v2/migrations/00000000000015_dashboard_summary_performance.sql',
  'utf8',
)
const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')

assert.match(migration, /SECURITY DEFINER/)
assert.match(migration, /NOT public\.is_workspace_member\(v_workspace_id\)/)
assert.match(migration, /NOT public\.is_platform_admin\(\)/)
assert.doesNotMatch(migration, /statement_timeout/i)

for (const [table, alias, expectedReferences] of [
  ['leads', 'leads', 5],
  ['emails', 'emails', 4],
  ['dm_queue', 'dm_queue', 2],
  ['deals', 'deals', 2],
  ['activity_log', 'activity', 1],
] as const) {
  const tableReferences = migration.match(new RegExp(`public\\.${table} AS ${alias}`, 'g'))?.length ?? 0
  const workspacePredicates = migration.match(new RegExp(`${alias}\\.workspace_id = v_workspace_id`, 'g'))?.length ?? 0
  assert.equal(tableReferences, expectedReferences, `unexpected ${table} scan count`)
  assert.equal(workspacePredicates, tableReferences, `every ${table} scan must be workspace-scoped`)
}

for (const index of [
  'leads_workspace_created_at_idx',
  'emails_workspace_status_sent_at_idx',
  'deals_workspace_closed_at_idx',
  'activity_log_workspace_created_at_idx',
]) {
  assert(migration.includes(index), `dashboard hot path requires ${index}`)
}

assert.match(page, /requireWorkspaceContext\(auth\)/)
assert.match(page, /getDashboardSummary\(supabase, workspace\.workspaceId\)/)

const asOf = new Date('2026-09-26T04:00:00.000Z')
const calls: Array<{ name: string; args: { p_as_of: string; p_workspace_id: string } }> = []
const wire = {
  as_of: asOf.toISOString(),
  today_range: {
    timezone: 'Australia/Sydney',
    start: '2026-09-25T14:00:00.000Z',
    end: '2026-09-26T14:00:00.000Z',
    date_key: '2026-09-26',
  },
  status_counts: { contacted: 12, replied: 3 },
  today_email_stats: {
    total_sent: 8,
    initial_sent: 5,
    followups_sent: 3,
    follow_up_1_sent: 1,
    follow_up_2_sent: 1,
    follow_up_3_sent: 1,
  },
  today_dm_stats: { sent_today: 2 },
  reply_stats: {
    total_contacted_leads: 15,
    positive_response_leads: 3,
    replies_today: 2,
    reply_rate: 20,
  },
  followup_stats: {
    sent_today: 3,
    total_sent: 30,
    pending: 6,
    follow_up_1_sent_today: 1,
    follow_up_2_sent_today: 1,
    follow_up_3_sent_today: 1,
    pending_follow_up_1: 3,
    pending_follow_up_2: 2,
    pending_follow_up_3: 1,
    fu1_due: 3,
    fu2_due: 2,
    fu3_due: 1,
    fu_due: 6,
    reactivation_total: 4,
    overdue_total: 5,
  },
  daily_activity: [{
    date: '2026-09-26',
    label: 'Today (26 Sep)',
    leads_found: 7,
    emails_sent: 8,
    dms_queued: 2,
    followups_sent: 3,
  }],
  emails_sent_this_week: 25,
  dms_queued: 9,
  deals_rolling_30_days: 2,
  weekly_revenue: [{ week: 'W12', revenue: 1500 }],
  recent_activity: [{
    id: 'activity-a',
    event_type: 'email_sent',
    description: 'Sent',
    created_at: '2026-09-26T03:00:00.000Z',
  }],
  hot_leads: [{
    id: 'lead-a',
    business_name: 'Workspace A Lead',
    city: 'Sydney',
    status: 'replied',
    emails: [{ type: 'initial_pitch', sent_at: '2026-09-25T03:00:00.000Z', replied_at: null, subject: 'Hello' }],
  }],
}

const client = {
  async rpc(name: string, args: { p_as_of: string; p_workspace_id: string }) {
    calls.push({ name, args })
    return { data: wire, error: null }
  },
}

async function main() {
  const summary = await getDashboardSummary(client, 'workspace-a', asOf)

  assert.deepEqual(calls, [{
    name: 'get_dashboard_summary',
    args: { p_as_of: asOf.toISOString(), p_workspace_id: 'workspace-a' },
  }], 'dashboard must make one workspace-scoped RPC (no N+1 requests)')
  assert.deepEqual(summary.statusMap, { contacted: 12, replied: 3 })
  assert.equal(summary.analytics.todayEmailStats.totalSent, 8)
  assert.equal(summary.analytics.followupStats.fuDue, 6)
  assert.equal(summary.analytics.followupStats.reactivationTotal, 4)
  assert.equal(summary.pendingDMCount, 9)
  assert.equal(summary.dealsRolling30DayCount, 2)
  assert.equal(summary.hotLeads[0]?.business_name, 'Workspace A Lead')

  console.log('DASHBOARD_SUMMARY_PERFORMANCE_TEST_PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
