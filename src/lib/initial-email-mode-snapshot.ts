import type { SupabaseClient } from '@supabase/supabase-js'
import { isInitialEmailMode, type InitialEmailMode } from '@/lib/settingsDefaults'

export const INITIAL_EMAIL_MODE_SNAPSHOT_EVENT = 'initial_email_mode_snapshot'

export function initialEmailPolicyForCsvImport(mode: InitialEmailMode) {
  return mode === 'template'
    ? { mode, action: 'generate_now' as const }
    : { mode, action: 'defer_to_writer' as const, snapshotSource: 'csv_import' as const }
}

export async function saveInitialEmailModeSnapshot(
  supabase: SupabaseClient,
  leadId: string,
  mode: InitialEmailMode,
  source: 'csv_import',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('activity_log').insert({
    event_type: INITIAL_EMAIL_MODE_SNAPSHOT_EVENT,
    lead_id: leadId,
    description: `Initial Email Mode captured for ${source}`,
    metadata: { initial_email_mode: mode, source },
  })

  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function loadInitialEmailModeSnapshots(
  supabase: SupabaseClient,
  leadIds: string[],
): Promise<Map<string, InitialEmailMode>> {
  if (leadIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from('activity_log')
    .select('lead_id, metadata, created_at')
    .eq('event_type', INITIAL_EMAIL_MODE_SNAPSHOT_EVENT)
    .in('lead_id', leadIds)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Could not load Initial Email Mode snapshots: ${error.message}`)

  const snapshots = new Map<string, InitialEmailMode>()
  for (const row of data ?? []) {
    if (!row.lead_id || snapshots.has(row.lead_id)) continue
    const metadata = row.metadata as { initial_email_mode?: unknown } | null
    if (typeof metadata?.initial_email_mode === 'string' && isInitialEmailMode(metadata.initial_email_mode)) {
      snapshots.set(row.lead_id, metadata.initial_email_mode)
    }
  }
  return snapshots
}
