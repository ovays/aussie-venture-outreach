import { z } from 'zod'
import { classifyDuplicateGroup, normalizeDataQualityValue } from '@/lib/data-quality'

export const duplicateConsolidationPreviewSchema = z.object({
  normalized_email: z.string().trim().toLowerCase().email(),
  keep_lead_id: z.string().uuid(),
  redundant_lead_ids: z.array(z.string().uuid()).min(1).max(20),
}).superRefine((value, context) => {
  if (value.redundant_lead_ids.includes(value.keep_lead_id)) {
    context.addIssue({ code: 'custom', message: 'The keep lead cannot also be redundant.', path: ['redundant_lead_ids'] })
  }
  if (new Set(value.redundant_lead_ids).size !== value.redundant_lead_ids.length) {
    context.addIssue({ code: 'custom', message: 'Redundant lead IDs must be unique.', path: ['redundant_lead_ids'] })
  }
})

export type DuplicateConsolidationPreviewInput = z.infer<typeof duplicateConsolidationPreviewSchema>

export interface ConsolidationLeadSnapshot {
  id: string
  business_name: string | null
  normalized_email: string | null
  status: string
  updated_at: string | null
  website: string | null
  phone: string | null
  address: string | null
  suburb: string | null
  instagram_handle: string | null
  facebook_url: string | null
  notes: string | null
  category_name: string | null
  city: string | null
  deal_value: number | null
  deal_type: string | null
}

export interface ConsolidationEmailSnapshot {
  id: string
  lead_id: string
  type: string
  status: string
  sent_at: string | null
  replied_at: string | null
  created_at: string | null
  resend_id: string | null
  message_id: string | null
}

export interface ConsolidationDealSnapshot {
  id: string
  lead_id: string
  deal_value: number | null
  deal_type: string | null
  closed_at: string | null
  created_at: string | null
  notes: string | null
}

export interface ConsolidationFollowupSnapshot {
  id: string
  lead_id: string
  follow_up_number: number
  scheduled_at: string
  sent_at: string | null
  email_id: string | null
  status: string
  created_at: string | null
}

export interface ConsolidationLinkedRowSnapshot {
  id: string
  lead_id: string
  status?: string | null
  event_type?: string | null
  issue_type?: string | null
  created_at?: string | null
}

export interface ConsolidationOwnershipSnapshot {
  normalized_email: string
  owner_lead_id: string | null
  state: string
  claimed_at: string | null
  last_activity_at: string | null
}

export interface ConsolidationSnapshot {
  groupLeads: ConsolidationLeadSnapshot[]
  emails: ConsolidationEmailSnapshot[]
  deals: ConsolidationDealSnapshot[]
  followups: ConsolidationFollowupSnapshot[]
  dmQueue: ConsolidationLinkedRowSnapshot[]
  activity: ConsolidationLinkedRowSnapshot[]
  dataQualityFlags: ConsolidationLinkedRowSnapshot[]
  ownershipRows: ConsolidationOwnershipSnapshot[]
  versionToken: string
  generatedAt: string
}

export interface ConsolidationReason {
  code: string
  message: string
  lead_ids?: string[]
}

export interface ConsolidationFieldPlan {
  field: string
  keep_value: string | number | null
  redundant_values: Array<{ lead_id: string; value: string | number }>
  action: 'keep' | 'possible_fill' | 'conflict' | 'no_value'
  proposed_value: string | number | null
}

const STATUS_RANK: Record<string, number> = {
  dead: 0,
  new: 10,
  researched: 20,
  email_ready: 30,
  contacted: 40,
  replied: 50,
  interested: 60,
  negotiating: 70,
  closed_manual: 80,
  closed: 85,
  closed_won: 90,
}

const IDENTITY_FIELDS = [
  'website', 'phone', 'address', 'suburb', 'instagram_handle', 'facebook_url',
  'notes', 'category_name', 'city',
] as const

function present(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' ? normalizeDataQualityValue(value) : null
}

export function resolveConservativeStatus(
  leads: ConsolidationLeadSnapshot[],
  emails: ConsolidationEmailSnapshot[],
  deals: ConsolidationDealSnapshot[],
): string {
  const candidates = leads.map((lead) => lead.status)
  if (emails.some((email) => email.replied_at)) candidates.push('replied')
  if (deals.length > 0) candidates.push('closed')
  return candidates.sort((a, b) => (STATUS_RANK[b] ?? -1) - (STATUS_RANK[a] ?? -1))[0] ?? 'new'
}

