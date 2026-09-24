import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import {
  ONBOARDING_SETTING_KEYS,
  parseOnboardingStatus,
  parseOnboardingStep,
  type OnboardingState,
} from '@/lib/onboarding'

export async function getOnboardingState(workspaceId: string): Promise<OnboardingState> {
  const workspaceClient = createWorkspaceServiceClient(workspaceId)
  const service = createServiceClient()
  const [{ data: workspace, error: workspaceError }, { data: rows, error: settingsError }] = await Promise.all([
    service.from('workspaces').select('name').eq('id', workspaceId).single(),
    workspaceClient.from('workspace_settings').select('key,value').in('key', Object.values(ONBOARDING_SETTING_KEYS)),
  ])

  if (workspaceError) throw new Error(workspaceError.message)
  if (settingsError) throw new Error(settingsError.message)

  const settings = new Map((rows ?? []).map((row) => [row.key, row.value]))
  return {
    status: parseOnboardingStatus(settings.get(ONBOARDING_SETTING_KEYS.status)),
    currentStep: parseOnboardingStep(settings.get(ONBOARDING_SETTING_KEYS.currentStep)),
    completedAt: settings.get(ONBOARDING_SETTING_KEYS.completedAt) ?? null,
    workspaceName: workspace.name,
    website: settings.get(ONBOARDING_SETTING_KEYS.website) ?? '',
    industry: settings.get(ONBOARDING_SETTING_KEYS.industry) ?? '',
    country: settings.get(ONBOARDING_SETTING_KEYS.country) ?? 'AU',
    timezone: settings.get(ONBOARDING_SETTING_KEYS.timezone) ?? 'Australia/Sydney',
    senderName: settings.get(ONBOARDING_SETTING_KEYS.senderName) ?? '',
    brandName: settings.get(ONBOARDING_SETTING_KEYS.brandName) ?? workspace.name,
    companyDescription: settings.get(ONBOARDING_SETTING_KEYS.companyDescription) ?? '',
    primaryGoal: settings.get(ONBOARDING_SETTING_KEYS.primaryGoal) ?? '',
    primaryMarket: settings.get(ONBOARDING_SETTING_KEYS.primaryMarket) ?? 'Sydney',
  }
}

export async function upsertOnboardingSettings(
  workspaceId: string,
  values: Record<string, string>,
): Promise<void> {
  const client = createWorkspaceServiceClient(workspaceId)
  const rows = Object.entries(values).map(([key, value]) => ({
    workspace_id: workspaceId,
    key,
    value,
    description: 'ReachAgent customer onboarding',
    updated_at: new Date().toISOString(),
  }))
  const { error } = await client.from('workspace_settings').upsert(rows, { onConflict: 'workspace_id,key' })
  if (error) throw new Error(error.message)
}
