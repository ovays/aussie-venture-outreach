import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { logger } from '@/lib/logger'
import { workspaceIdForServiceClient } from '@/lib/supabase/workspace-service'

// Cross-invocation mutex backed by `distributed_locks`. Callers should pass an
// explicit workspace_id so tenant-local keys never contend across workspaces;
// until every caller is scoped, the transitional seed default still applies
// when workspace_id is omitted.

const DEFAULT_TTL_MS = 15 * 60 * 1000

function requiredWorkspaceId(client: object, explicit?: string): string {
  const workspaceId = explicit ?? workspaceIdForServiceClient(client)
  if (!workspaceId) throw new Error('Distributed locks require workspace context')
  return workspaceId
}

function scopedKey(workspaceId: string, key: string): string {
  return `${workspaceId}:${key}`
}

export async function acquireLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
  workspaceId?: string,
): Promise<string | null> {
  const resolvedWorkspaceId = requiredWorkspaceId(supabase, workspaceId)
  const nowIso = new Date().toISOString()
  const token = randomUUID()
  const lockKey = scopedKey(resolvedWorkspaceId, key)

  const { error } = await supabase.from('distributed_locks').insert({
    lock_key: lockKey,
    workspace_id: resolvedWorkspaceId,
    locked_at: nowIso,
    owner_token: token,
  })
  if (!error) return token

  if (error.code !== '23505') {
    logger.error('distributed-lock', 'Unexpected error acquiring lock', { key, workspaceId, error: error.message })
    return null
  }

  const cutoffIso = new Date(Date.now() - ttlMs).toISOString()
  const { data: reclaimed, error: reclaimErr } = await supabase
    .from('distributed_locks')
    .delete()
    .eq('lock_key', lockKey)
    .lt('locked_at', cutoffIso)
    .select('lock_key')

  if (reclaimErr || !reclaimed?.length) {
    return null
  }

  logger.warn('distributed-lock', 'Reclaimed stale lock (holder likely crashed without releasing)', { key, workspaceId, ttlMs })

  const { error: retryErr } = await supabase.from('distributed_locks').insert({
    lock_key: lockKey,
    workspace_id: resolvedWorkspaceId,
    locked_at: nowIso,
    owner_token: token,
  })
  if (retryErr) {
    logger.error('distributed-lock', 'Failed to acquire lock after reclaiming stale row', { key, workspaceId, error: retryErr.message })
    return null
  }
  return token
}

export async function releaseLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  key: string,
  token: string,
  workspaceId?: string,
): Promise<void> {
  const resolvedWorkspaceId = requiredWorkspaceId(supabase, workspaceId)
  const lockKey = scopedKey(resolvedWorkspaceId, key)
  const { error } = await supabase.from('distributed_locks').delete().eq('lock_key', lockKey).eq('owner_token', token)
  if (error) {
    logger.error('distributed-lock', 'Failed to release lock — it will self-heal via TTL reclaim', { key, workspaceId, error: error.message })
  }
}