function fieldPlans(keep: ConsolidationLeadSnapshot | undefined, redundant: ConsolidationLeadSnapshot[]): ConsolidationFieldPlan[] {
  return IDENTITY_FIELDS.map((field) => {
    const keepValue = keep ? present(keep[field]) : null
    const redundantValues = redundant
      .map((lead) => ({ lead_id: lead.id, value: present(lead[field]) }))
      .filter((entry): entry is { lead_id: string; value: string | number } => entry.value !== null)
    const distinct = [...new Set(redundantValues.map((entry) => String(entry.value).trim().toLowerCase()))]
    if (keepValue !== null) {
      const conflicts = redundantValues.filter((entry) => String(entry.value).trim().toLowerCase() !== String(keepValue).trim().toLowerCase())
      return { field, keep_value: keepValue, redundant_values: redundantValues, action: conflicts.length ? 'conflict' : 'keep', proposed_value: keepValue }
    }
    if (distinct.length === 1 && redundantValues[0]) {
      return { field, keep_value: null, redundant_values: redundantValues, action: 'possible_fill', proposed_value: redundantValues[0].value }
    }
    return {
      field, keep_value: null, redundant_values: redundantValues,
      action: distinct.length > 1 ? 'conflict' : 'no_value', proposed_value: null,
    }
  })
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index])
}

