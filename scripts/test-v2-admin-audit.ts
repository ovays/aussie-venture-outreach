import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'

const LOCAL_DATABASE_URL = 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres'

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: LOCAL_DATABASE_URL })
  await client.connect()
  return client
}

async function asService(): Promise<Client> {
  const client = await connect()
  await client.query('set role service_role')
  await client.query("select set_config('request.jwt.claim.role', 'service_role', false)")
  return client
}

async function asBrowser(userId: string): Promise<Client> {
  const client = await connect()
  await client.query('set role authenticated')
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)")
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
  return client
}

async function expectDenied(work: Promise<unknown>, pattern?: RegExp): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const candidate = error as { code?: string; message?: string }
    return (candidate.code === '42501' || candidate.code === 'P0001')
      && (!pattern || pattern.test(candidate.message ?? ''))
  })
}

async function ensureMigration17(admin: Client): Promise<void> {
  if (process.env.SAAS8_REINSTALL_LOCAL === '1') {
    assert.match(LOCAL_DATABASE_URL, /127\.0\.0\.1:54322/, 'SaaS 8 reinstall is local-only')
    await admin.query(`
      drop trigger if exists mirror_override_audit_to_audit_events on public.workspace_entitlement_override_audit;
      drop trigger if exists protect_final_platform_admin on public.profiles;
      drop table if exists public.audit_events cascade;
      drop function if exists public.write_audit_event(uuid,uuid,text,text,text,text,text,text,text,text,jsonb) cascade;
      drop function if exists public.admin_list_workspace_directory() cascade;
      drop function if exists public.admin_set_workspace_status(uuid,text,uuid,text) cascade;
      drop function if exists public.admin_update_workspace_name(uuid,text,uuid,text) cascade;
      drop function if exists public.admin_add_workspace_member(uuid,uuid,text,uuid,text) cascade;
      drop function if exists public.admin_set_workspace_member_role(uuid,uuid,text,uuid,text) cascade;
      drop function if exists public.admin_set_workspace_member_status(uuid,uuid,text,uuid,text) cascade;
      drop function if exists public.admin_remove_workspace_member(uuid,uuid,uuid,text) cascade;
      drop function if exists public.admin_list_audit_events(uuid,text,uuid,integer,timestamp with time zone,uuid) cascade;
      drop function if exists reachagent_private.sanitize_audit_metadata(jsonb) cascade;
      drop function if exists reachagent_private.reject_audit_event_mutation() cascade;
      drop function if exists reachagent_private.workspace_active_owner_count(uuid) cascade;
      drop function if exists reachagent_private.assert_admin_actor(uuid,uuid,text,boolean) cascade;
      drop function if exists reachagent_private.mirror_override_audit_to_events() cascade;
      drop function if exists reachagent_private.protect_final_platform_admin() cascade;
    `)
  }
  await admin.query('grant create on schema public to reachagent_function_owner')
  try {
    const dashboard = await admin.query("select to_regprocedure('public.get_dashboard_summary(timestamp with time zone,uuid)') as name")
    if (!dashboard.rows[0].name) {
      await admin.query(await readFile('supabase-v2/migrations/00000000000015_dashboard_summary_performance.sql', 'utf8'))
    }
    const billing = await admin.query("select to_regclass('public.workspace_billing_accounts') as name")
    if (!billing.rows[0].name) {
      await admin.query(await readFile('supabase-v2/migrations/00000000000016_billing_stripe.sql', 'utf8'))
    }
    const audit = await admin.query("select to_regclass('public.audit_events') as name")
    if (!audit.rows[0].name) {
      await admin.query(await readFile('supabase-v2/migrations/00000000000017_admin_audit.sql', 'utf8'))
    }
  } finally {
    await admin.query('revoke create on schema public from reachagent_function_owner')
  }
}

