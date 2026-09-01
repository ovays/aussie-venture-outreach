import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyDuplicateGroup,
  normalizeDataQualityValue,
  normalizeSocialIdentity,
  normalizeWebsiteIdentity,
  type DuplicateSignalLead,
} from '../src/lib/data-quality'

const migrationPath = 'supabase/migrations/051_fix_data_quality_classification.sql'
const migration = fs.readFileSync(path.resolve(process.cwd(), migrationPath), 'utf8')

type Expected = ReturnType<typeof classifyDuplicateGroup>['issueType']
type Fixture = { name: string; leads: DuplicateSignalLead[]; expected: Expected }

const fixtures: Fixture[] = [
  {
    name: 'Caffe Vicini / Cabravale', expected: 'shared_email',
    leads: [
      { id: 'caffe', business_name: 'Caffe Vicini', website: 'https://cabravale.com.au/dining/caffe-vicini', phone: '02 9727 3600', address: '1 Bartley Street', suburb: 'Canley Vale', instagram_handle: '@cabravaleclub' },
      { id: 'club', business_name: 'Cabravale Club Resort', website: 'https://cabravale.com.au', phone: '02 9727 3600', address: '1 Bartley Street', suburb: 'Canley Vale', instagram_handle: '@cabravaleclub' },
    ],
  },
  {
    name: 'same email only', expected: 'uncertain_email_group',
    leads: [{ id: 'a', business_name: 'Same Co' }, { id: 'b', business_name: 'Same Co' }],
  },
  {
    name: 'same root domain only', expected: 'uncertain_email_group',
    leads: [
      { id: 'a', business_name: 'Same Co', website: 'https://example.com' },
      { id: 'b', business_name: 'Same Co', website: 'http://www.example.com/' },
    ],
  },
  {
    name: 'root page vs child subpage', expected: 'uncertain_email_group',
    leads: [
      { id: 'a', business_name: 'Same Co', website: 'https://example.com' },
      { id: 'b', business_name: 'Same Co', website: 'https://example.com/venues/cafe' },
    ],
  },
  {
    name: 'one missing phone and social', expected: 'uncertain_email_group',
    leads: [
      { id: 'a', business_name: 'Same Co', phone: '02 1234 5678', instagram_handle: '@sameco' },
      { id: 'b', business_name: 'Same Co', phone: null, instagram_handle: null },
    ],
  },
  {
    name: 'placeholder phone and social are missing', expected: 'uncertain_email_group',
    leads: [
      { id: 'a', business_name: 'Same Co', phone: '02 1234 5678', instagram_handle: '@sameco' },
      { id: 'b', business_name: 'Same Co', phone: 'Not available', instagram_handle: 'Not found' },
    ],
  },
  {
    name: 'same address remains shared email', expected: 'shared_email',
    leads: [
      { id: 'tenant', business_name: 'Tenant Cafe', address: '10 High Street', suburb: 'Sydney' },
      { id: 'centre', business_name: 'High Street Centre', address: '10 High Street', suburb: 'Sydney' },
    ],
  },
  {
    name: 'true exact duplicate', expected: 'duplicate_lead',
    leads: [
      { id: 'a', business_name: 'Exact Cafe', phone: '02 1234 5678', address: '10 High Street', suburb: 'Sydney' },
      { id: 'b', business_name: 'Exact Cafe', phone: '(02) 1234 5678', address: '10 High St', suburb: 'Sydney' },
    ],
  },
]

function compact(value: string | null | undefined): string | null {
  const present = normalizeDataQualityValue(value)
  return present ? present.toLowerCase().replace(/[^a-z0-9]/g, '') || null : null
}

// Executable model of classify_data_quality_group's SQL stats/CASE. Fixture
// parity protects the two implementations while the migration remains unapplied.
function classifySqlModel(leads: DuplicateSignalLead[]): Expected {
  const values = {
    names: leads.map((lead) => compact(lead.business_name)),
    websites: leads.map((lead) => {
      const identity = normalizeWebsiteIdentity(lead.website)
      return identity?.includes('/') ? identity : null
    }),
    phones: leads.map((lead) => compact(lead.phone)),
    socials: leads.map((lead) => normalizeSocialIdentity(lead.instagram_handle)),
    addresses: leads.map((lead) => normalizeDataQualityValue(lead.address)
      ? compact(`${normalizeDataQualityValue(lead.address)}${normalizeDataQualityValue(lead.suburb) ?? ''}`)
      : null),
  }
  const allSamePresent = (items: Array<string | null>) => items.every(Boolean) && new Set(items).size === 1
  const sameName = allSamePresent(values.names)
  const strong = [values.websites, values.phones, values.socials, values.addresses].some(allSamePresent)
  if (sameName && strong) return 'duplicate_lead'
  if (values.names.every(Boolean) && new Set(values.names).size > 1) return 'shared_email'
  return 'uncertain_email_group'
}

for (const fixture of fixtures) {
  assert.equal(classifyDuplicateGroup(fixture.leads).issueType, fixture.expected, fixture.name)
  assert.equal(classifySqlModel(fixture.leads), fixture.expected, `SQL/TypeScript parity: ${fixture.name}`)
}

assert.equal(normalizeWebsiteIdentity('https://cabravale.com.au'), 'cabravale.com.au')
assert.equal(normalizeWebsiteIdentity('https://cabravale.com.au/dining/caffe-vicini'), 'cabravale.com.au/dining/caffe-vicini')
for (const placeholder of ['Not found', 'Not mentioned', 'Not available', 'Unknown', 'N/A', '-']) {
  assert.equal(normalizeDataQualityValue(placeholder), null, `${placeholder} is missing`)
  assert.equal(normalizeSocialIdentity(placeholder), null, `${placeholder} social is missing`)
}

assert.match(migration, /name_present=lead_count AND name_count=1 AS same_name/)
assert.match(migration, /WHEN same_name AND \(same_website OR same_phone OR same_social OR same_address\) THEN 'duplicate_lead'/)
assert.match(migration, /WHEN name_present=lead_count AND name_count>1 THEN 'shared_email'/)
assert.match(migration, /website_present=lead_count AND website_count=1 AS same_website/)
assert.match(migration, /phone_present=lead_count AND phone_count=1 AS same_phone/)
assert.match(migration, /social_present=lead_count AND social_count=1 AS same_social/)
assert.match(migration, /position\('\/' IN public\.data_quality_website_identity\(p_value\)\) > 0/)
for (const field of ['email','business_name','website','phone','address','suburb','instagram_handle']) {
  assert.match(migration, new RegExp(`UPDATE OF [^\\n]*\\b${field}\\b`), `refresh trigger covers ${field}`)
}

assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.claim_recipient_outreach/i, 'ownership claim function is unchanged')
assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?recipient_outreach_ownership/i, 'ownership rows are unchanged')
assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+(?:public\.)?leads\b/i, 'no leads are deleted')
assert.doesNotMatch(migration, /^\s*MERGE\s+INTO\s+/im, 'no leads are merged')

console.log('Data Quality classifier fix tests passed')