export function buildDuplicateConsolidationPreview(
  input: DuplicateConsolidationPreviewInput,
  snapshot: ConsolidationSnapshot,
) {
  const selectedIds = [input.keep_lead_id, ...input.redundant_lead_ids]
  const keep = snapshot.groupLeads.find((lead) => lead.id === input.keep_lead_id)
  const redundant = input.redundant_lead_ids
    .map((id) => snapshot.groupLeads.find((lead) => lead.id === id))
    .filter((lead): lead is ConsolidationLeadSnapshot => !!lead)
  const blockers: ConsolidationReason[] = []
  const warnings: ConsolidationReason[] = []

  if (!keep) blockers.push({ code: 'keep_lead_missing', message: 'The selected keep lead no longer exists in this group.' })
  const missingRedundant = input.redundant_lead_ids.filter((id) => !snapshot.groupLeads.some((lead) => lead.id === id))
  if (missingRedundant.length) blockers.push({ code: 'redundant_lead_missing', message: 'One or more redundant leads no longer exist in this group.', lead_ids: missingRedundant })
  if (!sameIds(selectedIds, snapshot.groupLeads.map((lead) => lead.id))) {
    blockers.push({ code: 'incomplete_or_mixed_group', message: 'The selected leads are not exactly the current duplicate group.', lead_ids: selectedIds })
  }
  const mismatchedEmails = snapshot.groupLeads.filter((lead) => lead.normalized_email !== input.normalized_email).map((lead) => lead.id)
  if (mismatchedEmails.length) blockers.push({ code: 'normalized_email_mismatch', message: 'Every selected lead must have the same current normalized email.', lead_ids: mismatchedEmails })

  const classification = classifyDuplicateGroup(snapshot.groupLeads)
  const openDuplicateFlagIds = new Set(snapshot.dataQualityFlags
    .filter((flag) => flag.issue_type === 'duplicate_lead' && flag.status === 'open')
    .map((flag) => flag.lead_id))
  if (classification.issueType !== 'duplicate_lead' || selectedIds.some((id) => !openDuplicateFlagIds.has(id))) {
    blockers.push({ code: 'not_duplicate_lead', message: 'The current group is not an open duplicate_lead classification.' })
  }

  const activeOwners = snapshot.ownershipRows.filter((row) => row.state === 'active')
  const owner = activeOwners[0] ?? null
  if (activeOwners.length !== 1 || !owner?.owner_lead_id || !selectedIds.includes(owner.owner_lead_id)) {
    blockers.push({ code: 'ambiguous_ownership', message: 'Recipient ownership is missing, non-unique, or belongs to a lead outside this group.' })
  }
  const ownershipTransferRequired = Boolean(owner?.owner_lead_id && owner.owner_lead_id !== input.keep_lead_id)
  if (ownershipTransferRequired) warnings.push({
    code: 'ownership_transfer_required',
    message: 'Recipient ownership must be transferred before consolidation.',
    lead_ids: [owner!.owner_lead_id!, input.keep_lead_id],
  })

  const selectedEmails = snapshot.emails.filter((email) => selectedIds.includes(email.lead_id))
  const deliveredCollisions = new Map<string, ConsolidationEmailSnapshot[]>()
  for (const email of selectedEmails.filter((row) => ['sent', 'email_sync_failed'].includes(row.status))) {
    deliveredCollisions.set(email.type, [...(deliveredCollisions.get(email.type) ?? []), email])
  }
  for (const [type, rows] of deliveredCollisions) {
    if (rows.length > 1) blockers.push({
      code: 'email_uniqueness_conflict',
      message: `${rows.length} delivered ${type} emails cannot all be relinked under the current one-delivered-email-per-lead/type constraint.`,
      lead_ids: [...new Set(rows.map((row) => row.lead_id))],
    })
  }
  const pendingInitial = selectedEmails.filter((email) => email.type === 'initial_pitch' && email.status === 'pending_send')
  if (pendingInitial.length > 1) blockers.push({
    code: 'pending_email_conflict', message: 'Multiple pending initial emails would violate the current uniqueness constraint.',
    lead_ids: [...new Set(pendingInitial.map((row) => row.lead_id))],
  })
  const redundantPendingEmails = selectedEmails.filter((email) => input.redundant_lead_ids.includes(email.lead_id) && email.status === 'pending_send')
  if (redundantPendingEmails.length) blockers.push({
    code: 'pending_email_requires_manual_resolution',
    message: 'A pending email on a redundant lead could send after relinking; resolve the draft manually before consolidation.',
    lead_ids: [...new Set(redundantPendingEmails.map((row) => row.lead_id))],
  })

  const selectedDeals = snapshot.deals.filter((deal) => selectedIds.includes(deal.lead_id))
  const dealShapes = new Set(selectedDeals.map((deal) => `${deal.deal_type ?? ''}:${deal.deal_value ?? ''}`))
  if (dealShapes.size > 1) blockers.push({
    code: 'ambiguous_deal_summary',
    message: 'Multiple different deal summaries cannot be represented safely in the keep lead scalar deal fields without an admin decision.',
    lead_ids: [...new Set(selectedDeals.map((deal) => deal.lead_id))],
  })

  const fields = fieldPlans(keep, redundant)
  for (const field of fields.filter((entry) => entry.action === 'conflict')) {
    warnings.push({ code: 'field_conflict', message: `${field.field} has populated conflicting values; the keep value would not be overwritten.` })
  }

  const selectedFollowups = snapshot.followups.filter((row) => selectedIds.includes(row.lead_id))
  const futureRedundantFollowups = selectedFollowups.filter((row) => input.redundant_lead_ids.includes(row.lead_id) && row.status === 'scheduled' && !row.sent_at)
  const historicalFollowups = selectedFollowups.filter((row) => !futureRedundantFollowups.includes(row))
  const redundantDm = snapshot.dmQueue.filter((row) => input.redundant_lead_ids.includes(row.lead_id))
  const pendingDm = redundantDm.filter((row) => row.status === 'pending')
  if (pendingDm.length) warnings.push({ code: 'pending_dm_requires_skip', message: `${pendingDm.length} pending DM item(s) on redundant leads would need to be skipped atomically.` })

  const unknownStatuses = [...new Set(snapshot.groupLeads.map((lead) => lead.status).filter((status) => STATUS_RANK[status] === undefined))]
  if (unknownStatuses.length) blockers.push({ code: 'unknown_lifecycle_status', message: `Unknown lifecycle status: ${unknownStatuses.join(', ')}.` })
  const resultingStatus = resolveConservativeStatus(snapshot.groupLeads, selectedEmails, selectedDeals)

  return {
    preview_only: true as const,
    normalized_email: input.normalized_email,
    keep_lead_id: input.keep_lead_id,
    redundant_lead_ids: input.redundant_lead_ids,
    generated_at: snapshot.generatedAt,
    version_token: snapshot.versionToken,
    safe: blockers.length === 0,
    blocking_reasons: blockers,
    warnings,
    ownership_impact: {
      current_owner_lead_id: owner?.owner_lead_id ?? null,
      resulting_owner_lead_id: input.keep_lead_id,
      transfer_required: ownershipTransferRequired,
      operation: ownershipTransferRequired ? 'atomic_transfer_required' : 'unchanged',
    },
    emails: {
      total_in_group: selectedEmails.length,
      would_move: selectedEmails.filter((email) => input.redundant_lead_ids.includes(email.lead_id)),
      replied_email_count: selectedEmails.filter((email) => !!email.replied_at).length,
      preservation: 'Relink only; preserve content, status, provider/thread IDs, reply/sent dates, metadata, and timestamps.',
    },
    deals: {
      total_in_group: selectedDeals.length,
      would_move: selectedDeals.filter((deal) => input.redundant_lead_ids.includes(deal.lead_id)),
      preservation: 'Relink every deal; never discard a deal.',
    },
    fields,
    statuses: {
      involved: snapshot.groupLeads.map((lead) => ({ lead_id: lead.id, status: lead.status })),
      resulting_status: resultingStatus,
      rule: 'Conservative precedence with verified replies and deals promoted; never downgrade the strongest state.',
    },
    followups: {
      historical_preserved: historicalFollowups,
      future_redundant_to_cancel: futureRedundantFollowups,
      keep_lead_scheduled_retained: selectedFollowups.filter((row) => row.lead_id === input.keep_lead_id && row.status === 'scheduled' && !row.sent_at),
    },
    linked_history: {
      activity_rows_preserved_in_place: snapshot.activity.filter((row) => selectedIds.includes(row.lead_id)).length,
      dm_rows_preserved_in_place: redundantDm.length,
      pending_dm_to_skip: pendingDm.length,
    },
    data_quality_flags: {
      affected: snapshot.dataQualityFlags.filter((flag) => selectedIds.includes(flag.lead_id)),
      plan: 'Resolve duplicate flags during confirmation; retain rows as Data Quality history.',
    },
    archival_plan: 'Soft-archive redundant leads with consolidated_into_lead_id; do not hard-delete them.',
    confirmation_available: false,
  }
}

export type DuplicateConsolidationPreview = ReturnType<typeof buildDuplicateConsolidationPreview>
