import { z } from 'zod'
import { INITIAL_EMAIL_MODES } from '@/lib/settingsDefaults'

export const leadsBulkRequestSchema = z.object({
  action: z.enum(['send_initial_emails', 'delete', 'research_leads']),
  lead_ids: z.array(z.string().uuid()).min(1).max(200),
  initial_email_mode: z.enum(INITIAL_EMAIL_MODES).optional(),
})
