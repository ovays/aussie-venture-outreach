import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { AIRegistry } from '../src/ai/AIRegistry'
import { withWorkflowTrace } from '../src/lib/observability/context'

const LOCAL_DATABASE_URL = 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres'
const AUSSIE_VENTURE_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: LOCAL_DATABASE_URL })
  await client.connect()
  return client
}

async function serviceClient(): Promise<Client> {
  const client = await connect()
  await client.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return client
}

async function expectQuotaExceeded(work: Promise<unknown>): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const candidate = error as { code?: string; message?: string }
    return candidate.code === 'P0001' && Boolean(candidate.message?.includes('QUOTA_EXCEEDED'))
  })
}

async function testAIQuotaBoundary(): Promise<void> {
  const events: string[] = []
  const keys: string[] = []
  const registry = new AIRegistry(
    { getWorkflowAssignment: async () => ({ providerKey: 'mock', modelKey: 'mock-model' }) } as never,
    undefined,
    Date.now,
    'quota-test',
    async (_workspaceId, key) => { events.push('quota'); keys.push(key) },
  ).register('mock', {
    generate: async () => { events.push('provider'); return { text: 'ok' } },
  })

  const request = { maxTokens: 10, messages: [{ role: 'user' as const, content: 'same logical request' }] }
  await withWorkflowTrace(
    { workspaceId: AUSSIE_VENTURE_WORKSPACE_ID, workflowRunId: 'quota-ai-test' },
    async () => {
      await registry.generate('outreach_email_generation', request)
      await registry.generate('outreach_email_generation', request)
    },
  )
  assert.deepEqual(events, ['quota', 'provider', 'quota', 'provider'])
  assert.equal(keys[0], keys[1], 'AI retry derives the same quota idempotency key')

  const providerCallsBefore = events.filter((event) => event === 'provider').length
  await assert.rejects(
    registry.generate('outreach_email_generation', request),
    /requires a server-resolved workspace/,
  )
  assert.equal(events.filter((event) => event === 'provider').length, providerCallsBefore, 'Missing workspace fails before provider execution')
}

