-- Fences distributed_locks releases to the holder that actually acquired them.
--
-- Problem: acquireLock()/releaseLock() (src/lib/distributed-lock.ts) previously
-- keyed everything off lock_key alone. If a holder ran longer than the lock's
-- TTL while still legitimately in progress (slow Resend API, large batch),
-- a second caller would reclaim the "stale" lock and start working under the
-- same key. When the original (still-alive) holder finished, its unconditional
-- `DELETE ... WHERE lock_key = $1` would delete the *second* holder's row, not
-- its own — silently handing the lock to a third caller while the second
-- holder was still mid-flight. That defeats the mutual-exclusion guarantee
-- this table exists to provide (see migration 028).
--
-- Fix: every acquire mints a random owner_token and release requires it to
-- match. A holder can now only ever delete the row it itself inserted; a
-- reclaimed lock's new token means the original holder's release becomes a
-- no-op instead of a hijack.
ALTER TABLE distributed_locks
  ADD COLUMN IF NOT EXISTS owner_token TEXT;
