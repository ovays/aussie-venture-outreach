import 'server-only'

import { ONBOARDING_SETTING_KEYS } from '@/lib/onboarding'
import { createServiceClient } from '@/lib/supabase/server'
import { workspaceExecutionLabel } from '@/lib/workspace-display'

export interface WorkspaceStatusDisplay {
  label: 'Live' | 'Paused'
  city: string | null
}

export async function getWorkspaceStatusDisplay(workspaceId: string): Promise<WorkspaceStatusDisplay> {
  const db = createServiceClient()
  const [{ data: settings, error: settingsError }, { data: mailbox, error: mailboxError }] = await Promise.all([
    db
      .from('workspace_settings')
      .select('key,value')
      .eq('workspace_id', workspaceId)
      .in('key', [
        ONBOARDING_SETTING_KEYS.systemActive,
        ONBOARDING_SETTING_KEYS.status,
        ONBOARDING_SETTING_KEYS.primaryCity,
      ]),
    db
      .from('mailbox_connections')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'connected')
      .limit(1),
  ])

  if (settingsError || mailboxError) throw new Error((settingsError ?? mailboxError)!.message)

  const values = new Map((settings ?? []).map((row) => [row.key, row.value]))
  const city = values.get(ONBOARDING_SETTING_KEYS.primaryCity)?.trim() || null

  return {
    label: workspaceExecutionLabel({
      systemActive: values.get(ONBOARDING_SETTING_KEYS.systemActive) === 'true',
      mailboxConnected: (mailbox ?? []).length > 0,
      onboardingCompleted: values.get(ONBOARDING_SETTING_KEYS.status) === 'completed',
    }),
    city,
  }
}
