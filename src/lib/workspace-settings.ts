import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import type { SettingKey } from '@/lib/settingsDefaults'

/**
 * Truly platform-global keys remain in `public.settings`. Everything else is
 * tenant-owned and lives in `public.workspace_settings`.
 */
export const PLATFORM_SETTING_KEYS = new Set<SettingKey>([
  'system_active',
  'primary_search_api',
  'daily_outscraper_limit',
  'google_maps_cost_per_request',
  'google_maps_monthly_limit',
  'google_maps_spend_reset_month',
  'google_maps_spend_this_month',
])

export function isPlatformSettingKey(key: string): key is SettingKey {
  return PLATFORM_SETTING_KEYS.has(key as SettingKey)
}

export async function getPlatformSetting(key: SettingKey): Promise<string | null> {
  const service = createServiceClient()
  const { data, error } = await service.from('settings').select('value').eq('key', key).maybeSingle()
  if (error) throw new Error(error.message)
  return data?.value ?? null
}

export async function getPlatformSettings(keys: SettingKey[]): Promise<Map<string, string>> {
  const service = createServiceClient()
  const { data, error } = await service.from('settings').select('key,value').in('key', keys)
  if (error) throw new Error(error.message)
  const map = new Map<string, string>()
  for (const row of data ?? []) map.set(row.key, row.value)
  return map
}

export async function upsertPlatformSetting(key: SettingKey, value: string, description?: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('settings')
    .upsert({ key, value, description, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw new Error(error.message)
}

export async function getWorkspaceSetting(workspaceId: string, key: SettingKey): Promise<string | null> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('workspace_settings')
    .select('value')
    .eq('workspace_id', workspaceId)
    .eq('key', key)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.value ?? null
}

export async function getWorkspaceSettings(workspaceId: string, keys: SettingKey[]): Promise<Map<string, string>> {
  const service = createServiceClient()
  const { data, error } = await service
    .from('workspace_settings')
    .select('key,value')
    .eq('workspace_id', workspaceId)
    .in('key', keys)
  if (error) throw new Error(error.message)
  const map = new Map<string, string>()
  for (const row of data ?? []) map.set(row.key, row.value)
  return map
}

export async function upsertWorkspaceSetting(workspaceId: string, key: SettingKey, value: string, description?: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('workspace_settings')
    .upsert(
      { workspace_id: workspaceId, key, value, description, updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id,key' }
    )
  if (error) throw new Error(error.message)
}
