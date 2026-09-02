import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dataQualityActionSchema, friendlyDataQualityError } from '../src/lib/data-quality-actions'

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')

function main() {
  const page = read('src/app/dashboard/admin/data-quality/page.tsx')
  const dashboard = read('src/components/data-quality/DataQualityDashboard.tsx')
  const reportRoute = read('src/app/api/data-quality/route.ts')
  const actionRoute = read('src/app/api/data-quality/actions/route.ts')
  const reportHelper = read('src/lib/data-quality-report.ts')
  const navigation = read('src/components/layout/navigation.ts')
  const migration = read('supabase/migrations/050_data_quality_ui_actions.sql')
  const existingDelete = read('src/app/api/leads/[id]/route.ts')

  // Page, authorization, navigation, and live summary values.
  assert(page.includes('await requireAdmin()'), 'Data Quality page must require admin access')
  assert(page.includes('<DataQualityDashboard'), 'Data Quality page loads the dashboard')
  assert(navigation.includes("'/dashboard/admin/data-quality'") || navigation.includes('href: "/dashboard/admin/data-quality"'), 'admin navigation includes Data Quality')
  assert(reportRoute.includes('await requireApiAdmin()'), 'report API is admin-only')
  assert(actionRoute.includes('await requireApiAdmin()'), 'mutation API is admin-only')
  assert(reportRoute.includes("supabase.rpc('get_data_quality_summary')"), 'summary comes from the P1 RPC')
  for (const liveCount of ['53', '37', '154', '117']) {
    assert(!dashboard.includes(`value: ${liveCount}`), `live summary count ${liveCount} is not hardcoded`)
  }

  // Server-side filtering, global-style search, and pagination.
  for (const parameter of ['issue_type', 'search', 'city', 'category', 'page', 'page_size']) {
    assert(dashboard.includes(`params.set('${parameter}'`) || dashboard.includes(`${parameter}: String(`), `${parameter} is sent to the report API`)
  }
  assert(reportRoute.includes("params.get('email')") && reportRoute.includes("params.get('business')"), 'P1 email and business filters remain supported')
  assert(migration.includes('p_search TEXT') && migration.includes("array_to_string(business_names,' ') ILIKE") && migration.includes("array_to_string(domains,' ') ILIKE"), 'search is server-side across email, business, and domain')
  assert(migration.includes('LIMIT LEAST(GREATEST(p_page_size,1),100)') && dashboard.includes('[25, 50, 100]'), 'server pagination supports 25/50/100')

  // Expandable, fully detailed comparison experience.
  assert(dashboard.includes('toggleExpanded(row)') && dashboard.includes('<LeadComparison'), 'groups expand into related lead comparisons')
  for (const field of ['business_name', 'email', 'status', 'city', 'suburb', 'category', 'website', 'phone', 'instagram', 'created_at', 'outreach_count', 'latest_outreach', 'has_reply', 'has_deal', 'has_notes', 'has_email_history', 'protected_from_auto_delete']) {
    assert(dashboard.includes(`lead.${field}`), `expanded comparison displays ${field}`)
  }
  assert(dashboard.includes('Lead ID:') && dashboard.includes('Open Lead'), 'lead ID and existing lead drawer action are shown')
  assert(dashboard.includes('Preferred to Keep') && dashboard.includes('Potential Duplicate'), 'preferred and suggested redundant leads are visibly recommendations')
  assert(dashboard.includes('Recommendation only:') && dashboard.includes('not an automatic merge decision'), 'preferred lead is explicitly non-automatic')

  // Shared inbox and recipient ownership are separate from duplicate cleanup.
  assert(dashboard.includes('Shared Inbox') && dashboard.includes('these businesses remain separate'), 'shared email groups are explained as separate businesses')
  assert(!/<Button[^>]*>\s*Merge/i.test(dashboard), 'no merge button or Merge All shortcut exists')
  assert(dashboard.includes('one active outreach lifecycle per recipient email') && dashboard.includes('Independent email outreach blocked'), 'recipient ownership and non-owner suppression are explained')
  assert(reportHelper.includes("from('recipient_outreach_ownership')") && reportHelper.includes('owner_business_name'), 'ownership data and owner business are loaded')

  // Junk issue presentation and safe Remove Email.
  for (const issue of ['placeholder_email', 'technical_email', 'invalid_email']) {
    assert(dashboard.includes(`${issue}:`), `${issue} has an issue badge/label`)
  }
  assert(dashboard.includes('Remove Email') && dashboard.includes('sets the selected email field to empty'), 'Remove Email requires an explanatory confirmation modal')
  assert(actionRoute.includes("supabase.rpc('remove_data_quality_emails'"), 'Remove Email uses the atomic mutation RPC')
  assert(migration.includes("UPDATE leads l SET email=NULL") && migration.includes('PERFORM refresh_email_group_quality'), 'email removal clears email and trigger refreshes quality state')
  assert(migration.includes('owns the active recipient outreach lifecycle') && migration.includes('protected by lifecycle or history'), 'protected/current-owner removal is blocked')

  // Resolve/reopen transitions, audit, and refresh.
  assert(actionRoute.includes("action.action === 'resolve' || action.action === 'reopen'"), 'resolve and reopen use validated transitions')
  assert(dashboard.includes('Undo (Reopen)') && dashboard.includes("action: 'reopen'"), 'resolved flags can be reopened from the UI')
  assert(migration.includes("p_status NOT IN ('resolved','open')") && migration.includes('Unsupported data-quality issue type'), 'server validates allowed transitions and issue types')
  assert(migration.includes('data_quality_flag_resolved') && migration.includes('data_quality_flag_reopened') && migration.includes('data_quality_email_removed'), 'flag/email mutations are audited')
  assert(actionRoute.includes('data_quality_lead_deleted') && actionRoute.includes('data_quality_delete_blocked'), 'delete success and blocked protected attempts are audited')
  assert(dashboard.includes('await fetchReport()'), 'mutations refresh summary and current report without browser reload')

  // Individual deletion and conservative bulk selection.
  assert(actionRoute.includes('await deleteLeads(supabase, [lead.id])'), 'Data Quality deletion reuses the safe lead deletion service')
  assert(existingDelete.includes('await deleteLeads(supabase, [leadId])'), 'existing Leads deletion remains on the same workflow')
  assert(dashboard.includes('explicitly confirm protected deletion') && dashboard.includes('protectedConfirmed'), 'protected deletion has stronger explicit confirmation')
  assert(dashboard.includes('deleteTarget.is_outreach_owner') && actionRoute.includes("code: isOwner ? 'ownership_conflict'"), 'current outreach owners cannot be accidentally deleted')
  assert(dashboard.includes('Only unprotected, non-owner junk-email rows can be selected'), 'bulk destructive selection excludes protected and owner leads')
  assert(dashboard.includes('Remove selected invalid emails') && dashboard.includes('Resolve selected'), 'conservative bulk actions are available')
  assert(!dashboard.includes('Delete selected leads') && !dashboard.includes('Delete Selected'), 'unrestricted bulk lead deletion is absent')

  // Performance: one report RPC and fixed batch enrichment queries, never a row fetch loop.
  assert(reportRoute.includes("supabase.rpc('get_data_quality_report_v2'"), 'P2 consumes one paginated report RPC')
  assert(reportHelper.includes('Promise.all([') && reportHelper.includes(".in('id', leadIds)") && reportHelper.includes(".in('lead_id', leadIds)"), 'lead/email/deal details are batch loaded')
  assert(!/for\s*\([^)]*rows[^)]*\)[\s\S]{0,300}await\s+supabase/.test(reportHelper), 'no per-row database lookup is introduced')
  assert(!/rows\.map\s*\(\s*async/.test(reportHelper), 'no async row mapper creates N+1 requests')

  // Schema validation and friendly errors do not expose raw database details.
  assert(dataQualityActionSchema.safeParse({ action: 'remove_email', lead_ids: ['not-a-uuid'] }).success === false)
  assert(dataQualityActionSchema.safeParse({ action: 'resolve', issue_type: 'arbitrary', lead_ids: [] }).success === false)
  assert.equal(friendlyDataQualityError(new Error('duplicate key SQLSTATE 23505')), 'The Data Quality action could not be completed. Please refresh and try again.')
  assert(migration.includes('ADD COLUMN IF NOT EXISTS') && migration.includes('CREATE INDEX IF NOT EXISTS'), 'migration 050 is additive and rerunnable')
  assert(!/\bDELETE\s+FROM\s+leads\b/i.test(migration), 'migration 050 never deletes leads')
  assert(!/merge_data|merge_lead/i.test(migration + actionRoute), 'full merge remains deferred')

  console.log('Data Quality P2 UI/API tests passed')
}

main()
