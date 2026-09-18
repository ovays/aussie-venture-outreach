import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { ALL_STATUSES } from '../src/lib/lead-status'
import { assertTriggerJobsEnabled } from '../src/lib/side-effect-safety'
import { sendEmail } from '../src/lib/resend'
import { assertV2SupabaseTarget } from '../src/lib/v2-runtime-safety'

assertV2SupabaseTarget()
assert.deepEqual(ALL_STATUSES, [
  'new', 'researched', 'email_ready', 'contacted', 'replied',
  'interested', 'negotiating', 'closed', 'closed_manual', 'dead',
])

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const service = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const runId = Date.now().toString(36)
const password = `V2-only-${runId}!`
const adminEmail = `v2-admin-${runId}@example.test`
const memberEmail = `v2-member-${runId}@example.test`

async function createDisposableUser(email: string, metadata: Record<string, unknown>) {
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata })
  assert.ifError(error)
  assert(data.user)
  const { data: profile, error: profileError } = await service.from('profiles').select('role').eq('id', data.user.id).single()
  assert.ifError(profileError)
  assert.equal(profile.role, 'member', 'auth metadata cannot self-elevate')
  return data.user
}

async function main() {
const adminUser = await createDisposableUser(adminEmail, { full_name: 'V2 Admin', role: 'admin' })
const memberUser = await createDisposableUser(memberEmail, { full_name: 'V2 Member', role: 'admin' })
assert.ifError((await service.from('profiles').update({ role: 'admin' }).eq('id', adminUser.id)).error)

async function signedIn(email: string) {
  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  assert.ifError(error)
  return client
}

const admin = await signedIn(adminEmail)
const member = await signedIn(memberEmail)
const categoryName = `Synthetic V2 ${runId}`
const { data: category, error: categoryError } = await admin.from('categories').insert({ name: categoryName, status: 'active' }).select('id,name').single()
assert.ifError(categoryError)
assert(category)
assert((await member.from('categories').insert({ name: `Denied ${runId}` })).error, 'member config mutation must be denied')

const { data: suburb, error: suburbError } = await admin.from('city_suburbs').insert({ city: 'Test City', suburb: `Test Suburb ${runId}`, active: true }).select('id,priority').single()
assert.ifError(suburbError)
assert.equal(suburb?.priority, 1)
assert((await admin.from('city_suburbs').insert({ city: 'Test City', suburb: `Bad Priority ${runId}`, priority: 11 })).error)

const { data: lead, error: leadError } = await member.from('leads').insert({
  business_name: '  Synthetic V2 Lead  ', category_id: category.id, category_name: category.name,
  city: 'Test City', suburb: 'Test Suburb', email: `  lead-${runId}@example.com  `, status: 'new', source: 'manual',
}).select('id,business_name,email,normalized_email,status,category_id').single()
assert.ifError(leadError)
assert(lead)
assert.equal(lead.business_name, 'Synthetic V2 Lead')
assert.equal(lead.email, `lead-${runId}@example.com`)
assert.equal(lead.normalized_email, `lead-${runId}@example.com`)
assert.equal(lead.category_id, category.id)

for (const nextStatus of ['researched', 'email_ready', 'interested'] as const) {
  const updateResponse: { data: { status: string | null } | null; error: unknown } =
    await member.from('leads').update({ status: nextStatus }).eq('id', lead.id).select('status').single()
  const updatedLead: { status: string | null } | null = updateResponse.data
  const updateError: unknown = updateResponse.error
  assert.ifError(updateError)
  assert(updatedLead)
  assert.equal(updatedLead.status, nextStatus)
}
assert.ifError((await member.from('leads').update({ business_name: 'Synthetic V2 Lead Edited' }).eq('id', lead.id)).error)
assert((await member.from('leads').insert({ business_name: 'Bad Closed Won', category_name: category.name, city: 'Test City', status: 'closed_won' })).error)
assert((await member.from('leads').insert({ business_name: 'Bad DM Queue', category_name: category.name, city: 'Test City', status: 'dm_queued' })).error)
assert.ifError((await member.from('leads').delete().eq('id', lead.id)).error)
const { count: remainingAfterDeniedDelete, error: deniedDeleteCheckError } = await member
  .from('leads').select('id', { count: 'exact', head: true }).eq('id', lead.id)
assert.ifError(deniedDeleteCheckError)
assert.equal(remainingAfterDeniedDelete, 1, 'RLS must deny member lead deletion by leaving the row intact')
assert((await member.from('profiles').update({ role: 'admin' }).eq('id', memberUser.id)).error, 'member role elevation must be denied')

const { data: invalidLead, error: invalidLeadError } = await member.from('leads').insert({
  business_name: 'Synthetic Invalid Email', category_id: category.id, category_name: category.name,
  city: 'Test City', email: `invalid-${runId}`, status: 'new', source: 'manual',
}).select('id').single()
assert.ifError(invalidLeadError)
assert(invalidLead)
const { data: flag, error: flagError } = await admin.from('lead_data_quality_flags').select('issue_type').eq('lead_id', invalidLead.id).eq('status', 'open').single()
assert.ifError(flagError)
assert(flag)
const statusArgs = {
  p_issue_type: flag.issue_type,
  p_lead_ids: [invalidLead.id],
  p_status: 'resolved',
  p_resolution_reason: 'Synthetic V2 smoke test',
} satisfies Database['public']['Functions']['set_data_quality_flag_status']['Args']
assert.ifError((await admin.rpc('set_data_quality_flag_status', statusArgs)).error)
assert.ifError((await admin.rpc('set_data_quality_flag_status', { ...statusArgs, p_status: 'open', p_resolution_reason: undefined })).error)
assert.ifError((await admin.rpc('remove_data_quality_emails', { p_lead_ids: [invalidLead.id] })).error)

const { data: counts, error: countsError } = await service.rpc('get_lead_status_counts')
assert.ifError(countsError)
assert(Array.isArray(counts))

await assert.rejects(() => sendEmail({ to: 'nobody@example.test', subject: 'blocked', html: '<p>blocked</p>', text: 'blocked', leadId: lead.id }), /OUTREACH_SEND_ENABLED=true/)
assert.throws(() => assertTriggerJobsEnabled('smoke trigger'), /TRIGGER_JOBS_ENABLED=true/)

assert.ifError((await service.from('leads').delete().in('id', [lead.id, invalidLead.id])).error)
assert.ifError((await service.from('city_suburbs').delete().eq('id', suburb!.id)).error)
assert.ifError((await service.from('categories').delete().eq('id', category.id)).error)
assert.ifError((await service.auth.admin.deleteUser(adminUser.id)).error)
assert.ifError((await service.auth.admin.deleteUser(memberUser.id)).error)

console.log(JSON.stringify({ result: 'V2_APPLICATION_SMOKE_PASS' }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
