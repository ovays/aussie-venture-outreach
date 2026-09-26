import 'server-only'

import type Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { createStripeClient, getStripeWebhookSecret } from './stripe-client'
import { syncWorkspaceBillingEntitlement } from './service'

const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
])

export interface StripeWebhookDependencies {
  constructEvent(rawBody: string, signature: string, secret: string): Stripe.Event
  retrieveSubscription(id: string): Promise<Stripe.Subscription>
  sync(workspaceId: string, subscription: Stripe.Subscription): Promise<string>
}

function defaultDependencies(): StripeWebhookDependencies {
  const stripe = createStripeClient()
  return {
    constructEvent: (body, signature, secret) => stripe.webhooks.constructEvent(body, signature, secret),
    retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
    sync: syncWorkspaceBillingEntitlement,
  }
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Webhook processing failed'
  return value.replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, '[redacted]').slice(0, 500)
}

async function claimEvent(event: Stripe.Event): Promise<'claimed' | 'duplicate' | 'in_progress'> {
  const db = createServiceClient()
  const insert = await db.from('stripe_webhook_events').insert({
    stripe_event_id: event.id, event_type: event.type, status: 'processing',
  })
  if (!insert.error) return 'claimed'
  if (insert.error.code !== '23505') throw new Error(insert.error.message)

  const existing = await db.from('stripe_webhook_events')
    .select('status, updated_at').eq('stripe_event_id', event.id).single()
  if (existing.error) throw new Error(existing.error.message)
  if (existing.data.status === 'processed' || existing.data.status === 'ignored') return 'duplicate'
  const stale = existing.data.status === 'processing'
    && Date.parse(existing.data.updated_at) < Date.now() - 5 * 60_000
  if (existing.data.status === 'processing' && !stale) return 'in_progress'
  const retry = await db.from('stripe_webhook_events')
    .update({ status: 'processing', error_detail: null })
    .eq('stripe_event_id', event.id).eq('status', existing.data.status).eq('updated_at', existing.data.updated_at)
    .select('stripe_event_id').maybeSingle()
  if (retry.error) throw new Error(retry.error.message)
  return retry.data ? 'claimed' : 'duplicate'
}

async function finishEvent(eventId: string, status: 'processed' | 'ignored' | 'failed', workspaceId?: string, error?: string) {
  const db = createServiceClient()
  const result = await db.from('stripe_webhook_events').update({
    status, workspace_id: workspaceId ?? null,
    processed_at: status === 'failed' ? null : new Date().toISOString(),
    error_detail: error ?? null,
  }).eq('stripe_event_id', eventId).eq('status', 'processing')
  if (result.error) throw new Error(result.error.message)
}

function stringId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : value?.id ?? null
}

async function subscriptionFromEvent(event: Stripe.Event, dependencies: StripeWebhookDependencies) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    if (session.livemode) throw new Error('Live-mode Stripe event rejected')
    const subscriptionId = stringId(session.subscription)
    if (!subscriptionId) throw new Error('Checkout session has no subscription')
    return dependencies.retrieveSubscription(subscriptionId)
  }
  return event.data.object as Stripe.Subscription
}

export async function handleStripeWebhookRequest(
  request: Request,
  dependencies: StripeWebhookDependencies = defaultDependencies(),
  webhookSecret = getStripeWebhookSecret(),
): Promise<Response> {
  const signature = request.headers.get('stripe-signature')
  if (!signature) return Response.json({ error: 'Missing Stripe signature' }, { status: 400 })

  let event: Stripe.Event
  try {
    const rawBody = await request.text()
    event = dependencies.constructEvent(rawBody, signature, webhookSecret)
  } catch {
    return Response.json({ error: 'Invalid Stripe signature' }, { status: 400 })
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    const claim = await claimEvent(event)
    if (claim === 'claimed') await finishEvent(event.id, 'ignored')
    if (claim === 'in_progress') return Response.json({ error: 'Event is already processing' }, { status: 409 })
    return Response.json({ received: true, ignored: true, duplicate: claim === 'duplicate' })
  }

  const claim = await claimEvent(event)
  if (claim === 'duplicate') return Response.json({ received: true, duplicate: true })
  if (claim === 'in_progress') return Response.json({ error: 'Event is already processing' }, { status: 409 })

  let workspaceId: string | undefined
  try {
    const subscription = await subscriptionFromEvent(event, dependencies)
    if (subscription.livemode) throw new Error('Live-mode Stripe event rejected')
    const customerId = stringId(subscription.customer)
    if (!customerId) throw new Error('Subscription has no customer')

    const db = createServiceClient()
    const account = await db.from('workspace_billing_accounts')
      .select('workspace_id, stripe_subscription_id, subscription_status').eq('stripe_customer_id', customerId).maybeSingle()
    if (account.error) throw new Error(account.error.message)
    if (!account.data) throw new Error('Unknown Stripe customer')
    const replaceable = ['canceled', 'unpaid', 'incomplete_expired'].includes(account.data.subscription_status)
    if (account.data.stripe_subscription_id && account.data.stripe_subscription_id !== subscription.id && !replaceable) {
      throw new Error('Stripe subscription/customer mapping mismatch')
    }
    const resolvedWorkspaceId = account.data.workspace_id as string
    workspaceId = resolvedWorkspaceId
    await dependencies.sync(resolvedWorkspaceId, subscription)
    await finishEvent(event.id, 'processed', resolvedWorkspaceId)
    return Response.json({ received: true })
  } catch (error) {
    const detail = safeError(error)
    await finishEvent(event.id, 'failed', workspaceId, detail)
    return Response.json({ error: 'Stripe webhook processing failed' }, { status: 500 })
  }
}
