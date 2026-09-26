import 'server-only'

import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { getAvailableBillingPlans, getConfiguredPrice, getPlanForStripePrice } from './config'
import { createStripeClient } from './stripe-client'
import { STRIPE_SUBSCRIPTION_STATUSES, type BillingSummary, type StripeSubscriptionStatus } from './types'

const INTERNAL_BETA_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

type BillingRow = {
  workspace_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_price_id: string | null
  plan_code: string | null
  subscription_status: StripeSubscriptionStatus | 'none'
  current_period_end: string | null
  cancel_at_period_end: boolean
  trial_end: string | null
  sync_status: 'pending' | 'synced' | 'error'
}

export interface StripeBillingClient {
  customers: { create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Customer> }
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session> } }
  billingPortal: { sessions: { create(params: Stripe.BillingPortal.SessionCreateParams): Promise<Stripe.BillingPortal.Session> } }
}

async function entitlement(workspaceId: string): Promise<{ planCode: string; planName: string }> {
  const db = createServiceClient()
  const { data, error } = await db.from('workspace_entitlements')
    .select('entitlement_profiles(plan_code, name)').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  const profile = data?.entitlement_profiles as unknown as { plan_code: string; name: string } | null
  return { planCode: profile?.plan_code ?? 'none', planName: profile?.name ?? 'Not assigned' }
}

async function readyBillingPlans() {
  const configured = getAvailableBillingPlans()
  if (configured.length === 0) return configured
  const db = createServiceClient()
  const { data, error } = await db.from('entitlement_profiles')
    .select('plan_code, is_internal, entitlement_limits(dimension_key)')
    .in('plan_code', configured.map((plan) => plan.code))
  if (error) throw new Error(error.message)
  const ready = new Set((data ?? []).filter((row) => {
    const limits = row.entitlement_limits as unknown as Array<{ dimension_key: string }>
    return row.is_internal === false && limits.length === 6 && new Set(limits.map((limit) => limit.dimension_key)).size === 6
  }).map((row) => row.plan_code))
  return configured.filter((plan) => ready.has(plan.code))
}

async function assertEntitlementPlanReady(planCode: string): Promise<void> {
  const ready = await readyBillingPlans()
  if (!ready.some((plan) => plan.code === planCode)) {
    throw new Error('This plan does not have a complete approved entitlement profile')
  }
}

export async function getWorkspaceBillingSummary(workspaceId: string): Promise<BillingSummary> {
  const db = createServiceClient()
  const [{ data, error }, current] = await Promise.all([
    db.from('workspace_billing_accounts').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    entitlement(workspaceId),
  ])
  if (error) throw new Error(error.message)
  const row = data as unknown as BillingRow | null
  const managedInternally = workspaceId === INTERNAL_BETA_WORKSPACE_ID || current.planCode === 'internal_beta'
  return {
    planCode: current.planCode,
    planName: current.planName,
    subscriptionStatus: row?.subscription_status ?? 'none',
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    trialEnd: row?.trial_end ?? null,
    hasStripeCustomer: !!row?.stripe_customer_id,
    managedInternally,
    syncStatus: row?.sync_status ?? 'not_configured',
    availablePlans: managedInternally ? [] : await readyBillingPlans(),
  }
}

export async function ensureStripeCustomer(
  workspaceId: string,
  actorEmail: string | undefined,
  stripe: StripeBillingClient = createStripeClient(),
): Promise<string> {
  const db = createServiceClient()
  const existing = await db.from('workspace_billing_accounts')
    .select('stripe_customer_id').eq('workspace_id', workspaceId).maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  if (existing.data?.stripe_customer_id) return existing.data.stripe_customer_id

  const customer = await stripe.customers.create({
    email: actorEmail,
    metadata: { reachagent_workspace_id: workspaceId },
  }, { idempotencyKey: `reachagent-workspace-${workspaceId}` })
  if (customer.livemode) throw new Error('Live-mode Stripe customer rejected')

  const inserted = await db.from('workspace_billing_accounts').insert({
    workspace_id: workspaceId, stripe_customer_id: customer.id, subscription_status: 'none', sync_status: 'pending',
  }).select('stripe_customer_id').single()
  if (!inserted.error && inserted.data) return inserted.data.stripe_customer_id
  if (inserted.error?.code !== '23505') throw new Error(inserted.error?.message ?? 'Unable to save Stripe customer')

  const raced = await db.from('workspace_billing_accounts')
    .select('stripe_customer_id').eq('workspace_id', workspaceId).single()
  if (raced.error || !raced.data?.stripe_customer_id) throw new Error('Unable to resolve Stripe customer race')
  if (raced.data.stripe_customer_id !== customer.id) throw new Error('Stripe customer workspace conflict')
  return raced.data.stripe_customer_id
}

