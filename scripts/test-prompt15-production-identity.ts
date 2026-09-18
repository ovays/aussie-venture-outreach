import assert from 'node:assert/strict'
import { createShadowRuntimeClient, validateProductionShadowCredentials } from '@/domain/shadow-readiness'

const SHADOW_SCHEMA = 'reachagent_prompt15_shadow'

async function request(path: string, schema: string): Promise<Response> {
  const credentials = validateProductionShadowCredentials(process.env)
  return fetch(`${credentials.url}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: credentials.publishableKey,
      Authorization: `Bearer ${credentials.accessToken}`,
      'Accept-Profile': schema,
    },
  })
}

async function main() {
  assert.equal(process.env.V2_SHADOW_ALLOW_PRODUCTION_READS, 'false')
  assert.equal(process.env.V2_SHADOW_SUPABASE_READ_KEY ?? '', '')
  const credentials = validateProductionShadowCredentials(process.env)
  assert.match(credentials.publishableKey, /^sb_publishable_/)
  assert.notEqual(credentials.publishableKey, credentials.accessToken)

  // The sole successful production read is explicitly zero-row.
  const metadata = await request('lead_facts?select=id&limit=0', SHADOW_SCHEMA)
  assert.equal(metadata.status, 200)
  assert.deepEqual(await metadata.json(), [])

  const publicDenials: Record<string, number> = {}
  for (const [table, column] of [
    ['leads', 'id'],
    ['emails', 'id'],
    ['settings', 'key'],
    ['activity_log', 'id'],
    ['ai_provider_credentials', 'provider'],
  ] as const) {
    const response = await request(`${table}?select=${column}&limit=0`, 'public')
    assert.equal(response.ok, false)
    publicDenials[table] = response.status
  }

  const unrelated = await request('ai_provider_credentials?select=provider&limit=0', SHADOW_SCHEMA)
  assert.equal(unrelated.status, 404)

  const emailBody = await request('email_facts?select=body_html&limit=0', SHADOW_SCHEMA)
  assert.equal(emailBody.status, 400)

  const rpc = await request('rpc/claim_recipient_outreach', SHADOW_SCHEMA)
  assert.equal(rpc.status, 404)

  const runtime = createShadowRuntimeClient('v1-production-readonly', process.env)
  const client = runtime.client as any
  assert.throws(() => client.from('lead_facts').insert({}), /blocked Supabase mutation method: insert/)
  assert.throws(() => client.from('lead_facts').update({}), /blocked Supabase mutation method: update/)
  assert.throws(() => client.from('lead_facts').upsert({}), /blocked Supabase mutation method: upsert/)
  assert.throws(() => client.from('lead_facts').delete(), /blocked Supabase mutation method: delete/)
  assert.throws(() => client.rpc('claim_recipient_outreach'), /blocked Supabase mutation method: rpc/)
  assert.equal(runtime.audit.blockedMutationAttempts, 5)

  console.log(JSON.stringify({
    status: 'PASS',
    successfulProductionRowsRead: 0,
    shadowSchemaZeroRowStatus: metadata.status,
    directPublicZeroRowDenials: publicDenials,
    unrelatedTableStatus: unrelated.status,
    emailBodyColumnStatus: emailBody.status,
    rpcStatus: rpc.status,
    locallyBlockedMutationAndRpcAttempts: runtime.audit.blockedMutationAttempts,
    credentialModel: 'dedicated publishable apikey + one-hour custom-role bearer JWT',
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
