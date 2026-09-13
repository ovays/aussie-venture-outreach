import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isLeadSuppressed,
  leadSuppressionLabel,
  SUPPRESSED_LEADS_FILTER,
} from '../src/lib/leads-list'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

const eligibleResearched = {
  status: 'researched',
  email: 'new@example.com',
  delivery_suppressed_emails: [],
  outreach_suppression_reason: null,
  outreach_suppressed_at: null,
}
assert.equal(isLeadSuppressed(eligibleResearched), false, 'Case A remains eligible')
assert.equal(leadSuppressionLabel(eligibleResearched), null, 'Case A has no suppression badge')

const duplicateResearched = {
  ...eligibleResearched,
  outreach_suppression_reason: 'email_already_contacted',
  outreach_suppressed_at: '2026-09-13T00:00:00.000Z',
}
assert.equal(isLeadSuppressed(duplicateResearched), true, 'Case B is suppressed')
assert.equal(leadSuppressionLabel(duplicateResearched), 'Duplicate email')

const deliverySuppressed = {
  ...eligibleResearched,
  email: 'Owner@Example.com',
  delivery_suppressed_emails: ['owner@example.com'],
}
assert.equal(isLeadSuppressed(deliverySuppressed), true, 'current-address delivery suppression uses the existing address source of truth')
assert.equal(leadSuppressionLabel(deliverySuppressed), 'Delivery suppressed')

const correctedRecipient = {
  ...duplicateResearched,
  email: 'different@example.com',
  outreach_suppression_reason: null,
  outreach_suppressed_at: null,
}
assert.equal(isLeadSuppressed(correctedRecipient), false, 'Case D naturally returns after migration 053 clears stale suppression')

const table = source('src/components/leads/LeadsTable.tsx')
assert.match(table, /value: SUPPRESSED_LEADS_FILTER, label: 'Suppressed'/)
assert.match(table, /processEligibleLeads\s*=\s*leads\.filter\(l => l\.status === 'researched' && !isLeadSuppressed\(l\)\)/)
assert.match(table, /selectableLeads\.forEach\(l => next\.add\(l\.id\)\)/, 'Select All is scoped to eligible rows')
assert.match(table, /Suppressed . \{suppressionLabel\}/, 'suppressed rows show a readable badge')
assert.match(table, /\[page, filterControlsKey\]/, 'selection is cleared across pagination and filter changes')

const migration = source('supabase/migrations/054_leads_suppressed_filter.sql')
assert.equal(SUPPRESSED_LEADS_FILTER, 'suppressed')
assert.match(migration, /'suppressed' = ANY \(p_statuses\)/, 'Suppressed is a virtual RPC filter, not a lifecycle status')
assert.match(migration, /p_statuses = ARRAY\['researched'\]::TEXT\[][\s\S]*outreach_suppressed_at IS NOT NULL[\s\S]*outreach_suppression_reason IS NOT NULL/, 'Researched excludes persisted suppression')
assert.match(migration, /lower\(pg_catalog\.btrim\(leads\.email\)\)[\s\S]*ANY \(leads\.delivery_suppressed_emails\)/, 'delivery suppression matches the current normalized recipient')
assert.match(migration, /'total', \(SELECT COUNT\(\*\) FROM matched\)/, 'count and page rows share the same matched set')
assert.match(migration, /ORDER BY matched\.created_at DESC, matched\.id ASC[\s\S]*OFFSET[\s\S]*LIMIT/, 'stable pagination and sorting are retained')
assert.doesNotMatch(migration, /UPDATE|INSERT|DELETE FROM/, 'the UI filter RPC remains read-only')

const bulkHelper = source('src/lib/process-researched-lead.ts')
const writer = source('src/lib/write-lead.ts')
assert.match(bulkHelper, /outreach_suppressed_at \|\| lead\.outreach_suppression_reason/, 'Case C keeps the bulk suppression guard')
assert.match(writer, /isDeliverySuppressedForAddress\(lead\.email, lead\.delivery_suppressed_emails\)/, 'Case C keeps the Writer delivery-suppression guard')

const migration053 = source('supabase/migrations/053_remove_suppressed_leads_from_email_ready.sql')
assert.match(migration053, /clear_lead_outreach_suppression_on_email_change[\s\S]*WHEN v_bad IS NULL THEN NULL/, 'Case D keeps migration 053 corrected-email behavior')

console.log('Leads suppression UI checks passed')
