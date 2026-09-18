# ReachAgent V2 performance and reliability

> Hosted compatibility note (2026-09-16): migration `00000000000001` now wraps
> its existing private-function replacement in temporary migration-issued
> membership that is revoked at completion. No function body, index, behavior,
> or product/schema intent changed. The current SHA-256 is
> `75DA9844FB2BAAFC3CF1E46AE8E85E792F256CCD22909FB759D5090DF95D25D1`.

Completed: 15 September 2026 (Australia/Sydney)

Scope: isolated ReachAgent V2 application and `supabase-v2` only. No production
application, database, data, mailbox, Trigger.dev job, Finder schedule, email,
or deployment was read or changed by this work.

## Outcome

Prompt 8's architectural limits are met. Page payloads are bounded, broad agent
reads have deterministic limits, Finder uses set-based lookups plus an atomic
insert guard, the default Email Report does not scan a year, Data Quality no
longer rebuilds facts for the complete lead history, and outbound retries reuse
a durable provider identity.

Measured BEFORE evidence is retained in
`docs/reachagent-v2-performance-baseline.md`. Measurements below are local
observations, not latency guarantees.

| Path | Before | After |
|---|---|---|
| Leads, 50-row page | 1 call; 50/2,001; 24.4 ms; 22,253 B; helper ACL failure on the RPC | 1 call; 50/2,004; 19.7 ms; 22,209 B; RPC works and returns only list columns |
| Lifecycle, 50-row page | 1 call; 50/1,500; 43.3 ms; 14,662 B; wide candidate rows and all emails entered aggregation | 1 call; 50/1,500; 32.1 ms; 14,662 B; narrow candidates and only relevant sent sequence emails enter aggregation |
| Finder, 25 candidates | 1 broad preload returning only the first 1,000 rows, then 25 DB calls; 245.9 ms for N+1 lookups | no preload; 1 batch RPC; 25 results; 23.9 ms; atomic insert recheck |
| Researcher / Writer / Reactivation discovery | unbounded eligible-row reads | deterministic limits of 100 / 100 / 100 rows per run |

## Query changes

### Leads

`get_leads_search_page` remains one SQL-side page/count operation. Status,
suppressed status, city, category, escaped literal search, sort, and paging stay
inside PostgreSQL. It now projects only the columns rendered by the list and
the nested search helper is executable by the intended API roles. Exact counts
may still inspect all matching index entries, but row data remains O(page size).

### Lifecycle

Exact global stage counts and sorting by derived lifecycle facts require
classifying the eligible population. That semantic requirement remains. The
materialized candidate set is now five required lead columns rather than
`leads.*`, and its email aggregate receives only sent initial/follow-up rows.
Detailed JSON remains page-only. Fixed-instant legacy-vs-RPC regression checks
pass.

### Agents and Finder

Configured worker limits (invalid/non-positive values use defaults; oversized
values are clamped):

| Setting | Default | Maximum |
|---|---:|---:|
| `RESEARCHER_BATCH_SIZE` | 100 | 500 |
| `BOUNCED_EMAIL_REPAIR_BATCH_SIZE` | 25 | 100 |
| `WRITER_BATCH_SIZE` | 100 | 500 |
| `WRITER_STALE_RESET_BATCH_SIZE` | 200 | 500 |
| `REACTIVATION_BATCH_SIZE` | 100 | 500 |

All touched queries use deterministic timestamp/id ordering and explicit
projections. Completed rows are excluded by status at the database boundary.

Finder submits at most 500 provider candidates to
`lookup_finder_candidates(jsonb)` in one call. Matching covers business/city,
phone, exact normalized email, website domain, and non-public email root domain.
`insert_finder_lead_if_new(jsonb)` then takes a short Finder-insert advisory lock,
rechecks the same rules, and inserts once. This closes the race between batch
lookup and website/email extraction while retaining suppression and duplicate
protections. Public domains remain exact-email matches, so `gmail.com` and
`gmail.com.au` are not collapsed.

### Data Quality

Classification and remediation rules are unchanged. Lead triggers continue to
maintain `lead_data_quality_flags`. The report now begins with open flags,
restricts lead/email/deal facts to those flagged lead IDs, groups and filters
the issue set, and returns at most 100 issue rows. The application enriches only
the page's IDs with five parallel set queries and an optional owner-name query.
The summary remains a bounded aggregation over open flags.

### Email Report

Email Report remains separate from Email Log and is still live Hostinger truth.
It loads after client render, defaults to the last 30 days, requires an explicit
date selection for wider reads, rejects ranges over 366 days, requests 100
messages per provider page, and searches Inbox/Sent in parallel. Responses are
not cached as authoritative truth. Tests use synthetic fetch implementations
and no mailbox credentials.

## Evidence-based indexes

The immutable golden baseline migration was not edited. Incremental migration
`00000000000001_performance_reliability.sql` adds only indexes exercised by the
new/current queries.

