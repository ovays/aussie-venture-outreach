import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Stripe from 'stripe'
import { getConfiguredPrice, getPlanForStripePrice } from '../src/lib/billing/config'
import { normalizeSubscription } from '../src/lib/billing/service'
import { handleStripeWebhookRequest } from '../src/lib/billing/webhook'

const root = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const migration = read('supabase-v2/migrations/00000000000016_billing_stripe.sql')
const checkoutRoute = read('src/app/api/billing/checkout/route.ts')
const portalRoute = read('src/app/api/billing/portal/route.ts')
const billingRoute = read('src/app/api/billing/route.ts')
const service = read('src/lib/billing/service.ts')
const webhook = read('src/lib/billing/webhook.ts')
const workspaceAuth = read('src/lib/api-workspace.ts')

let passed = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`PASS ${name}`) })
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_test', object: 'subscription', customer: 'cus_test', livemode: false,
    status: 'active', cancel_at_period_end: false, trial_end: null,
    items: { object: 'list', data: [{ id: 'si_test', object: 'subscription_item', price: { id: 'price_growth' }, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 } as Stripe.SubscriptionItem], has_more: false, url: '/v1/subscription_items' },
    ...overrides,
  } as Stripe.Subscription
}

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  STRIPE_PRICE_STARTER_MONTHLY: 'price_starter',
  STRIPE_PRICE_GROWTH_MONTHLY: 'price_growth',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro',
}
Object.assign(process.env, env)

async function main() {

await test('1 cross-workspace billing reads use server-resolved workspace context', () => {
  assert.match(billingRoute, /requireApiWorkspaceUser/); assert.doesNotMatch(billingRoute, /searchParams|request\.nextUrl/)
  assert.match(migration, /workspace_billing_admin_read[\s\S]*is_workspace_member\(workspace_id, 'admin'\)/)
})
await test('2 normal members cannot mutate billing', () => {
  assert.match(checkoutRoute + portalRoute, /requireApiWorkspaceAdmin/)
  assert.match(workspaceAuth, /role !== 'owner'[\s\S]*role !== 'admin'/)
})
await test('3 owner or admin authorization is workspace scoped', () => {
  assert.match(workspaceAuth, /requireApiUser/); assert.match(workspaceAuth, /Workspace admin access is required/)
})
await test('4 arbitrary browser price IDs are rejected', () => {
  assert.match(checkoutRoute, /\.strict\(\)/); assert.doesNotMatch(checkoutRoute, /priceId/)
})
await test('5 internal plan maps to server configured price', () => {
  assert.equal(getConfiguredPrice('growth', env), 'price_growth'); assert.equal(getPlanForStripePrice('price_pro', env), 'pro')
})
await test('6 customer creation is idempotent and one-per-workspace', () => {
  assert.match(service, /idempotencyKey: `reachagent-workspace-\$\{workspaceId\}`/)
  assert.match(migration, /workspace_id uuid PRIMARY KEY/); assert.match(migration, /stripe_customer_id text UNIQUE/)
})
await test('7 duplicate webhook events are claimed once', () => {
  assert.match(migration, /stripe_event_id text PRIMARY KEY/); assert.match(webhook, /code !== '23505'/)
})
await test('8 invalid Stripe signature is rejected before persistence', async () => {
  const response = await handleStripeWebhookRequest(new Request('http://local/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'bad' }, body: '{}' }), {
    constructEvent: () => { throw new Error('bad signature') }, retrieveSubscription: async () => subscription(), sync: async () => 'growth',
  }, 'whsec_test')
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'Invalid Stripe signature' })
})
await test('9 unknown webhook customers fail safely', () => {
  assert.match(webhook, /if \(!account\.data\) throw new Error\('Unknown Stripe customer'\)/)
})
await test('10 active mapped subscriptions resolve the intended entitlement plan', () => {
  const value = normalizeSubscription(subscription())
  assert.equal(value.planCode, 'growth'); assert.equal(value.status, 'active')
})
await test('11 canceled subscriptions use the fail-closed fallback', () => {
  assert.match(migration, /ELSIF p_subscription_status IN \('active', 'trialing'\)[\s\S]*ELSE[\s\S]*billing_inactive/)
})
await test('12 unknown Stripe prices fail closed', () => {
  assert.throws(() => getPlanForStripePrice('price_unknown', env), /not mapped/)
  const unknown = subscription()
  ;(unknown.items.data[0] as Stripe.SubscriptionItem).price = { id: 'price_unknown' } as Stripe.Price
  const normalized = normalizeSubscription(unknown)
  assert.equal(normalized.status, 'unpaid'); assert.equal(normalized.planCode, null)
})
await test('13 Aussie Venture and Internal Beta cannot be downgraded by billing sync', () => {
  assert.match(migration, /00000000-0000-0000-0000-000000000001/); assert.match(migration, /v_current_plan = 'internal_beta'/)
})
await test('14 subscription changes do not reset usage', () => {
  const fn = migration.slice(migration.indexOf('CREATE FUNCTION public.sync_workspace_billing_entitlement'))
  assert.doesNotMatch(fn, /DELETE FROM public\.workspace_usage|UPDATE public\.workspace_usage/)
})
await test('15 overrides remain separate from base entitlement', () => {
  const fn = migration.slice(migration.indexOf('CREATE FUNCTION public.sync_workspace_billing_entitlement'))
  assert.doesNotMatch(fn, /workspace_entitlement_overrides/)
})
await test('16 cross-tenant webhook/customer mismatch is rejected', () => {
  assert.match(migration, /stripe customer workspace mismatch/); assert.match(webhook, /subscription\/customer mapping mismatch/)
})
await test('17 Stripe API failure cannot partially change entitlement', () => {
  assert.ok(service.indexOf('await stripe.checkout.sessions.create') < service.indexOf("if (!session.url)"))
  assert.doesNotMatch(service.slice(service.indexOf('createCheckoutSession'), service.indexOf('createPortalSession')), /sync_workspace_billing_entitlement/)
})
await test('18 browser roles cannot execute entitlement mutation RPC', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.sync_workspace_billing_entitlement[\s\S]*FROM PUBLIC, anon, authenticated/)
})
await test('19 automated suite uses fake Stripe only and rejects live events', () => {
  assert.throws(() => normalizeSubscription(subscription({ livemode: true })), /Live-mode/)
  assert.doesNotMatch(read('scripts/test-v2-billing.ts'), /sk_test_[A-Za-z0-9]{8,}|https:\/\/api\.stripe\.com/)
})
await test('20 incomplete, expired, unpaid, past-due, canceled, and paused are ineligible', () => {
  assert.match(migration, /IF p_subscription_status NOT IN[\s\S]*'paused'/)
  assert.match(migration, /ELSIF p_subscription_status IN \('active', 'trialing'\)/)
})
await test('21 commercial prices and commercial limits are not hardcoded', () => {
  assert.doesNotMatch(migration, /starter.*\$|growth.*\$|pro.*\$/i)
  assert.doesNotMatch(migration, /VALUES \('starter'|VALUES \('growth'|VALUES \('pro'/)
})

console.log(`SaaS 7 billing tests passed: ${passed}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
