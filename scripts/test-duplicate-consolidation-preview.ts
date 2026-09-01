import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildDuplicateConsolidationPreview, type ConsolidationSnapshot } from '../src/lib/duplicate-consolidation'

const KEEP = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const EMAIL = 'duplicate@example.com'

function snapshot(overrides: Partial<ConsolidationSnapshot> = {}): ConsolidationSnapshot {
  return {
    groupLeads: [
      {
        id: KEEP, business_name: 'Same Business', normalized_email: EMAIL, status: 'contacted', updated_at: '2026-09-01T00:00:00Z',
        website: 'https://same.test/tours', phone: '0400 000 000', address: null, suburb: 'Sydney', instagram_handle: null,
        facebook_url: null, notes: 'Keep note', category_name: 'Tours', city: 'Sydney', deal_value: null, deal_type: null,
      },
      {
        id: OTHER, business_name: 'Same Business', normalized_email: EMAIL, status: 'replied', updated_at: '2026-09-01T00:00:00Z',
        website: 'https://same.test/tours', phone: '0400 000 000', address: '1 Test St', suburb: 'Sydney', instagram_handle: '@same',
        facebook_url: null, notes: 'Different note', category_name: 'Tours', city: 'Sydney', deal_value: null, deal_type: null,
      },
    ],
    emails: [
      { id: 'email-1', lead_id: KEEP, type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z', replied_at: null, created_at: '2026-07-01T00:00:00Z', resend_id: 'provider-1', message_id: '<one@test>' },
      { id: 'email-2', lead_id: OTHER, type: 'follow_up_1', status: 'sent', sent_at: '2026-07-08T00:00:00Z', replied_at: '2026-07-09T00:00:00Z', created_at: '2026-07-08T00:00:00Z', resend_id: 'provider-2', message_id: '<two@test>' },
    ],
    deals: [],
    followups: [
      { id: 'fu-history', lead_id: OTHER, follow_up_number: 1, scheduled_at: '2026-07-08T00:00:00Z', sent_at: '2026-07-08T00:00:00Z', email_id: 'email-2', status: 'sent', created_at: '2026-07-01T00:00:00Z' },
      { id: 'fu-future', lead_id: OTHER, follow_up_number: 2, scheduled_at: '2026-09-10T00:00:00Z', sent_at: null, email_id: null, status: 'scheduled', created_at: '2026-09-01T00:00:00Z' },
    ],
    dmQueue: [],
    activity: [{ id: 'activity-1', lead_id: OTHER, event_type: 'reply_received', created_at: '2026-07-09T00:00:00Z' }],
    dataQualityFlags: [
      { id: 'flag-1', lead_id: KEEP, issue_type: 'duplicate_lead', status: 'open' },
      { id: 'flag-2', lead_id: OTHER, issue_type: 'duplicate_lead', status: 'open' },
    ],
    ownershipRows: [{ normalized_email: EMAIL, owner_lead_id: KEEP, state: 'active', claimed_at: '2026-07-01T00:00:00Z', last_activity_at: '2026-07-09T00:00:00Z' }],
    versionToken: 'version-a', generatedAt: '2026-09-01T01:00:00Z',
    ...overrides,
  }
}

function preview(keep = KEEP, state = snapshot()) {
  const redundant = keep === KEEP ? [OTHER] : [KEEP]
  return buildDuplicateConsolidationPreview({ normalized_email: EMAIL, keep_lead_id: keep, redundant_lead_ids: redundant }, state)
}

const ownerKept = preview()
assert.equal(ownerKept.ownership_impact.transfer_required, false, 'owner lead can be explicitly kept')
assert.equal(ownerKept.ownership_impact.resulting_owner_lead_id, KEEP)
assert.equal(ownerKept.emails.would_move.length, 1, 'every redundant email is listed for relinking')
assert.equal(ownerKept.emails.would_move[0].message_id, '<two@test>', 'thread identifier is preserved in plan')
assert.equal(ownerKept.emails.replied_email_count, 1, 'reply timestamp remains represented')
assert.equal(ownerKept.statuses.resulting_status, 'replied', 'stronger/reply-backed lifecycle state wins')
assert.equal(ownerKept.followups.future_redundant_to_cancel.length, 1, 'future redundant follow-up is cancelled in plan')
assert.equal(ownerKept.followups.historical_preserved.length, 1, 'historical follow-up is retained')
assert.equal(ownerKept.linked_history.activity_rows_preserved_in_place, 1)
assert.equal(ownerKept.archival_plan.includes('do not hard-delete'), true)
assert.equal(ownerKept.confirmation_available, false, 'preview rollout exposes no mutation')

const notesConflict = ownerKept.fields.find((field) => field.field === 'notes')
assert.equal(notesConflict?.action, 'conflict')
assert.equal(notesConflict?.proposed_value, 'Keep note', 'populated keep value is never overwritten')
const addressFill = ownerKept.fields.find((field) => field.field === 'address')
assert.equal(addressFill?.action, 'possible_fill')
assert.equal(addressFill?.proposed_value, '1 Test St', 'missing keep value is offered as a possible fill')

const ownerTransfer = preview(OTHER)
assert.equal(ownerTransfer.ownership_impact.transfer_required, true)
assert.equal(ownerTransfer.warnings.some((warning) => warning.message === 'Recipient ownership must be transferred before consolidation.'), true)

const withDeal = snapshot({
  deals: [{ id: 'deal-1', lead_id: OTHER, deal_value: 2500, deal_type: 'remote_sponsored', closed_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', notes: 'Signed' }],
})
const dealPreview = preview(KEEP, withDeal)
assert.equal(dealPreview.deals.would_move.length, 1, 'deal is retained and listed for relinking')
assert.equal(dealPreview.statuses.resulting_status, 'closed', 'a real deal promotes result to closed')

const collision = snapshot({
  emails: [
    snapshot().emails[0],
    { ...snapshot().emails[1], type: 'initial_pitch' },
  ],
})
assert.equal(preview(KEEP, collision).blocking_reasons.some((reason) => reason.code === 'email_uniqueness_conflict'), true)

const ambiguousOwnership = snapshot({ ownershipRows: [] })
assert.equal(preview(KEEP, ambiguousOwnership).blocking_reasons.some((reason) => reason.code === 'ambiguous_ownership'), true)

const wrongClassification = snapshot({
  groupLeads: snapshot().groupLeads.map((lead, index) => ({ ...lead, business_name: index ? 'Different Business' : lead.business_name })),
})
assert.equal(preview(KEEP, wrongClassification).blocking_reasons.some((reason) => reason.code === 'not_duplicate_lead'), true)

const changedGroup = snapshot({ groupLeads: snapshot().groupLeads.slice(0, 1) })
assert.equal(preview(KEEP, changedGroup).blocking_reasons.some((reason) => reason.code === 'incomplete_or_mixed_group'), true)

const routeSource = readFileSync('src/app/api/data-quality/consolidate/preview/route.ts', 'utf8')
const serviceSource = readFileSync('src/lib/duplicate-consolidation-preview.ts', 'utf8')
for (const forbidden of ['.insert(', '.delete(', '.upsert(', '.rpc(']) {
  assert.equal(routeSource.includes(forbidden), false, `preview route must not contain ${forbidden}`)
  assert.equal(serviceSource.includes(forbidden), false, `preview service must not contain ${forbidden}`)
}
assert.equal((serviceSource.match(/\.update\(/g) ?? []).length, 1, 'only createHash().update is allowed in preview service')
assert.match(serviceSource, /createHash\('sha256'\)\.update\(/)

console.log('Duplicate consolidation preview safety tests passed')
