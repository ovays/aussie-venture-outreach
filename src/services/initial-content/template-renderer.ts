import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generateInitialEmailFromTemplate,
  type InitialEmailTemplateLead,
  type InitialEmailTemplateResult,
} from '@/lib/initial-email-template'

/** Deterministic template boundary. This module must never import an AI module. */
export async function renderInitialTemplate(
  client: SupabaseClient,
  lead: InitialEmailTemplateLead,
): Promise<InitialEmailTemplateResult> {
  return generateInitialEmailFromTemplate(client, lead)
}
