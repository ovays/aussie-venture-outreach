import { z } from 'zod'
import { DATA_QUALITY_ISSUE_TYPES } from '@/lib/data-quality'

const issueType = z.enum(DATA_QUALITY_ISSUE_TYPES)
const leadIds = z.array(z.string().uuid()).min(1).max(100).transform((ids) => [...new Set(ids)])

export const dataQualityActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve'), issue_type: issueType, normalized_email: z.string().trim().min(1).nullable().optional(),
    lead_ids: leadIds.optional(), reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('reopen'), issue_type: issueType, normalized_email: z.string().trim().min(1).nullable().optional(),
    lead_ids: leadIds.optional(),
  }),
  z.object({ action: z.literal('remove_email'), lead_ids: leadIds }),
  z.object({ action: z.literal('delete_lead'), lead_id: z.string().uuid(), confirm_protected: z.boolean().optional() }),
])

export function friendlyDataQualityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/owns the active recipient|outreach lifecycle/i.test(message)) return 'This lead owns the active recipient outreach lifecycle. Resolve or transfer ownership before continuing.'
  if (/protected by lifecycle or history/i.test(message)) return 'This email cannot be removed because the lead has protected lifecycle data or history.'
  if (/no matching flags/i.test(message)) return 'This issue has already changed. Refresh the report and try again.'
  if (/selected leads no longer exist/i.test(message)) return 'One or more selected leads no longer exist. Refresh the report.'
  if (/open invalid|placeholder|technical/i.test(message)) return 'Only open invalid, placeholder, or technical email issues can use Remove Email.'
  return 'The Data Quality action could not be completed. Please refresh and try again.'
}

