import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// Cross-invocation mutex backed by `distributed_locks` (migration 028).
//
// Acquiring is a single INSERT into a table keyed on PRIMARY KEY(lock_key) —
// Postgres itself guarantees only one concurrent INSERT for the same key can
// succeed, so this is atomic even across separate processes/connections
// (unlike an in-memory lock, which only protects a single Node process).
//
// `ttlMs` bounds how long a lock can be held before a later caller is allowed
// to treat it as abandoned (crashed process, uncaught exception before
// release) and reclaim it. Pick ttlMs comfortably above the slowest realistic
// run of the protected operation.
const DEFAULT_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Attempts to acquire the named lock. Returns true if acquired (caller must
 * releaseLock() when done, including on error paths), false if another
 * holder currently has it.
 */
export async function acquireLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  key: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<boolean> {
  const nowIso = new Date().toISOString()

  const { error } = await supabase.from('distributed_locks').insert({ lock_key: key, locked_at: nowIso })
  if (!error) return true

  if (error.code !== '23505') {
    // Unexpected DB error — fail closed (don't let the caller proceed unprotected).
    logger.error('distributed-lock', 'Unexpected error acquiring lock', { key, error: error.message })
    return false
  }

  // Another holder has the row. Only reclaim it if it's older than ttlMs —
  // otherwise a live holder is genuinely still working and this is a real
  // conflict, not a crash.
  const cutoffIso = new Date(Date.now() - ttlMs).toISOString()
  const { data: reclaimed, error: reclaimErr } = await supabase
    .from('distributed_locks')
    .delete()
    .eq('lock_key', key)
    .lt('locked_at', cutoffIso)
    .select('lock_key')

  if (reclaimErr || !reclaimed?.length) {
    // Either the delete matched nothing (lock is live, not stale) or another
    // caller's reclaim attempt won the race and already deleted+reclaimed it —
    // either way this caller does not hold the lock.
    return false
  }

  logger.warn('distributed-lock', 'Reclaimed stale lock (holder likely crashed without releasing)', { key, ttlMs })

  const { error: retryErr } = await supabase.from('distributed_locks').insert({ lock_key: key, locked_at: nowIso })
  if (retryErr) {
    logger.error('distributed-lock', 'Failed to acquire lock after reclaiming stale row', { key, error: retryErr.message })
    return false
  }
  return true
}

/** Releases the named lock. Safe to call even if the lock was never held. */
export async function releaseLock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  key: string
): Promise<void> {
  const { error } = await supabase.from('distributed_locks').delete().eq('lock_key', key)
  if (error) {
    logger.error('distributed-lock', 'Failed to release lock — it will self-heal via TTL reclaim', { key, error: error.message })
  }
}