function appUrl(): string {
  const value = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!value) throw new Error('NEXT_PUBLIC_APP_URL is not configured')
  return new URL(value).origin
}

export async function createCheckoutSession(
  workspaceId: string,
  actorEmail: string | undefined,
  planCode: string,
  stripe: StripeBillingClient = createStripeClient(),
): Promise<string> {
  const current = await entitlement(workspaceId)
  if (workspaceId === INTERNAL_BETA_WORKSPACE_ID || current.planCode === 'internal_beta') {
    throw new Error('Internal Beta billing is managed internally')
  }
  const price = getConfiguredPrice(planCode)
  await assertEntitlementPlanReady(planCode)
  const customer = await ensureStripeCustomer(workspaceId, actorEmail, stripe)
  const base = appUrl()
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', customer, line_items: [{ price, quantity: 1 }],
    success_url: `${base}/dashboard/settings?billing=success`,
    cancel_url: `${base}/dashboard/settings?billing=cancelled`,
    client_reference_id: workspaceId,
    subscription_data: { metadata: { reachagent_workspace_id: workspaceId, reachagent_plan_code: planCode } },
  })
  if (!session.url) throw new Error('Stripe Checkout did not return a URL')
  return session.url
}

export async function createPortalSession(
  workspaceId: string,
  stripe: StripeBillingClient = createStripeClient(),
): Promise<string> {
  const db = createServiceClient()
  const { data, error } = await db.from('workspace_billing_accounts')
    .select('stripe_customer_id').eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.stripe_customer_id) throw new Error('No Stripe customer exists for this workspace')
  const session = await stripe.billingPortal.sessions.create({
    customer: data.stripe_customer_id, return_url: `${appUrl()}/dashboard/settings`,
  })
  return session.url
}

export function normalizeSubscription(subscription: Stripe.Subscription) {
  if (subscription.livemode) throw new Error('Live-mode Stripe event rejected')
  const item = subscription.items.data[0]
  if (!item || subscription.items.data.length !== 1) throw new Error('Subscription must contain exactly one price')
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  let status: StripeSubscriptionStatus = (STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)
    ? subscription.status as StripeSubscriptionStatus
    : 'unpaid'
  const eligible = status === 'active' || status === 'trialing'
  let planCode: ReturnType<typeof getPlanForStripePrice> | null = null
  try { planCode = getPlanForStripePrice(item.price.id) } catch { if (eligible) status = 'unpaid' }
  return {
    customerId, subscriptionId: subscription.id, priceId: item.price.id, planCode,
    status,
    currentPeriodStart: new Date(item.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(item.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
  }
}

export async function syncWorkspaceBillingEntitlement(workspaceId: string, subscription: Stripe.Subscription): Promise<string> {
  const normalized = normalizeSubscription(subscription)
  const db = createServiceClient()
  const { data, error } = await db.rpc('sync_workspace_billing_entitlement' as never, {
    p_workspace_id: workspaceId,
    p_stripe_customer_id: normalized.customerId,
    p_stripe_subscription_id: normalized.subscriptionId,
    p_stripe_price_id: normalized.priceId,
    p_plan_code: normalized.planCode,
    p_subscription_status: normalized.status,
    p_current_period_start: normalized.currentPeriodStart,
    p_current_period_end: normalized.currentPeriodEnd,
    p_cancel_at_period_end: normalized.cancelAtPeriodEnd,
    p_trial_end: normalized.trialEnd,
  } as never)
  if (error) throw new Error(error.message)
  return String(data)
}

export async function adminListBillingAccounts() {
  const db = createServiceClient()
  const [workspaces, accounts, entitlements] = await Promise.all([
    db.from('workspaces').select('id, name').order('created_at'),
    db.from('workspace_billing_accounts').select(`
      workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan_code,
      subscription_status, current_period_end, sync_status, last_sync_error, last_synced_at
    `),
    db.from('workspace_entitlements').select('workspace_id, entitlement_profiles(plan_code)'),
  ])
  if (workspaces.error) throw new Error(workspaces.error.message)
  if (accounts.error) throw new Error(accounts.error.message)
  if (entitlements.error) throw new Error(entitlements.error.message)
  const accountByWorkspace = new Map((accounts.data ?? []).map((row) => [row.workspace_id, row]))
  const entitlementByWorkspace = new Map((entitlements.data ?? []).map((row) => {
    const profile = row.entitlement_profiles as unknown as { plan_code: string } | null
    return [row.workspace_id, profile?.plan_code ?? 'none']
  }))
  return (workspaces.data ?? []).map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    entitlementPlanCode: entitlementByWorkspace.get(workspace.id) ?? 'none',
    billing: accountByWorkspace.get(workspace.id) ?? null,
  }))
}
