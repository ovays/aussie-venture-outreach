import 'server-only'

import Stripe from 'stripe'

let client: Stripe | null = null

export function createStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) throw new Error('Stripe is not configured')
  if (!key.startsWith('sk_test_')) throw new Error('Only a Stripe test-mode secret key is allowed')
  if (!client) client = new Stripe(key, { maxNetworkRetries: 2 })
  return client
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!secret || !secret.startsWith('whsec_')) throw new Error('Stripe webhook secret is not configured')
  return secret
}
