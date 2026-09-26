import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'

async function main() {
  const client = new Client({ host: '127.0.0.1', port: 54322, user: 'supabase_admin', password: 'postgres', database: 'postgres' })
  await client.connect()
  try {
    const prerequisites = await client.query(`
      SELECT to_regclass('public.entitlement_profiles') AS entitlements,
             to_regclass('public.workspace_billing_accounts') AS billing
    `)
    assert.ok(prerequisites.rows[0].entitlements, 'Local V2 migration 14 is required')
    assert.equal(prerequisites.rows[0].billing, null, 'Local migration 16 is already present; use a fresh local baseline')

    const sql = readFileSync(resolve(process.cwd(), 'supabase-v2/migrations/00000000000016_billing_stripe.sql'), 'utf8')
    await client.query('BEGIN')
    await client.query(sql)

    const objects = await client.query(`
      SELECT
        to_regclass('public.workspace_billing_accounts') AS billing,
        to_regclass('public.stripe_webhook_events') AS events,
        to_regprocedure('public.sync_workspace_billing_entitlement(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,timestamp with time zone)') AS sync
    `)
    assert.ok(objects.rows[0].billing)
    assert.ok(objects.rows[0].events)
    assert.ok(objects.rows[0].sync)

    const fallback = await client.query(`
      SELECT p.plan_code, count(*)::int AS limits, min(l.limit_value)::int AS minimum, max(l.limit_value)::int AS maximum
      FROM public.entitlement_profiles p
      JOIN public.entitlement_limits l ON l.entitlement_profile_id = p.id
      WHERE p.plan_code = 'billing_inactive'
      GROUP BY p.plan_code
    `)
    assert.deepEqual(fallback.rows[0], { plan_code: 'billing_inactive', limits: 6, minimum: 0, maximum: 0 })

    const beta = await client.query(`
      SELECT p.plan_code
      FROM public.workspace_entitlements e
      JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
      WHERE e.workspace_id = '00000000-0000-0000-0000-000000000001'::uuid
    `)
    assert.equal(beta.rows[0]?.plan_code, 'internal_beta')

    await client.query('ROLLBACK')
    console.log('PASS migration 16 applies and rolls back on disposable local V2')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
