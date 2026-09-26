import 'server-only'

import { BILLING_PLAN_CODES, type BillingPlanCode } from './types'

const ENV_BY_PLAN: Record<BillingPlanCode, string> = {
  starter: 'STRIPE_PRICE_STARTER_MONTHLY',
  growth: 'STRIPE_PRICE_GROWTH_MONTHLY',
  pro: 'STRIPE_PRICE_PRO_MONTHLY',
}

const NAME_BY_PLAN: Record<BillingPlanCode, string> = {
  starter: 'Starter', growth: 'Growth', pro: 'Pro',
}

export function getStripePriceMapping(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<BillingPlanCode, string> {
  const entries: Array<[BillingPlanCode, string]> = []
  const used = new Set<string>()
  for (const code of BILLING_PLAN_CODES) {
    const value = env[ENV_BY_PLAN[code]]?.trim()
    if (!value) continue
    if (!value.startsWith('price_')) throw new Error(`${ENV_BY_PLAN[code]} must be a Stripe price ID`)
    if (used.has(value)) throw new Error('Each configured Stripe price must map to exactly one plan')
    used.add(value)
    entries.push([code, value])
  }
  return new Map(entries)
}

export function getConfiguredPrice(planCode: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!(BILLING_PLAN_CODES as readonly string[]).includes(planCode)) throw new Error('Unknown billing plan')
  const price = getStripePriceMapping(env).get(planCode as BillingPlanCode)
  if (!price) throw new Error('This billing plan is not configured')
  return price
}

export function getPlanForStripePrice(priceId: string, env: NodeJS.ProcessEnv = process.env): BillingPlanCode {
  for (const [code, configuredPrice] of getStripePriceMapping(env)) {
    if (configuredPrice === priceId) return code
  }
  throw new Error('Stripe price is not mapped to an approved plan')
}

export function getAvailableBillingPlans(env: NodeJS.ProcessEnv = process.env) {
  return [...getStripePriceMapping(env).keys()].map((code) => ({ code, name: NAME_BY_PLAN[code] }))
}
