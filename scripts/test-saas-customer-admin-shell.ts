import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasPlatformAdminAccess, hasWorkspaceAdminAccess, platformAdminApiDecision, type WorkspaceRole } from '../src/lib/access-policy'
import { executePipelineRunBoundary } from '../src/lib/pipeline-run-boundary'

const source = (path: string) => readFileSync(resolve(path), 'utf8')

type Actor = {
  name: 'anonymous' | 'member' | 'workspace admin' | 'workspace owner' | 'platform admin'
  workspaceRole?: WorkspaceRole
  platformAdmin: boolean
}

const actors: Actor[] = [
  { name: 'anonymous', platformAdmin: false },
  { name: 'member', workspaceRole: 'member', platformAdmin: false },
  { name: 'workspace admin', workspaceRole: 'admin', platformAdmin: false },
  { name: 'workspace owner', workspaceRole: 'owner', platformAdmin: false },
  { name: 'platform admin', workspaceRole: 'admin', platformAdmin: true },
]

const navigation = source('src/components/layout/navigation.ts')
for (const [label, href] of [
  ['Dashboard', '/dashboard'], ['Leads', '/dashboard/leads'], ['Outreach', '/dashboard/outreach'],
  ['Inbox', '/dashboard/inbox'], ['Analytics', '/dashboard/analytics'], ['Settings', '/dashboard/settings'],
] as const) {
  assert.ok(navigation.includes(`label: '${label}'`) && navigation.includes(`href: '${href}'`), `${label} is in customer navigation`)
}
for (const label of ['Lifecycle', 'Pipeline', 'DM Queue', 'Email Log', 'Email Report', 'Delivery Failures', 'AI Settings', 'AI Analytics', 'Data Quality', 'Workspaces', 'Users', 'Usage / Admin', 'Audit']) {
  assert.ok(navigation.includes(`label: '${label}'`), `${label} is in internal navigation`)
}

for (const actor of actors) {
  const authenticatedWorkspaceUser = actor.workspaceRole !== undefined
  assert.equal(authenticatedWorkspaceUser, actor.name !== 'anonymous', `${actor.name}: customer page policy`)
  assert.equal(
    authenticatedWorkspaceUser && hasWorkspaceAdminAccess(actor.workspaceRole!, actor.platformAdmin),
    ['workspace admin', 'workspace owner', 'platform admin'].includes(actor.name),
    `${actor.name}: workspace admin policy`,
  )
  assert.equal(hasPlatformAdminAccess(actor.platformAdmin), actor.name === 'platform admin', `${actor.name}: internal policy`)
}