async function main() {
  assert.match(LOCAL_DATABASE_URL, /127\.0\.0\.1:54322/, 'Quota tests are pinned to disposable local V2 only')
  await testAIQuotaBoundary()
  const admin = await connect()
  const workspaceA = randomUUID()
  const workspaceB = randomUUID()
  const workspaceC = randomUUID()
  const [userA, userB] = (await admin.query<{ id: string }>('select id from auth.users order by id limit 2')).rows
  assert(userA && userB, 'Local fixture requires two auth users')

  try {
    const catalog = await admin.query("select to_regclass('public.workspace_usage_periods')::text as periods")
    assert.equal(catalog.rows[0].periods, 'workspace_usage_periods', 'Migration 14 is applied locally')

    const beta = await admin.query(
      `select p.plan_code, count(l.*)::int as dimensions,
              bool_and(l.limit_value is null) as unlimited
       from public.workspace_entitlements e
       join public.entitlement_profiles p on p.id=e.entitlement_profile_id
       join public.entitlement_limits l on l.entitlement_profile_id=p.id
       where e.workspace_id=$1 group by p.plan_code`,
      [AUSSIE_VENTURE_WORKSPACE_ID],
    )
    assert.deepEqual(beta.rows[0], { plan_code: 'internal_beta', dimensions: 6, unlimited: true })

    await admin.query(
      `insert into public.workspaces(id,name,slug) values ($1,'Quota A',$4),($2,'Quota B',$5),($3,'Quota C',$6)`,
      [workspaceA, workspaceB, workspaceC, `quota-a-${workspaceA}`, `quota-b-${workspaceB}`, `quota-c-${workspaceC}`],
    )
    await admin.query(
      `insert into public.workspace_entitlements(workspace_id,entitlement_profile_id)
       select w.id,p.id from public.workspaces w cross join public.entitlement_profiles p
       where w.id=any($1::uuid[]) and p.plan_code='internal_beta'`,
      [[workspaceA, workspaceB, workspaceC]],
    )

    await admin.query(
      `insert into public.workspace_entitlement_overrides(workspace_id,dimension_key,limit_value,notes)
       values ($1,'outbound_email',1,'concurrency test'),
              ($2,'ai_request',10,'idempotency test'),
              ($3,'workspace_member',0,'member guard test'),
              ($1,'mailbox_connection',1,'mailbox guard test')`,
      [workspaceA, workspaceB, workspaceC],
    )

    const consumers = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const client = await serviceClient()
      try {
        const result = await client.query(
          'select public.consume_workspace_quota($1,$2,$3,1) as value',
          [workspaceA, 'outbound_email', `concurrent-${index}`],
        )
        return { ok: true, value: result.rows[0].value }
      } catch (error) {
        return { ok: false, error: error as { code?: string; message?: string } }
      } finally { await client.end() }
    }))
    assert.equal(consumers.filter((result) => result.ok).length, 1, 'Atomic counter admits exactly one concurrent consumer')
    assert(consumers.filter((result) => !result.ok).every((result) => result.error?.code === 'P0001'))

    const retries = await Promise.all(Array.from({ length: 10 }, async () => {
      const client = await serviceClient()
      try {
        return (await client.query(
          'select public.consume_workspace_quota($1,$2,$3,1) as value',
          [workspaceB, 'ai_request', 'same-logical-request'],
        )).rows[0].value as { consumed: boolean; already_consumed: boolean }
      } finally { await client.end() }
    }))
    assert.equal(retries.filter((result) => result.consumed).length, 1, 'Exactly one retry consumes quota')
    assert.equal(retries.filter((result) => result.already_consumed).length, 9, 'Remaining retries dedupe')
    const used = await admin.query(
      `select used from public.workspace_usage_counters where workspace_id=$1 and dimension_key='ai_request'`,
      [workspaceB],
    )
    assert.equal(Number(used.rows[0].used), 1)

    const overrideAdmin = await serviceClient()
    try {
      await overrideAdmin.query(
        'select public.admin_set_workspace_override($1,$2,$3,$4,$5)',
        [workspaceB, 'discovery_request', 2, 'audit test', null],
      )
      await overrideAdmin.query(
        'select public.admin_clear_workspace_override($1,$2,$3)',
        [workspaceB, 'discovery_request', null],
      )
    } finally { await overrideAdmin.end() }
    const audit = await admin.query(
      `select action from public.workspace_entitlement_override_audit
       where workspace_id=$1 and dimension_key='discovery_request' order by created_at`,
      [workspaceB],
    )
    assert.deepEqual(audit.rows.map((row) => row.action), ['set', 'clear'])

    await expectQuotaExceeded(admin.query(
      `insert into public.workspace_members(workspace_id,user_id,role,status) values ($1,$2,'member','active')`,
      [workspaceC, userA.id],
    ))

    await admin.query(
      `insert into public.mailbox_connections(workspace_id,provider,email_address,provider_account_id)
       values ($1,'gmail','one@example.test','one')`,
      [workspaceA],
    )
    await expectQuotaExceeded(admin.query(
      `insert into public.mailbox_connections(workspace_id,provider,email_address,provider_account_id)
       values ($1,'microsoft','two@example.test','two')`,
      [workspaceA],
    ))

    await admin.query(
      `insert into public.workspace_members(workspace_id,user_id,role,status)
       values ($1,$2,'owner','active'),($3,$4,'owner','active')`,
      [workspaceA, userA.id, workspaceB, userB.id],
    )
    const authenticated = await connect()
    try {
      await authenticated.query('set role authenticated')
      await authenticated.query("select set_config('request.jwt.claim.role','authenticated',false)")
      await authenticated.query("select set_config('request.jwt.claim.sub',$1,false)", [userA.id])
      const visible = await authenticated.query('select workspace_id from public.workspace_usage_periods order by workspace_id')
      assert(visible.rows.every((row) => row.workspace_id === workspaceA), 'RLS hides every other workspace usage period')
      await assert.rejects(
        authenticated.query('select public.consume_workspace_quota($1,$2,$3,1)', [workspaceA, 'ai_request', 'browser-denied']),
        (error: unknown) => (error as { code?: string }).code === '42501',
      )
    } finally { await authenticated.end() }

    const migration = await readFile('supabase-v2/migrations/00000000000014_usage_quotas.sql', 'utf8')
    const sender = await readFile('src/lib/mailbox/sender.ts', 'utf8')
    const ai = await readFile('src/ai/AIRegistry.ts', 'utf8')
    const discovery = await readFile('src/lib/searchBusinesses.ts', 'utf8')
    assert.match(migration, /mailbox_connections_quota_check/)
    assert.match(migration, /pg_advisory_xact_lock/)
    assert.match(sender, /consumeOutboundEmailQuota/)
    assert.match(ai, /AI quota enforcement requires a server-resolved workspace/)
    assert.match(discovery, /consumeDiscoveryRequestQuota/)

    console.log('SAAS6_USAGE_QUOTAS_PASS')
  } finally {
    await admin.query('delete from public.workspaces where id=any($1::uuid[])', [[workspaceA, workspaceB, workspaceC]]).catch(() => undefined)
    await admin.end()
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
