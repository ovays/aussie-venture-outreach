# ReachAgent V2 performance baseline

Baseline date: 15 September 2026 (Australia/Sydney)

Environment: isolated local V2 Supabase only. The harness refuses non-local
Supabase URLs and requires `NEXT_PUBLIC_REACHAGENT_RUNTIME=v2`. Fixtures are
tagged `V2_PERF_FIXTURE_*` and removed in `finally`; no production system was
read or mutated.

## Synthetic fixture

- 2,000 leads: 1,500 contacted, 250 new, 250 researched.
- 1,500 initial sends, 750 follow-up 1 sends, and 375 follow-up 2 sends.
- Fixed lifecycle instant: `2026-09-15T00:00:00.000Z`.
- Command: `npx tsx --env-file=.env.v2.local scripts/benchmark-v2-performance.ts`.

## Before measurements

| Page/process | DB calls | Rows returned | Duration | Payload | Server paging / finding |
|---|---:|---:|---:|---:|---|
| Leads first page + exact count | 1 | 50 / 2,001 matched | 24.4 ms | 22,253 B | Yes; SQL range. Baseline RPC was unusable by API roles because nested `literal_ilike_pattern(text)` had no EXECUTE grant. |
| Lifecycle first page | 1 | 50 / 1,500 matched | 43.3 ms | 14,662 B | Response is paged, but email facts/classification/counts are computed for all candidates before LIMIT. |
| Finder dedupe preload | 1 | 1,000 (PostgREST cap) | 25.9 ms | 192,201 B | Unbounded source query; silently incomplete beyond the API row cap. |
| Finder `isAlreadyInDB` | 25 | 25 candidates | 245.9 ms | 3,055 B | N+1: one request per candidate. |

Durations are local observations, not service-level guarantees.

## Static call/query audit before changes

| Process | Calls and rows | Finding |
|---|---|---|
| Researcher | settings + all bounced emails + all `status=new` leads using `select('*')`; external website/AI work per lead | Unbounded and broad. |
| Writer | settings/categories + all `email_ready` IDs + two email lookups + all researched leads using `select('*, categories(*)')` + full pipeline dedupe preload | Unbounded; broad projections and in-memory filtering/grouping. |
| Reactivation | settings/counts + every contacted lead with nested email history; repeated per-send lead reads and provider calls | Unbounded eligible-row discovery. |
| Leads | one RPC; status/stage, category, city, escaped search, suppression and deterministic created/id ordering are SQL-side | Page payload is O(page size); exact total necessarily visits matches. RPC helper ACL is a reliability defect. |
| Lifecycle | one RPC; response is bounded, but settings, candidate email aggregate, derived facts, classification, global counts and sorting precede paging | Whole-candidate computation for one page. Counts require global classification; detailed row JSON is page-only. |
| Data Quality | report and summary RPCs in parallel; issue groups max 100; five parallel detail lookups for returned lead IDs plus optional owner lookup | Response was paged, but the report RPC rebuilt lead/email/deal facts for the complete lead history before filtering and paging. |
| Email Report | client-triggered route; default 30 days; explicit max 366 days; folder list then Inbox/Sent searches in parallel; all provider pages traversed | Default avoids annual scan and does not block server render. Explicit wide ranges can still be expensive and repeated. |
| Sender | bounded pending query (100), but diagnostics duplicate counts; one delivered check and send-time lead read per item | Existing initial intent is durable, but idempotency key was generated per invocation; uncertain retry could use a new key. |
| Follow-up/reactivation send | provider call occurred before inserting email history | Provider acceptance followed by DB failure could leave no durable identity; duplicate worker race was only detected after sending. |
| Trigger pipeline | Trigger queue concurrency 1; sender DB mutex; no whole-pipeline durable checkpoint | Overlap is constrained, but retry safety depends on each stage being re-entrant. |

## External calls and duplicated work

- Finder calls a search provider per result page and may fetch candidate websites.
- Researcher performs website extraction/AI work per selected lead.
- Email Report calls Hostinger for the folder list and every Inbox/Sent metadata
  page in the requested range. It does not use production credentials in tests.
- Sender/follow-up/reactivation call Resend; V2 side-effect gates prevent real
  sends during all Prompt 8 verification.
- Sender performs three diagnostic exact counts in addition to its two quota
  counts and eligible count. These are operational diagnostics, not page reads.

The measured baseline above was captured before applying any Prompt 8 database
migration.
