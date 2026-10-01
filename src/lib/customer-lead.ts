export const CUSTOMER_LEAD_STATUSES = [
  'all', 'new', 'email_ready', 'contacted', 'replied', 'interested',
  'not_interested', 'reactivation_due', 'dead',
] as const

export type CustomerLeadStatus = Exclude<typeof CUSTOMER_LEAD_STATUSES[number], 'all'>
export type CustomerLeadFilter = typeof CUSTOMER_LEAD_STATUSES[number]
export type CustomerLeadOutcome = 'interested' | 'not_interested' | null

export const CUSTOMER_LEAD_STATUS_LABELS: Record<CustomerLeadFilter, string> = {
  all: 'All',
  new: 'New',
  email_ready: 'Email Ready',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  not_interested: 'Not Interested',
  reactivation_due: 'Reactivation Due',
  dead: 'Dead',
}

export interface CustomerLeadStatusFacts {
  status?: string | null
  customer_outcome?: string | null
  reactivation_due?: boolean | null
}

/** Customer-safe projection. Raw workflow state never needs to reach customer JSX. */
export function customerLeadStatus(facts: CustomerLeadStatusFacts): CustomerLeadStatus {
  if (facts.customer_outcome === 'not_interested') return 'not_interested'
  if (facts.customer_outcome === 'interested') return 'interested'
  if (facts.reactivation_due) return 'reactivation_due'

  switch (facts.status) {
    case 'email_ready': return 'email_ready'
    case 'contacted': return 'contacted'
    case 'replied': return 'replied'
    case 'interested':
    case 'negotiating':
    case 'closed':
    case 'closed_manual': return 'interested'
    case 'dead': return 'dead'
    case 'new':
    case 'researched':
    default: return 'new'
  }
}

export function isCustomerLeadFilter(value: unknown): value is CustomerLeadFilter {
  return typeof value === 'string' && (CUSTOMER_LEAD_STATUSES as readonly string[]).includes(value)
}

export type CustomerActivityKind = 'lead_added' | 'email_sent' | 'reply_received' | 'outcome' | 'reactivation_due'

const CUSTOMER_ACTIVITY_KINDS: Readonly<Record<string, CustomerActivityKind>> = {
  lead_found: 'lead_added',
  lead_created: 'lead_added',
  email_sent: 'email_sent',
  follow_up_1_sent: 'email_sent',
  follow_up_2_sent: 'email_sent',
  follow_up_3_sent: 'email_sent',
  reply_received: 'reply_received',
  customer_outcome_interested: 'outcome',
  customer_outcome_not_interested: 'outcome',
  customer_outcome_cleared: 'outcome',
  customer_reactivation_due: 'reactivation_due',
}

export function formatCustomerActivity(event: {
  event_type: string
  business_name?: string | null
}): { kind: CustomerActivityKind; text: string } | null {
  const kind = CUSTOMER_ACTIVITY_KINDS[event.event_type]
  if (!kind) return null
  const business = event.business_name?.trim() || 'A business'
  if (kind === 'lead_added') return { kind, text: `Added ${business}` }
  if (kind === 'email_sent') return { kind, text: `Email sent to ${business}` }
  if (kind === 'reply_received') return { kind, text: `${business} replied` }
  if (kind === 'reactivation_due') return { kind, text: `Reconnect due for ${business}` }
  if (event.event_type === 'customer_outcome_interested') return { kind, text: `Marked ${business} as Interested` }
  if (event.event_type === 'customer_outcome_not_interested') return { kind, text: `Marked ${business} as Not Interested` }
  return { kind, text: `Cleared the outcome for ${business}` }
}
