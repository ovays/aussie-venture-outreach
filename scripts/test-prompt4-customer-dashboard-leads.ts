import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { customerLeadStatus, CUSTOMER_LEAD_STATUSES, formatCustomerActivity } from '../src/lib/customer-lead'
import { canEditCustomerLeadNotes, canEditCustomerLeadOutcome } from '../src/lib/access-policy'

const read = (path: string) => readFileSync(path, 'utf8')
const customerUi = read('src/components/leads/CustomerLeads.tsx')
const customerApi = read('src/app/api/customer-leads/[id]/route.ts')
const listApi = read('src/app/api/customer-leads/route.ts')
const legacyApi = read('src/app/api/leads/route.ts')
const lifecyclePage = read('src/app/dashboard/lifecycle/page.tsx')
const lifecycleApi = read('src/app/api/lifecycle/route.ts')
const dashboard = read('src/app/dashboard/page.tsx')
const migration = read('supabase-v2/migrations/00000000000021_customer_dashboard_leads.sql')

assert.deepEqual(CUSTOMER_LEAD_STATUSES, ['all','new','email_ready','contacted','replied','interested','not_interested','reactivation_due','dead'])
assert.equal(customerLeadStatus({ status: 'new' }), 'new')
assert.equal(customerLeadStatus({ status: 'researched' }), 'new')
assert.equal(customerLeadStatus({ status: 'email_ready' }), 'email_ready')
assert.equal(customerLeadStatus({ status: 'contacted' }), 'contacted')
assert.equal(customerLeadStatus({ status: 'replied' }), 'replied')
assert.equal(customerLeadStatus({ status: 'negotiating' }), 'interested')
assert.equal(customerLeadStatus({ status: 'closed_manual' }), 'interested')
assert.equal(customerLeadStatus({ status: 'dead' }), 'dead')
assert.equal(customerLeadStatus({ status: 'contacted', reactivation_due: true }), 'reactivation_due')
assert.equal(customerLeadStatus({ status: 'replied', customer_outcome: 'not_interested' }), 'not_interested')
assert.equal(customerLeadStatus({ status: 'dead', customer_outcome: 'interested' }), 'interested')

for (const forbidden of ['pending_send','delivery_uncertain','email_sync_failed','initial_pitch','follow_up_1','follow_up_2','follow_up_3','Finder','Researcher','Writer','Sender','Decision Engine','Orchestrator']) {
  assert.equal(customerUi.includes(forbidden), false, `customer UI leaks ${forbidden}`)
}
assert.match(customerUi, /No leads yet/)
assert.doesNotMatch(customerUi, /Start Finder|Run pipeline|Research Selected|Send Initial Emails/)
assert.match(customerUi, /Mark Interested/)
assert.match(customerUi, /Mark Not Interested/)

assert.match(customerApi, /\.strict\(\)/)
assert.match(customerApi, /Only outcome and notes may be changed/)
assert.doesNotMatch(customerApi, /status:\s*z\.enum/)
assert.match(customerApi, /canEditCustomerLeadOutcome/)
assert.match(customerApi, /canEditCustomerLeadNotes/)
assert.equal(canEditCustomerLeadNotes('member', false), true)
assert.equal(canEditCustomerLeadOutcome('member', false), false)
assert.equal(canEditCustomerLeadOutcome('owner', false), true)
assert.equal(canEditCustomerLeadOutcome('admin', false), true)

assert.match(listApi, /workspace\.workspaceId/)
assert.match(customerApi, /createWorkspaceServiceClient|access\.supabase/)
assert.doesNotMatch(customerApi, /workspace_id.*request|raw\.workspace_id/)
assert.match(legacyApi, /requireApiWorkspacePlatformAdmin/)
assert.match(lifecyclePage, /requireInternalPage/)
assert.match(lifecycleApi, /requireApiWorkspacePlatformAdmin/)

assert.match(migration, /customer_outcome IN \('interested', 'not_interested'\)/)
assert.match(migration, /WHERE l\.workspace_id=p_workspace_id/)
assert.match(migration, /e\.workspace_id=p_workspace_id/)
assert.match(migration, /a\.workspace_id=p_workspace_id/)
assert.doesNotMatch(migration, /UPDATE[\s\S]*status\s*=/i)
assert.doesNotMatch(customerApi, /pipeline|sendInitial|generate|resend|research/i)

assert.deepEqual(formatCustomerActivity({ event_type: 'email_sent', business_name: 'Example Cafe' }), { kind: 'email_sent', text: 'Email sent to Example Cafe' })
assert.deepEqual(formatCustomerActivity({ event_type: 'reply_received', business_name: 'Example Cafe' }), { kind: 'reply_received', text: 'Example Cafe replied' })
assert.equal(formatCustomerActivity({ event_type: 'researcher_complete', business_name: 'Example Cafe' }), null)

const customerDashboard = dashboard.slice(dashboard.indexOf('if (!workspace.isPlatformAdmin)'), dashboard.indexOf('const actionItems'))
for (const forbidden of ['FU1','FU2','FU3','DM Queue','Finder','pipeline stages']) assert.equal(customerDashboard.includes(forbidden), false)
assert.match(customerDashboard, /Total leads/)
assert.match(customerDashboard, /Interested/)

console.log('Prompt 4 customer dashboard/leads tests passed')
