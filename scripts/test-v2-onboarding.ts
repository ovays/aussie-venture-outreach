import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import {
  ONBOARDING_SETTING_KEYS,
  onboardingDestination,
  parseOnboardingStatus,
  preferencesStepSchema,
  profileStepSchema,
  workspaceStepSchema,
} from '../src/lib/onboarding'
import { assertV2SupabaseTarget } from '../src/lib/v2-runtime-safety'

assertV2SupabaseTarget()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const service = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const runId = Date.now().toString(36)
const password = `Onboarding-${runId}!`
const seedWorkspaceId = '00000000-0000-0000-0000-000000000001'
const workspaceIds: string[] = []
const userIds: string[] = []

async function createWorkspaceWithOwner(label: string) {
  const slug = `onboarding-${label}-${runId}`
  const { data: workspace, error: workspaceError } = await service
    .from('workspaces')
    .insert({ name: `Onboarding ${label}`, slug, plan: 'test' })
    .select('id')
    .single()
  assert.ifError(workspaceError)
  assert(workspace)
  workspaceIds.push(workspace.id)

  const email = `${slug}@example.test`
  const { data: created, error: userError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Owner ${label}` },
  })
  assert.ifError(userError)
  assert(created.user)
  userIds.push(created.user.id)

  const { error: membershipError } = await service.from('workspace_members').insert({
    workspace_id: workspace.id,
    user_id: created.user.id,
    role: 'owner',
    status: 'active',
  })
  assert.ifError(membershipError)
  return { workspaceId: workspace.id, email }
}

async function signedIn(email: string) {
  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  assert.ifError(error)
  return client
}

async function main() {
  const { data: seedState, error: seedError } = await service
    .from('workspace_settings')
    .select('value')
    .eq('workspace_id', seedWorkspaceId)
    .eq('key', ONBOARDING_SETTING_KEYS.status)
    .maybeSingle()
  assert.ifError(seedError)
  assert.equal(seedState?.value, 'completed', 'Aussie Venture must be backfilled as onboarded')

  assert.equal(parseOnboardingStatus(undefined), 'not_started')
  assert.equal(onboardingDestination('dashboard', 'not_started'), '/onboarding')
  assert.equal(onboardingDestination('dashboard', 'in_progress'), '/onboarding')
  assert.equal(onboardingDestination('dashboard', 'completed'), null)
  assert.equal(onboardingDestination('onboarding', 'completed'), '/dashboard')
  assert.equal(onboardingDestination('onboarding', 'in_progress'), null, 'incomplete onboarding must not loop')

  assert.equal(workspaceStepSchema.safeParse({
    workspaceName: ' ', website: 'not-a-url', industry: 'technology', country: 'AU', timezone: 'Invalid/Zone',
  }).success, false, 'required name, URL, and timezone validation must reject invalid values')
  assert.equal(workspaceStepSchema.safeParse({
    workspaceName: 'Acme', website: 'https://acme.example', industry: 'technology', country: 'AU', timezone: 'Australia/Sydney',
  }).success, true)
  assert.equal(profileStepSchema.safeParse({ senderName: '', brandName: 'Acme', companyDescription: '', primaryGoal: 'book_meetings' }).success, false)
  assert.equal(preferencesStepSchema.safeParse({ primaryMarket: ' ' }).success, false)

  const workspaceA = await createWorkspaceWithOwner('a')
  const workspaceB = await createWorkspaceWithOwner('b')
  const ownerA = await signedIn(workspaceA.email)
  const ownerB = await signedIn(workspaceB.email)

  const { data: newWorkspaceState, error: newWorkspaceError } = await ownerA
    .from('workspace_settings')
    .select('value')
    .eq('workspace_id', workspaceA.workspaceId)
    .eq('key', ONBOARDING_SETTING_KEYS.status)
    .maybeSingle()
  assert.ifError(newWorkspaceError)
  assert.equal(newWorkspaceState, null, 'new workspaces must begin without a completed onboarding state')

  assert.ifError((await ownerA.from('workspace_settings').upsert([
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.status, value: 'in_progress' },
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.currentStep, value: '3' },
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.brandName, value: 'Tenant A Brand' },
  ], { onConflict: 'workspace_id,key' })).error)
  assert.ifError((await ownerB.from('workspace_settings').upsert([
    { workspace_id: workspaceB.workspaceId, key: ONBOARDING_SETTING_KEYS.status, value: 'in_progress' },
    { workspace_id: workspaceB.workspaceId, key: ONBOARDING_SETTING_KEYS.currentStep, value: '2' },
    { workspace_id: workspaceB.workspaceId, key: ONBOARDING_SETTING_KEYS.brandName, value: 'Tenant B Brand' },
  ], { onConflict: 'workspace_id,key' })).error)

  const { data: crossTenantRead, error: crossTenantReadError } = await ownerA
    .from('workspace_settings')
    .select('key,value')
    .eq('workspace_id', workspaceB.workspaceId)
  assert.ifError(crossTenantReadError)
  assert.deepEqual(crossTenantRead, [], 'Workspace A must not read Workspace B onboarding state')

  assert.ifError((await ownerA.from('workspace_settings')
    .update({ value: 'Compromised' })
    .eq('workspace_id', workspaceB.workspaceId)
    .eq('key', ONBOARDING_SETTING_KEYS.brandName)).error)
  const { data: tenantBBrand } = await service.from('workspace_settings')
    .select('value')
    .eq('workspace_id', workspaceB.workspaceId)
    .eq('key', ONBOARDING_SETTING_KEYS.brandName)
    .single()
  assert.equal(tenantBBrand?.value, 'Tenant B Brand', 'Workspace A must not update Workspace B onboarding state')

  const { data: resumed, error: resumeError } = await ownerA.from('workspace_settings')
    .select('key,value')
    .eq('workspace_id', workspaceA.workspaceId)
    .in('key', [ONBOARDING_SETTING_KEYS.status, ONBOARDING_SETTING_KEYS.currentStep])
  assert.ifError(resumeError)
  assert.equal(resumed?.find((row) => row.key === ONBOARDING_SETTING_KEYS.status)?.value, 'in_progress')
  assert.equal(resumed?.find((row) => row.key === ONBOARDING_SETTING_KEYS.currentStep)?.value, '3', 'progress must resume durably')

  await ownerA.auth.signOut()
  const ownerAAfterLogin = await signedIn(workspaceA.email)
  const { data: afterLogin, error: afterLoginError } = await ownerAAfterLogin.from('workspace_settings')
    .select('value')
    .eq('workspace_id', workspaceA.workspaceId)
    .eq('key', ONBOARDING_SETTING_KEYS.currentStep)
    .single()
  assert.ifError(afterLoginError)
  assert.equal(afterLogin?.value, '3', 'logout/login must not lose onboarding progress')

  const completedAt = new Date().toISOString()
  assert.ifError((await ownerAAfterLogin.from('workspace_settings').upsert([
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.status, value: 'completed' },
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.currentStep, value: '5' },
    { workspace_id: workspaceA.workspaceId, key: ONBOARDING_SETTING_KEYS.completedAt, value: completedAt },
  ], { onConflict: 'workspace_id,key' })).error)
  const { data: completion, error: completionError } = await service.from('workspace_settings')
    .select('key,value')
    .eq('workspace_id', workspaceA.workspaceId)
    .in('key', [ONBOARDING_SETTING_KEYS.status, ONBOARDING_SETTING_KEYS.completedAt])
  assert.ifError(completionError)
  assert.equal(completion?.find((row) => row.key === ONBOARDING_SETTING_KEYS.status)?.value, 'completed')
  assert.equal(completion?.find((row) => row.key === ONBOARDING_SETTING_KEYS.completedAt)?.value, completedAt)

  const dashboardLayout = readFileSync('src/app/dashboard/layout.tsx', 'utf8')
  const onboardingPage = readFileSync('src/app/onboarding/page.tsx', 'utf8')
  const route = readFileSync('src/app/api/onboarding/route.ts', 'utf8')
  assert(dashboardLayout.includes("onboardingDestination('dashboard'"), 'dashboard must gate incomplete workspaces')
  assert(onboardingPage.includes("onboardingDestination('onboarding'"), 'completed workspaces must leave onboarding')
  assert(!route.includes('requestedWorkspaceId') && !route.includes('workspace_id:'), 'onboarding API must not trust a browser workspace ID')

  console.log(JSON.stringify({ result: 'V2_ONBOARDING_TEST_PASS' }))
}

main().finally(async () => {
  for (const id of workspaceIds) await service.from('workspaces').delete().eq('id', id)
  for (const id of userIds) await service.auth.admin.deleteUser(id)
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
