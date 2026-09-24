import assert from 'node:assert/strict'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { ONBOARDING_SETTING_KEYS } from '../src/lib/onboarding'
import { assertV2SupabaseTarget } from '../src/lib/v2-runtime-safety'

assertV2SupabaseTarget()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const baseUrl = process.env.V2_APP_BASE_URL ?? 'http://127.0.0.1:3005'
const service = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const runId = Date.now().toString(36)
const email = `onboarding-page-${runId}@example.test`
const password = `Onboarding-Page-${runId}!`
let userId: string | undefined
const workspaceIds: string[] = []

function pageText(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
}

async function createWorkspace(name: string, slug: string) {
  const { data, error } = await service.from('workspaces').insert({ name, slug, plan: 'test' }).select('id').single()
  assert.ifError(error); assert(data); workspaceIds.push(data.id); return data.id
}

async function main() {
  const workspaceA = await createWorkspace('Fresh Customer', `fresh-customer-${runId}`)
  const workspaceB = await createWorkspace('Other Customer', `other-customer-${runId}`)
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: 'Fresh Owner' },
  })
  assert.ifError(createError); assert(created.user); userId = created.user.id
  assert.ifError((await service.from('workspace_members').insert({ workspace_id: workspaceA, user_id: userId, role: 'owner', status: 'active' })).error)

  const cookieJar = new Map<string, string>()
  const auth = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => cookieJar.set(name, value)),
    },
  })
  assert.ifError((await auth.auth.signInWithPassword({ email, password })).error)
  const cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ')
  const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
    redirect: 'manual',
  })
  const patch = (payload: unknown) => request('/api/onboarding', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const dashboardBefore = await request('/dashboard')
  assert.equal(dashboardBefore.status, 307)
  assert(new URL(dashboardBefore.headers.get('location')!, baseUrl).pathname === '/onboarding')
  const welcome = await request('/onboarding')
  assert.equal(welcome.status, 200)
  assert(pageText(await welcome.text()).includes('Step 1 of 5'))

  let response = await patch({ action: 'advance', step: 1, workspace_id: workspaceB })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.currentStep, 2)
  response = await patch({ action: 'advance', step: 2, data: { workspaceName: ' ', website: 'bad', industry: 'technology', country: 'AU', timezone: 'Bad/Zone' } })
  assert.equal(response.status, 400, 'server validation must reject invalid required fields')

  const refreshAtStepTwo = await request('/onboarding')
  assert.equal(refreshAtStepTwo.status, 200)
  assert(pageText(await refreshAtStepTwo.text()).includes('Step 2 of 5'), 'refresh must resume at the durable current step')

  response = await patch({ action: 'advance', step: 2, data: {
    workspaceName: 'Fresh Customer Co', website: 'https://fresh.example', industry: 'technology', country: 'AU', timezone: 'Australia/Sydney',
  } })
  assert.equal(response.status, 200)
  response = await patch({ action: 'advance', step: 3, data: {
    senderName: 'Taylor', brandName: 'Fresh Customer', companyDescription: 'A focused local test business.', primaryGoal: 'book_meetings',
  } })
  assert.equal(response.status, 200)
  response = await patch({ action: 'advance', step: 4, data: { primaryMarket: 'Melbourne' } })
  assert.equal(response.status, 200)

  const ready = await request('/onboarding')
  assert.equal(ready.status, 200)
  const readyBody = pageText(await ready.text())
  assert(readyBody.includes('Step 5 of 5') && readyBody.includes('Fresh Customer Co'))

  response = await patch({ action: 'complete', step: 5 })
  assert.equal(response.status, 200)
  const completed = await response.json()
  assert.equal(completed.data.status, 'completed')
  assert(completed.data.completedAt)

  const onboardingAfter = await request('/onboarding')
  assert.equal(onboardingAfter.status, 307)
  assert.equal(new URL(onboardingAfter.headers.get('location')!, baseUrl).pathname, '/dashboard')
  const dashboardAfter = await request('/dashboard')
  assert.equal(dashboardAfter.status, 200, 'completed workspace must reach the dashboard normally')

  const { data: otherState, error: otherError } = await service.from('workspace_settings')
    .select('key')
    .eq('workspace_id', workspaceB)
    .like('key', 'onboarding_%')
  assert.ifError(otherError)
  assert.deepEqual(otherState, [], 'a browser-supplied workspace_id must not mutate another workspace')

  const { data: durable, error: durableError } = await service.from('workspace_settings')
    .select('key,value')
    .eq('workspace_id', workspaceA)
    .in('key', [ONBOARDING_SETTING_KEYS.status, ONBOARDING_SETTING_KEYS.completedAt])
  assert.ifError(durableError)
  assert.equal(durable?.find((row) => row.key === ONBOARDING_SETTING_KEYS.status)?.value, 'completed')
  assert(durable?.find((row) => row.key === ONBOARDING_SETTING_KEYS.completedAt)?.value)

  console.log(JSON.stringify({ result: 'V2_ONBOARDING_PAGE_FLOW_PASS' }))
}

main().finally(async () => {
  for (const workspaceId of workspaceIds) await service.from('workspaces').delete().eq('id', workspaceId)
  if (userId) await service.auth.admin.deleteUser(userId)
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
