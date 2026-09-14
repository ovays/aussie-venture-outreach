import type { SupabaseClient } from '@supabase/supabase-js'
import { createLead, type CreateLeadInput } from '../src/lib/create-lead'
import { extractRootDomainFromEmail, isPublicEmailDomain } from '../src/lib/deduplication'

type ExistingLead = { id: string; business_name: string; email: string }

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function createSupabaseStub(existingLeads: ExistingLead[]): SupabaseClient {
  return {
    from(table: string) {
      let operation: 'select' | 'insert' = 'select'
      let exactEmail: string | null = null
      let domainFilter: string | null = null
      let insertedLead: Record<string, unknown> | null = null

      const query = {
        select() { return query },
        ilike(_column: string, value: string) { exactEmail = normalize(value); return query },
        or(value: string) { domainFilter = value; return query },
        limit() { return query },
        eq() { return query },
        insert(value: Record<string, unknown>) { operation = 'insert'; insertedLead = value; return query },
        async maybeSingle() {
          if (table === 'categories') {
            return { data: { name: 'Cafe', content_type: 'local', city_content_types: null }, error: null }
          }

          const filter = domainFilter
          const match = exactEmail
            ? existingLeads.find((lead) => normalize(lead.email) === exactEmail)
            : filter
              ? existingLeads.find((lead) => {
                  const domain = filter.match(/%@([^,]+)/)?.[1]
                  const leadDomain = normalize(lead.email).split('@')[1]
                  return Boolean(domain && (leadDomain === domain || leadDomain.endsWith(`.${domain}`)))
                })
              : undefined
          return { data: match ? { id: match.id, business_name: match.business_name } : null, error: null }
        },
        async single() {
          if (table === 'leads' && operation === 'insert' && insertedLead) {
            return { data: { id: 'new-lead', ...insertedLead }, error: null }
          }
          return { data: null, error: new Error('Unexpected single() call') }
        },
      }

      return query
    },
  } as unknown as SupabaseClient
}

const baseInput: CreateLeadInput = {
  business_name: 'New Business',
  email: 'person@example.com',
  website: 'https://new-business.example',
  suburb: 'Sydney',
  city: 'Sydney',
  category_id: '00000000-0000-4000-8000-000000000001',
  category_name: 'Cafe',
  current_stage: 'new',
}

async function check(
  name: string,
  input: Partial<CreateLeadInput>,
  existingLeads: ExistingLead[],
  expected: 'created' | 'email_duplicate' | 'domain_duplicate',
): Promise<void> {
  const result = await createLead(createSupabaseStub(existingLeads), { ...baseInput, ...input })
  const actual = result.ok ? 'created' : result.status === 409 ? result.type : `error_${result.status}`
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`)
  console.log(`PASS ${name}`)
}

async function main(): Promise<void> {
  const publicProviders = [
    'gmail.com',
    'googlemail.com',
    'hotmail.com',
    'hotmail.com.au',
    'outlook.com',
    'outlook.com.au',
    'live.com',
    'live.com.au',
    'yahoo.com',
    'yahoo.com.au',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'protonmail.com',
    'proton.me',
    'bigpond.com',
    'bigpond.net.au',
    'optusnet.com.au',
    'tpg.com.au',
    'iinet.net.au',
    'internode.on.net',
  ]

  for (const provider of publicProviders) {
    const rootDomain = extractRootDomainFromEmail(`person@${provider}`)
    if (!isPublicEmailDomain(rootDomain)) {
      throw new Error(`${provider}: expected extracted domain ${rootDomain ?? 'null'} to be public`)
    }
  }
  if (isPublicEmailDomain('on.net')) throw new Error('on.net must not be classified as a public provider')
  console.log('PASS all requested shared providers are public without classifying on.net as public')

  await check(
    'person1@gmail.com vs person2@gmail.com is not a domain duplicate',
    { email: 'person1@gmail.com' },
    [{ id: 'gmail-2', business_name: 'Other Business', email: 'person2@gmail.com' }],
    'created',
  )
  await check(
    'the same normalized Gmail address keeps shared-inbox exact-email behaviour',
    { email: ' Person1@GMAIL.com ' },
    [{ id: 'gmail-1', business_name: 'Existing Business', email: 'person1@gmail.com' }],
    'created',
  )
  await check(
    'person1@outlook.com.au vs person2@outlook.com.au is not a domain duplicate',
    { email: 'person1@outlook.com.au' },
    [{ id: 'outlook-2', business_name: 'Other Business', email: 'person2@outlook.com.au' }],
    'created',
  )
  await check(
    'person1@iinet.net.au vs person2@iinet.net.au is not a domain duplicate',
    { email: 'person1@iinet.net.au' },
    [{ id: 'iinet-2', business_name: 'Other Business', email: 'person2@iinet.net.au' }],
    'created',
  )
  await check(
    'person1@internode.on.net vs person2@internode.on.net is not a domain duplicate',
    { email: 'person1@internode.on.net' },
    [{ id: 'internode-2', business_name: 'Other Business', email: 'person2@internode.on.net' }],
    'created',
  )
  await check(
    'hello@business.com.au vs sales@business.com.au is a private-domain duplicate',
    { email: 'hello@business.com.au' },
    [{ id: 'business-2', business_name: 'Existing Business', email: 'sales@business.com.au' }],
    'domain_duplicate',
  )
  await check(
    'website input leaves existing private-domain duplicate behaviour unchanged',
    { email: 'hello@business.com.au', website: 'https://business.com.au' },
    [{ id: 'business-3', business_name: 'Existing Business', email: 'contact@business.com.au' }],
    'domain_duplicate',
  )
  await check(
    'different addresses on company.on.net remain a private-domain duplicate',
    { email: 'hello@company.on.net' },
    [{ id: 'on-net-business', business_name: 'Existing Business', email: 'sales@company.on.net' }],
    'domain_duplicate',
  )
  await check(
    'force=true bypasses a genuine private-domain warning',
    { email: 'hello@business.com.au', force: true },
    [{ id: 'business-4', business_name: 'Existing Business', email: 'sales@business.com.au' }],
    'created',
  )
  await check(
    'CSV-style force=true keeps existing exact shared-email behaviour',
    { email: 'bookings@agency.example', force: true, source: 'manual' },
    [{ id: 'csv-shared', business_name: 'Existing Business', email: 'bookings@agency.example' }],
    'created',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
