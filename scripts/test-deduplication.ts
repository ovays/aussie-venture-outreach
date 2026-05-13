/**
 * READ-ONLY diagnostic script.
 * Simulates franchise duplicate detection with no sends, no DB mutations, and no API calls.
 *
 * Run: npx tsx scripts/test-deduplication.ts
 */

import {
  checkLeadDedupe,
  createLeadDedupeIndex,
  extractRootDomainFromEmail,
  type DedupeLead,
} from '../src/lib/deduplication'

type Candidate = {
  businessName: string
  email: string
}

const existingPipelineLeads: DedupeLead[] = [
  {
    id: 'lead-001',
    business_name: 'El Jannah Auburn',
    email: 'enquiries@eljannah.com.au',
    status: 'contacted',
  },
  {
    id: 'lead-002',
    business_name: 'Independent Cafe Parramatta',
    email: 'hello@independentcafe.com.au',
    status: 'new',
  },
  {
    id: 'lead-003',
    business_name: 'Travel Co Sydney',
    email: 'bookings@mail.travelco.com.au',
    status: 'email_ready',
  },
]

const candidates: Candidate[] = [
  {
    businessName: 'El Jannah Bankstown',
    email: 'enquiries@eljannah.com.au',
  },
  {
    businessName: 'El Jannah Liverpool',
    email: 'catering@eljannah.com.au',
  },
  {
    businessName: 'Travel Co Melbourne',
    email: 'sales@travelco.com.au',
  },
  {
    businessName: 'Fresh New Bakery',
    email: 'orders@freshnewbakery.com.au',
  },
]

function printDecision(candidate: Candidate): void {
  const decision = checkLeadDedupe(candidate.email, dedupeIndex)
  const rootDomain = extractRootDomainFromEmail(candidate.email)

  console.log(`\nCandidate: ${candidate.businessName}`)
  console.log(`Email    : ${candidate.email}`)
  console.log(`Domain   : ${rootDomain ?? 'none'}`)

  if (!decision.duplicate) {
    console.log('Decision : KEEP')
    console.log('Reason   : no duplicate email or root domain found')
    return
  }

  console.log('Decision : SKIP')
  console.log(`Reason   : ${decision.reason}`)
  console.log(`Matched  : ${decision.match.businessName ?? decision.match.id}`)
  console.log(`Existing : ${decision.match.email} (${decision.match.status ?? 'unknown'})`)
}

const dedupeIndex = createLeadDedupeIndex(existingPipelineLeads)

console.log('='.repeat(72))
console.log('DEDUPLICATION DRY RUN - NO SENDS, NO DB MUTATIONS, NO API CALLS')
console.log('='.repeat(72))
console.log(`Existing email keys : ${dedupeIndex.byEmail.size}`)
console.log(`Existing domains    : ${dedupeIndex.byRootDomain.size}`)

for (const candidate of candidates) {
  printDecision(candidate)
}

console.log('\n' + '='.repeat(72))