const customerPages = ['', 'leads', 'outreach', 'inbox', 'analytics', 'settings']
for (const page of customerPages) {
  const text = source(`src/app/dashboard/${page ? `${page}/` : ''}page.tsx`)
  assert.match(text, /await requireWorkspacePage\(\)/, `${page} is server-authorized`)
  if (['outreach', 'inbox', 'analytics'].includes(page)) {
    assert.doesNotMatch(text, /fetch\(|createServiceClient|createClient/, `${page} placeholder has no provider/data call`)
  }
}

const internalPages = [
  'lifecycle', 'pipeline', 'dm-queue', 'email-log', 'email-report', 'delivery-failures', 'deals',
]
for (const page of internalPages) {
  assert.match(source(`src/app/dashboard/${page}/page.tsx`), /await requireInternalPage\(\)/, `${page} rejects direct customer access`)
}
assert.match(source('src/app/dashboard/settings/ai/page.tsx'), /await requireInternalPage\(\)/)

const proxy = source('src/proxy.ts')
for (const prefix of ['/api/pipeline', '/api/health', '/api/settings', '/api/audit', '/api/email-log', '/api/email-report', '/dashboard/lifecycle', '/dashboard/settings/ai']) {
  assert.ok(proxy.includes(`'${prefix}'`), `${prefix} has proxy defense in depth`)
}

for (const route of ['src/app/api/email-log/route.ts', 'src/app/api/email-report/route.ts']) {
  const text = source(route)
  assert.match(text, /export async function GET/, `${route} exposes the expected GET handler`)
  assert.match(text, /await requireApiWorkspacePlatformAdmin\(\)/, `${route} requires platform-admin authorization`)
  assert.doesNotMatch(text, /requireApiWorkspaceUser/, `${route} no longer admits ordinary workspace users`)
  const firstProtectedOperation = route.includes('email-log') ? text.indexOf("rpc('get_email_log_search_page'") : text.indexOf('provider.listMessages')
  assert.ok(text.indexOf('await requireApiWorkspacePlatformAdmin()') < firstProtectedOperation, `${route} authorizes before reading internal data`)
  for (const actor of actors) {
    const decision = platformAdminApiDecision(actor.platformAdmin ? 'admin' : actor.name === 'anonymous' ? null : 'member')
    const expectedStatus = actor.name === 'platform admin' ? 200 : actor.name === 'anonymous' ? 401 : 403
    assert.equal(decision.status, expectedStatus, `${route} GET denies/allows ${actor.name} correctly`)
  }
}

const health = source('src/app/api/health/route.ts')
assert.ok(health.indexOf('await requireApiAdmin()') < health.indexOf("rpc('get_health_summary'"), 'health authorizes before global service query')
assert.match(source('src/app/api/settings/route.ts'), /export async function GET[\s\S]*?await requireApiAdmin\(\)/, 'raw settings are platform-admin only')
assert.match(source('src/app/api/audit/route.ts'), /requireApiWorkspacePlatformAdmin\(\)/, 'audit is platform-admin only')
const layout = source('src/app/dashboard/layout.tsx')
assert.match(layout, /const auth = await requireUser\(\)/, 'dashboard shell always requires a live user')
assert.match(layout, /if \(!isPlatformAdmin\) \{[\s\S]*await requireWorkspacePage\(\)/, 'ordinary customer shell requires a workspace')
assert.match(layout, /isPlatformAdmin && <HealthBanner \/>/, 'customers do not render or request global health')
const internalPageAccess = source('src/lib/page-access.ts').split('/** Internal operational pages')[1] ?? ''
assert.match(internalPageAccess, /await requireAdmin\(\)/, 'internal page authorization uses the live platform-admin profile')
assert.doesNotMatch(internalPageAccess, /resolveWorkspacePage|requireWorkspaceContext/, 'internal admin shell does not depend on customer workspace membership')

const customerDashboard = source('src/app/dashboard/page.tsx')
for (const internalHref of ['/dashboard/lifecycle', '/dashboard/dm-queue', '/dashboard/pipeline', '/dashboard/email-log', '/dashboard/email-report', '/dashboard/delivery-failures', '/dashboard/deals', '/dashboard/settings/ai']) {
  assert.doesNotMatch(customerDashboard, new RegExp(internalHref.replaceAll('/', '\\/')), `customer Dashboard does not link to ${internalHref}`)
}

const settingsPage = source('src/app/dashboard/settings/page.tsx')
assert.ok(settingsPage.indexOf('if (!workspace.isPlatformAdmin)') < settingsPage.indexOf('<BillingSettings'), 'billing UI remains behind the platform-admin branch')
assert.doesNotMatch(navigation, /label: 'Billing'/, 'Billing is absent from customer navigation')

const scopedDetails = ['src/app/api/leads/[id]/route.ts', 'src/app/api/emails/[id]/route.ts']
for (const route of scopedDetails) {
  const text = source(route)
  assert.match(text, /requireApiWorkspaceUser/, `${route} authenticates reads`)
  assert.match(text, /requireApiWorkspaceAdmin/, `${route} protects dangerous mutation`)
  assert.doesNotMatch(text, /createClient\(/, `${route} cannot bypass explicit workspace scoping`)
}

const adminMutationRoutes = [
  'src/app/api/leads/bulk/route.ts',
  'src/app/api/leads/bulk-delete/route.ts',
  'src/app/api/leads/import/route.ts',
  'src/app/api/leads/regenerate-emails/route.ts',
  'src/app/api/leads/[id]/generate-draft/route.ts',
  'src/app/api/leads/[id]/mark-initial-sent/route.ts',
  'src/app/api/leads/[id]/regenerate-email/route.ts',
  'src/app/api/leads/[id]/resend/route.ts',
  'src/app/api/leads/[id]/retry-research/route.ts',
]
for (const route of adminMutationRoutes) {
  assert.match(source(route), /requireApiWorkspaceAdmin\(\)/, `${route} denies members`)
}

async function testPipelineAuthorizationMatrix() {
  for (const actor of actors) {
    let triggerCalls = 0
    let safetyBoundaryCalls = 0
    const response = await executePipelineRunBoundary({
      authorize: async () => actor.platformAdmin
        ? { allowed: true }
        : { allowed: false, status: actor.name === 'anonymous' ? 401 : 403, error: 'Denied' },
      assertJobsEnabled: () => { safetyBoundaryCalls++ },
      rateLimit: () => true,
      trigger: async () => { triggerCalls++; return { id: 'mock-run' } },
    })
    assert.equal(response.status, actor.platformAdmin ? 200 : actor.name === 'anonymous' ? 401 : 403, `${actor.name}: pipeline status`)
    assert.equal(triggerCalls, actor.platformAdmin ? 1 : 0, `${actor.name}: mocked trigger boundary`)
    assert.equal(safetyBoundaryCalls, actor.platformAdmin ? 1 : 0, `${actor.name}: jobs assertion boundary`)
  }
}

testPipelineAuthorizationMatrix()
  .then(() => console.log('SaaS customer/admin shell authorization tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
