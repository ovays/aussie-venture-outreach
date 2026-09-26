export const BILLING_PLAN_CODES = ['starter', 'growth', 'pro'] as const
export type BillingPlanCode = (typeof BILLING_PLAN_CODES)[number]

export const STRIPE_SUBSCRIPTION_STATUSES = [
  'active', 'trialing', 'past_due', 'unpaid', 'canceled',
  'incomplete', 'incomplete_expired', 'paused',
] as const
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number]

export interface BillingSummary {
  planCode: string
  planName: string
  subscriptionStatus: StripeSubscriptionStatus | 'none'
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  trialEnd: string | null
  hasStripeCustomer: boolean
  managedInternally: boolean
  syncStatus: 'pending' | 'synced' | 'error' | 'not_configured'
  availablePlans: Array<{ code: BillingPlanCode; name: string }>
}