async function writeEvent(
  client: Client,
  actorId: string,
  actorRole: 'platform_admin' | 'owner' | 'admin' | 'member',
  action: string,
  workspaceId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select public.write_audit_event($1,$2,'user',$3,$4,'test_target','target','success',null,'test',$5::jsonb) as id`,
    [workspaceId, actorId, actorRole, action, JSON.stringify(metadata)],
  )
  return result.rows[0].id
}

async function main(): Promise<void> {
  assert.match(LOCAL_DATABASE_URL, /127\.0\.0\.1:54322/, 'Admin/audit tests are pinned to isolated local V2')
  const admin = await connect()
  await ensureMigration17(admin)

  const workspaceA = randomUUID()
  const workspaceB = randomUUID()
  const platformAdmin = randomUUID()
  const secondPlatformAdmin = randomUUID()
  const ownerA = randomUUID()
  const adminA = randomUUID()
  const memberA = randomUUID()
  const adminB = randomUUID()
  const fixtureUsers = [platformAdmin, secondPlatformAdmin, ownerA, adminA, memberA, adminB]

  try {
    await admin.query(
      `insert into auth.users(id,email,raw_user_meta_data)
       values ($1,$7,'{"full_name":"Platform One"}'),($2,$8,'{"full_name":"Platform Two"}'),
              ($3,$9,'{"full_name":"Owner A"}'),($4,$10,'{"full_name":"Admin A"}'),
              ($5,$11,'{"full_name":"Member A"}'),($6,$12,'{"full_name":"Admin B"}')`,
      [platformAdmin, secondPlatformAdmin, ownerA, adminA, memberA, adminB,
        `platform-${platformAdmin}@example.test`, `platform-${secondPlatformAdmin}@example.test`,
        `owner-${ownerA}@example.test`, `admin-${adminA}@example.test`,
        `member-${memberA}@example.test`, `admin-${adminB}@example.test`],
    )
    await admin.query(`update public.profiles set role='admin' where id=any($1::uuid[])`, [[platformAdmin, secondPlatformAdmin]])
    await admin.query(
      `insert into public.workspaces(id,name,slug) values ($1,'Audit A',$3),($2,'Audit B',$4)`,
      [workspaceA, workspaceB, `audit-a-${workspaceA}`, `audit-b-${workspaceB}`],
    )
    await admin.query(
      `insert into public.workspace_entitlements(workspace_id,entitlement_profile_id)
       select w.id,p.id from public.workspaces w cross join public.entitlement_profiles p
       where w.id=any($1::uuid[]) and p.plan_code='internal_beta'`,
      [[workspaceA, workspaceB]],
    )
    await admin.query(
      `insert into public.workspace_members(workspace_id,user_id,role,status) values
       ($1,$3,'owner','active'),($1,$4,'admin','active'),($1,$5,'member','active'),
       ($2,$6,'admin','active')`,
      [workspaceA, workspaceB, ownerA, adminA, memberA, adminB],
    )

    const service = await asService()
    try {
      const eventA = await writeEvent(service, ownerA, 'owner', 'workspace.test.a', workspaceA)
      await writeEvent(service, adminB, 'admin', 'workspace.test.b', workspaceB)
      const platformEvent = await writeEvent(service, platformAdmin, 'platform_admin', 'platform.test.created', null)

      const memberBrowser = await asBrowser(memberA)
      try {
        assert.equal(Number((await memberBrowser.query('select count(*) as count from public.audit_events')).rows[0].count), 0,
          'normal member cannot read platform or workspace audit rows')
        await expectDenied(memberBrowser.query('select public.admin_list_audit_events()'))
      } finally { await memberBrowser.end() }

      const workspaceBrowser = await asBrowser(adminA)
      try {
        const visible = await workspaceBrowser.query<{ workspace_id: string | null }>('select workspace_id from public.audit_events')
        assert(visible.rows.length > 0)
        assert(visible.rows.every((row) => row.workspace_id === workspaceA), 'workspace admin sees only its workspace')

        await expectDenied(workspaceBrowser.query(
          `insert into public.audit_events(action,target_type) values ('browser.insert','test')`,
        ))
        await expectDenied(workspaceBrowser.query('update public.audit_events set action=$1 where id=$2', ['browser.update', eventA]))
        await expectDenied(workspaceBrowser.query('delete from public.audit_events where id=$1', [eventA]))
      } finally { await workspaceBrowser.end() }

      const platformBrowser = await asBrowser(platformAdmin)
      try {
        const visible = await platformBrowser.query<{ workspace_id: string | null }>('select workspace_id from public.audit_events')
        assert(visible.rows.some((row) => row.workspace_id === workspaceA))
        assert(visible.rows.some((row) => row.workspace_id === workspaceB))
        assert(visible.rows.some((row) => row.workspace_id === null), 'NULL-workspace platform events are safe and visible')
      } finally { await platformBrowser.end() }

      await expectDenied(
        writeEvent(service, memberA, 'owner', 'workspace.actor.spoofed', workspaceA),
        /invalid workspace audit actor/,
      )
      await expectDenied(service.query(
        `insert into public.audit_events(action,target_type) values ('service.direct_insert','test')`,
      ))
      await expectDenied(service.query(
        `select public.admin_set_workspace_member_role($1,$2,'member',$3,'admin')`,
        [workspaceB, adminB, adminA],
      ), /workspace admin actor required/)

      await service.query(
        `select public.admin_set_workspace_member_role($1,$2,'admin',$3,'owner')`,
        [workspaceA, memberA, ownerA],
      )
      assert.equal(Number((await admin.query(
        `select count(*) as count from public.audit_events where workspace_id=$1 and action='workspace.member.role_changed' and target_id=$2`,
        [workspaceA, memberA],
      )).rows[0].count), 1, 'role change emits an audit event')

      await service.query(
        `select public.admin_set_workspace_member_status($1,$2,'suspended',$3,'owner')`,
        [workspaceA, memberA, ownerA],
      )
      await service.query(
        `select public.admin_remove_workspace_member($1,$2,$3,'owner')`,
        [workspaceA, memberA, ownerA],
      )
      const memberEvents = await admin.query<{ action: string }>(
        `select action from public.audit_events where workspace_id=$1 and target_id=$2 order by created_at`,
        [workspaceA, memberA],
      )
      assert(memberEvents.rows.some((row) => row.action === 'workspace.member.deactivated'))
      assert(memberEvents.rows.some((row) => row.action === 'workspace.member.removed'))

      await service.query(
        `select public.admin_set_workspace_override($1,'ai_request',7,'SaaS 8 audit test',$2)`,
        [workspaceA, platformAdmin],
      )
      await service.query(
        `select public.admin_clear_workspace_override($1,'ai_request',$2)`,
        [workspaceA, platformAdmin],
      )
      const overrideEvents = await admin.query<{ action: string }>(
        `select action from public.audit_events where workspace_id=$1 and action like 'workspace.entitlement.%' order by created_at`,
        [workspaceA],
      )
      assert.deepEqual(overrideEvents.rows.map((row) => row.action), [
        'workspace.entitlement.override_set', 'workspace.entitlement.override_cleared',
      ])

      const sanitizedId = await writeEvent(service, platformAdmin, 'platform_admin', 'platform.test.sanitized', null, {
        password: 'never-store', nested: { access_token: 'never-store', clientSecret: 'never-store', safe: 'kept' },
        stripe_payload: { customer: 'full-payload' },
      })
      const sanitized = (await admin.query<{ metadata: Record<string, unknown> }>(
        'select metadata from public.audit_events where id=$1', [sanitizedId],
      )).rows[0].metadata
      assert.equal(sanitized.password, '[REDACTED]')
      assert.deepEqual(sanitized.nested, { access_token: '[REDACTED]', clientSecret: '[REDACTED]', safe: 'kept' })
      assert.equal(sanitized.stripe_payload, '[REDACTED]')

      await assert.rejects(
        service.query(`select public.admin_set_workspace_member_role($1,$2,'member',$3,'owner')`, [workspaceA, adminB, ownerA]),
        /membership not found/,
      )
      await assert.rejects(
        service.query(`select public.admin_set_workspace_member_role($1,$2,'platform_admin',$3,'admin')`, [workspaceA, adminA, adminA]),
        /invalid workspace role/,
      )
      await expectDenied(
        service.query(`select public.admin_add_workspace_member($1,$2,'owner',$3,'admin')`, [workspaceA, memberA, adminA]),
        /cannot grant owner/,
      )
      await assert.rejects(
        service.query(`select public.admin_set_workspace_member_role($1,$2,'superuser',$3,'owner')`, [workspaceA, adminA, ownerA]),
        /invalid workspace role/,
      )
      await assert.rejects(
        service.query(`select public.admin_set_workspace_member_role($1,$2,'member',$3,'owner')`, [workspaceA, ownerA, ownerA]),
        /last active workspace owner/,
      )

      const directory = (await service.query<Record<string, unknown>>('select * from public.admin_list_workspace_directory()')).rows
      assert(directory.some((row) => row.id === workspaceA))
      const forbiddenDirectoryKeys = ['password', 'token', 'access_token', 'refresh_token', 'secret', 'api_key', 'authorization', 'cookie', 'client_secret', 'service_role']
      assert(directory.every((row) => forbiddenDirectoryKeys.every((key) => !(key in row))), 'directory exposes no credentials')

      await service.query(
        `select public.write_audit_event(null,$1,'user','platform_admin','platform.test.page','test',g::text,'success',null,'test','{}'::jsonb)
         from generate_series(1,105) g`,
        [platformAdmin],
      )
      const page = (await service.query<{ result: { events: unknown[]; has_more: boolean; next_cursor: unknown } }>(
        'select public.admin_list_audit_events(null,null,null,500,null,null) as result',
      )).rows[0].result
      assert.equal(page.events.length, 100, 'audit page is bounded to 100')
      assert.equal(page.has_more, true)
      assert(page.next_cursor)

      await expectDenied(admin.query('update public.audit_events set source=$1 where id=$2', ['tampered', eventA]), /append-only/)
      await expectDenied(admin.query('delete from public.audit_events where id=$1', [platformEvent]), /append-only/)
      assert.equal(Number((await admin.query('select count(*) as count from public.audit_events where id=any($1::uuid[])', [[eventA, platformEvent]])).rows[0].count), 2)

      await admin.query('begin')
      try {
        await admin.query(`update public.profiles set role='member' where role='admin' and is_active=true and id<>$1`, [platformAdmin])
        await expectDenied(admin.query(`update public.profiles set role='member' where id=$1`, [platformAdmin]), /final active platform admin/)
      } finally {
        await admin.query('rollback')
      }

      const migration = await readFile('supabase-v2/migrations/00000000000017_admin_audit.sql', 'utf8')
      const workspaceRoute = await readFile('src/app/api/workspace/members/route.ts', 'utf8')
      const directorySource = await readFile('src/lib/admin/workspaces.ts', 'utf8')
      assert.match(migration, /audit_events_append_only/)
      assert.match(migration, /audit_events_created_idx/)
      assert.match(workspaceRoute, /context\.workspace\.workspaceId/)
      assert.doesNotMatch(workspaceRoute, /workspaceId:\s*z\./, 'workspace membership API does not accept browser workspace scope')
      assert.doesNotMatch(workspaceRoute, /platform_admin'\]/, 'workspace role input cannot grant platform admin')
      assert.doesNotMatch(directorySource, /select\([^)]*(password|token|secret)/i)
    } finally { await service.end() }

    console.log('SAAS8_ADMIN_AUDIT_PASS')
  } finally {
    await admin.query('delete from public.workspaces where id=any($1::uuid[])', [[workspaceA, workspaceB]]).catch(() => undefined)
    await admin.query(`update public.profiles set role='member' where id=any($1::uuid[]) and role='admin' and (select count(*) from public.profiles where role='admin' and is_active=true) > 1`, [fixtureUsers]).catch(() => undefined)
    await admin.query('delete from public.profiles where id=any($1::uuid[])', [fixtureUsers]).catch(() => undefined)
    await admin.query('delete from auth.users where id=any($1::uuid[])', [fixtureUsers]).catch(() => undefined)
    await admin.end()
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