| Index | Supported query and plan evidence | Tradeoff |
|---|---|---|
| `leads_category_status_created_at_idx` | Leads category+status page changed from the status index plus 451 filtered rows (0.477 ms) to a covering index-only scan with no post-filter (0.265 ms). | Wider btree updated when category, status, creation time, or ID changes. |
| `leads_business_city_idx` | Finder identity lookup changed from a 2,001-row sequential scan to a `BitmapOr` using business/city, phone, and existing normalized-email indexes (0.207 ms). | Two text keys per lead and insert/update maintenance. |
| `leads_phone_not_null_idx` | Same Finder `BitmapOr`; null phones consume no index entry. | One partial btree entry for leads with a phone. |
| `leads_finder_email_root_domain_idx` | Non-public domain lookup uses a bitmap index scan when the partial predicate is present (7 matches, 0.227 ms). | Computes/stores one normalized root for leads with email; email writes are slightly costlier. |
| `leads_finder_website_domain_idx` | Website-domain lookup uses an index scan (0.102 ms in the synthetic plan). | Computes/stores one normalized domain for leads with websites. |
| `emails_lead_type_open_or_delivered_key` | Reliability boundary: one open/delivered intent per lead and phase; duplicate worker insert is rejected atomically. | Unique-index write check; terminal `failed` rows are excluded and can be retried explicitly. |

No lifecycle email index was added: local EXPLAIN selected a sequential scan for
the required population-wide aggregate, so the candidate index was rejected as
speculative. Existing Data Quality flag indexes already support open/status and
email grouping; no new Data Quality index was justified.

## Outbound state and retry semantics

The smallest safe state machine uses existing `emails.status` values:

- `pending_send`: durable intent, including a provider outcome that is still
  uncertain locally.
- `sent`: provider accepted and the local row was confirmed.
- `email_sync_failed`: provider acceptance is known but secondary local sync
  needs repair.
- `failed`: the provider explicitly rejected the request.

Initial email rows were already durable. Follow-up and reactivation now insert
their intent before the irreversible provider call. The email row UUID produces
both `reachagent-email-<uuid>` and a stable RFC Message-ID. Duplicate workers
converge on the unique pending row and call Resend with the same idempotency key.
If the provider accepts but the DB update fails, the row remains pending; a
retry uses the same content and key, asks the provider for the same acceptance,
and then confirms that row. It never blindly creates a second send.

Transport exceptions are classified as uncertain and do not mark an intent
failed. Explicit provider errors mark it failed. Provider message IDs are stored
on confirmation. Daily digest retries use one stable key per Sydney calendar
day and no longer record a provider rejection as sent.

## Background-job safety

- Trigger's daily pipeline queue remains concurrency 1 and now also takes a
  database-backed `daily_pipeline` lock for the whole run. The 70-minute TTL is
  above the task's 60-minute maximum; stale holders can be reclaimed and owner
  tokens fence late releases.
- Sender retains its own lock. Finder atomic inserts and outbound durable
  intents make stage replay deterministic after partial completion.
- Hostinger inbound already uses a unique receipt key, stable Trigger
  idempotency key, atomic claim RPC, processing run ID, terminal-state skip,
  10-minute stale-claim recovery, and fenced completion/failure updates.
- Digest queue concurrency is 1 and its provider idempotency identity is stable
  for the Sydney day.

Trigger.dev remains responsible only for when/how work executes; no orchestrator,
workflow observability model, agent consolidation, workspace, or tenancy model
was introduced.

## Verification

- Fresh local recreation: immutable golden hash verified, local platform prep,
  golden migration, then incremental Prompt 8 migration: PASS.
- `verify_catalog_and_behavior.sql`: PASS.
- `verify_security_negative.sql`: PASS.
- V2 application smoke: PASS.
- Prompt 8 performance/reliability regression (Leads, Lifecycle bound, Finder
  cases and concurrency, worker limits, Data Quality bound, Email Report bound,
  outbound uncertainty/retry, Trigger locks): PASS.
- Leads pagination/filter parity on 2,000 synthetic leads: PASS.
- Lifecycle fixed-instant legacy/RPC semantic comparison: PASS.
- Resend stable-key and duplicate follow-up tests: PASS.
- Distributed lock stale-recovery/fencing tests: PASS.
- Email Report and suppression tests: PASS.
- V2 TypeScript typecheck: PASS.
- V2 production build (Next.js 16.2.4): PASS.

## Remaining risks

- Exact Leads totals and exact Lifecycle counts still scale with the matching
  population; the returned page does not.
- Lifecycle derived sorting necessarily classifies all eligible candidates.
- An explicitly requested 366-day Email Report may traverse many Hostinger
  pages. The timestamped response is live and intentionally not cached.
- Provider-side deduplication is part of the Resend idempotency contract. An
  uncertain pending row must retain its stable UUID; deleting/recreating it
  would intentionally create a new send identity.
- This phase adds no production deployment or production query-plan evidence.
