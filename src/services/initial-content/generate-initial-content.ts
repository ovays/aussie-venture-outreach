import type { SupabaseClient } from '@supabase/supabase-js'
import { routeInitialEmail, type InitialEmailLead, type InitialEmailResult } from '@/lib/initial-email-router'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import type { PersonalizedInitialWriter } from '@/ai/writer'

export interface GenerateInitialContentInput {
  client: SupabaseClient
  leadId: string
  mode: InitialEmailMode
  operation?: 'normal' | 'regenerate' | 'content_only'
  pendingEmailId?: string
  writer?: PersonalizedInitialWriter
}

export type GenerateInitialContentResult = InitialEmailResult

const INITIAL_CONTENT_FIELDS =
  'id,business_name,category_id,category_name,suburb,city,website,description,services,content_type'

/**
 * Exact-lead initial-content entry point. It alone selects deterministic
 * template rendering versus the personalized Writer capability.
 */
export async function generateInitialContent(
  input: GenerateInitialContentInput,
): Promise<GenerateInitialContentResult> {
  const selected = await input.client.from('leads')
    .select(INITIAL_CONTENT_FIELDS)
    .eq('id', input.leadId)
    .maybeSingle()
  if (selected.error || !selected.data) {
    return {
      ok: false,
      mode: input.mode,
      error: {
        leadId: input.leadId,
        businessName: '',
        categoryId: null,
        categoryName: null,
        code: selected.error ? 'lead_lookup_failed' : 'lead_not_found',
        reason: selected.error?.message ?? 'Lead was not found.',
      },
    }
  }

  return routeInitialEmail(input.client, selected.data as InitialEmailLead, input.mode, {
    operation: input.operation,
    pendingEmailId: input.pendingEmailId,
    aiWriter: input.writer,
  })
}
