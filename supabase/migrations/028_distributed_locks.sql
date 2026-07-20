-- Distributed mutex table for cross-invocation atomicity.
--
-- Problem: several code paths do a "check current state, then act" sequence
-- against Postgres through PostgREST (supabase-js), which has no way to hold
-- a transaction open across multiple round trips. If the same operation runs
-- twice concurrently (an overlapping worker, a client retry, a stuck old
-- process), both invocations can pass their check before either finishes
-- acting, defeating the check.
--
-- Fix: a tiny lock table used as a mutex. Acquiring a lock is a single
-- INSERT — atomic by construction because `lock_key` is a PRIMARY KEY, so
-- Postgres itself guarantees only one concurrent INSERT for the same key can
-- succeed; the loser gets a 23505 unique_violation and treats that as
-- "someone else holds this lock right now". Releasing is a DELETE by key.
--
-- `locked_at` lets a crashed holder's lock be reclaimed after `ttlMs` (see
-- src/lib/distributed-lock.ts) instead of blocking that operation forever.
--
-- Used by:
--   - agents/sender.ts (key: 'sender_agent') — serializes concurrent/retried
--     runs of the daily-quota sender so the count-then-send quota check
--     stays correct even outside Trigger.dev's own queue concurrency limit.
--   - src/app/api/leads/[id]/resend/route.ts (key: `resend:<lead_id>`) —
--     serializes concurrent manual resend requests for the same lead so two
--     in-flight requests can never both call the Resend API for one lead.
CREATE TABLE IF NOT EXISTS distributed_locks (
  lock_key   TEXT PRIMARY KEY,
  locked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
