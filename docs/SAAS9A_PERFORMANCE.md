# SaaS 9A — Performance and query optimisation

## Scope and safety

This work targets ReachAgent V2 only. Supabase/Postgres remains the source of truth. No hosted SQL was applied, no provider was called, and no email, AI, Finder, Trigger, Stripe, deployment, or workflow action was executed.

Migration 18 requires the same temporary `reachagent_function_owner` membership pattern used by earlier V2 migrations. It also temporarily grants that NOLOGIN owner `CREATE` on `public` so ownership can be assigned to the two new `SECURITY DEFINER` functions. Both grants are revoked at the end of the migration.

## Before baseline

The original `npm run benchmark:performance:v2` could not establish timings: it used the hosted URL from `.env.v2.local`, correctly refused that target, and its local fixture omitted the required `workspace_id`. This was recorded rather than replaced with invented timings. The repaired benchmark retains legacy RPC overloads for service-only comparison and runs entirely in a rolled-back local transaction.

| Surface | Before query shape | DB calls | Rows transferred / bound | Main issue |
|---|---|---:|---:|---|
| Dashboard | `get_dashboard_summary` | 1 | Aggregate JSON, 20 activity, 10 hot leads | Migration 15 already optimised it; no change justified |
| All Leads | `get_leads_search_page` | 1 | 50 default, 100 display max | RLS allowed all memberships and the RPC lacked selected-workspace predicate |
| Lifecycle | `get_lifecycle_page` | 1 | 50 default, 100 max | Full eligible population must be classified for exact derived counts/sorts; scope was implicit |
| Outreach Pipeline | Six concurrent stage RPCs | 6 fixed | Up to 50 per stage | RPC materialised `leads.*`; selected workspace was implicit |
| Deals | `get_deals_search_page` | 1 | 50 default, 100 max | Materialised `deals.*`; selected workspace was implicit |
| Email Log | page RPC plus summary RPC | 2 | 50 list rows | Repeated the filtered email/lead scan and selected all email columns internally |
| Email Report | Provider `listMessages`, then one lead lookup RPC | Provider-dependent | Date range defaults to 30 days, hard max 366 days | Provider truth must remain separate; result size is still provider/range dependent |
| Delivery Failures | One report RPC | 1 | 50 default, 100 max | Selected workspace was implicit; provider-event lookup needed workspace-aware index |
| DM Queue | One page RPC | 1 | 50 default, 100 max | Materialised `dm_queue.*`; selected workspace was implicit |
| Categories | Two parallel configuration reads | 2 | Entire workspace configuration | `select('*')` over list responses |
| Settings | Onboarding plus categories, templates, raw 30-day activity, suburbs, two counts, and two settings reads | Multiple | Every matching Finder activity row | Raw activity was transferred and aggregated repeatedly in JavaScript |
| Admin Workspaces | One unbounded RPC | 1 | Every workspace | Three correlated counts per workspace (SQL N+1-like work) |
| Admin Audit | One keyset RPC | 1 | 50 default, 100 max, fetches limit + 1 | Already bounded and deterministic |
| Admin Usage/Billing | Workspace reference lists plus selected detail | Multiple | Entire workspace reference list | Acceptable at current admin scale; remains a future pagination candidate |

All large user-facing list filters execute server-side. All sort keys are fixed or allowlisted, and ordering includes a deterministic id tie-breaker.

## Changes

### Workspace-scoped bounded RPCs

Leads, Lifecycle, Pipeline, Deals, Email Log, Delivery Failures, delivery-failure selection, and DM Queue now receive `p_workspace_id` derived by `requireApiWorkspaceUser()`. Browser input cannot select a workspace. Table RLS remains active, so the explicit predicate improves index selection without replacing tenant authorization.

The old unscoped RPC overloads remain available to `service_role` for controlled comparison/diagnostics, but `authenticated` execution is revoked. New overloads require workspace id as their first non-default argument.

### Pagination and filtering

- Display lists retain offset pagination because the current UX needs numbered pages and exact totals.
- Default page size is 50 and display maximum is 100.
- Lead `ids_only` remains a separate explicit bulk-operation path with batches of 1,000; it is not used to render a page.
- Admin workspace directory now has server-side search, a 50-row page, 100-row hard maximum, deterministic `created_at, id` ordering, and an exact total.
- Audit remains keyset-paginated on `(created_at DESC, id DESC)` and fetches only `limit + 1`.
- Invalid pagination falls back to safe defaults; over-limit page sizes clamp to 100.

### Counts and aggregations

- Email Log now returns page rows, total, and summary from one RPC. The API dropped from two DB calls to one.
- Settings uses `get_settings_performance_summary()` for 30-day/today/week totals, seven daily buckets, dead-letter count, and live search-cache count. Raw activity metadata no longer crosses the server boundary.
- `admin_list_workspace_directory()` now uses grouped aggregates rather than three correlated counts per workspace.
- `admin_list_workspace_directory_page()` computes counts only for the selected workspace page.

### Reduced projections

Pipeline, Deals, DM Queue, and Email Log materialized CTEs now carry only list fields. Categories and the Settings category read use explicit projections. Email bodies, raw send envelopes, provider payloads, AI prompts/responses, and large lead research/detail columns are not returned by list RPCs.

Lead detail remains on-demand through the existing lead drawer endpoint.

### N+1 audit

Every source `for`/`forEach`/`map` near Supabase, RPC, or fetch calls was reviewed.

- Removed: bulk lead actions previously fetched each lead individually. They now preload at most 200 explicit lead projections in one query. Side-effecting send/research/write steps remain sequential for locking, quota, provider, and deterministic error semantics.
- Removed: email regeneration previously performed two reads per lead. Leads and pending initial emails now load in two parallel bounded queries; regeneration remains sequential and capped at 200.
- Removed: admin directory correlated count subqueries were replaced with grouped aggregates/page joins.
- Acceptable fixed fan-out: Pipeline starts six independent, concurrent stage reads. This is six known columns, not row-dependent N+1, and each response is capped at 50.
- Acceptable bounded mutation loops: lead deletion batches, delete-by-date child tables, reset tables, and observability writes operate on fixed table sets or capped batches. They preserve transactional/error-isolation or ordered mutation semantics and are not page-render reads.
- Decision/shadow context loaders use bounded `IN (...)` queries and fixed `Promise.all` groups, not per-row queries.

### Concurrency

Independent reads use `Promise.all`: Settings configuration/summary reads, lead-regeneration preloads, dashboard-adjacent existing loaders, and source/destination Pipeline refreshes. Mutations, provider sends, locks, quota consumption, and workflow-dependent operations remain ordered.

## Index review

| Query | Previous index | Observed/plausible plan issue | Migration 18 index | Reason | Write cost |
|---|---|---|---|---|---|
| Workspace lead page | `(workspace_id, created_at DESC)` | Stable id tie-break required extra ordering | `(workspace_id, created_at DESC, id ASC)` | Covers stable default list order | One wider existing btree, not an additional overlapping index |
| Lead status page | `(workspace_id, status, created_at DESC)` | Same tie-break issue | add `id ASC` to same index | 50 scanned for 50 returned in local plan | One extra UUID column |
| Lead city/category + status | Existing composites without id | Stable sort not fully covered | add `id ASC` to each | Actual UI filter/order combinations | One extra UUID column per existing btree |
| Email default page | Global created index; workspace/status index | Workspace-only ordered read could scan/filter global rows | `emails_workspace_created_at_id_idx` | Tenant-local stable order | One new btree |
| Email type page | Global type index | Workspace and type were not in one ordered index | `emails_workspace_type_created_at_id_idx` | Local plan scanned 50 rows and returned 50 | One new btree |
| Deals page | `(workspace_id, closed_at DESC)` | Stable id tie-break not covered | add `id ASC` | Matches list order | One wider existing btree |
| DM status page | `(workspace_id, status, created_at DESC)` | Stable id tie-break not covered | add `id ASC` | Local plan scanned 50 rows and returned 50 | One wider existing btree |
| DM platform page | No tenant/platform/order composite | Platform filter needed extra filtering/sort | `dm_queue_workspace_platform_created_at_idx` | Actual API filter combination | One new btree |
| Delivery provider event | Global expression partial index | Workspace predicate could not lead index lookup | workspace + email-id expression + time/id partial index | Matches lateral latest-event lookup | One partial btree on failure events only |

The shorter overlapping lead, deal, and DM indexes are dropped and recreated under their existing names, avoiding duplicate write cost.

### Indexes intentionally not added

- No audit combinatorial indexes for every workspace/action/actor combination. Existing global, workspace, action, and actor keyset indexes cover the observed filters without multiplying write cost. Local base/action plans used an ordered audit index; the tiny no-match workspace fixture selected a cheap sequential scan, which is appropriate at 232 rows.
- No new trigram indexes. Existing business-name, email, subject, and handle GIN indexes remain available; workspace btrees can be combined by the planner. Workspace-prefixed GIN duplication was not justified.
- No lifecycle expression index. Lifecycle dates are derived from settings and email history, so a static index would not preserve current meaning.
- No separate status/category/city single-column indexes. Existing workspace composites cover the application shapes.
- No cache table or cache-service index beyond the existing workspace cache indexes.

## RLS and security findings

RLS helper functions use indexed primary/profile lookups and remain unchanged. Rewriting policies or caching authorization was rejected because explicit server-resolved workspace predicates remove the hot-path scan problem while preserving the proven isolation model.

Security checks after the change:

- no browser-controlled `workspace_id`;
- no RLS bypass for authenticated list queries;
- old unscoped list RPCs are not executable by `authenticated`;
- service-only admin/settings RPCs validate the JWT database role;
- safe, allowlisted filter/sort values; no dynamic SQL;
- no authorization, suppression, send eligibility, quota, billing, credential, or ownership-lock caching;
- no email body, mailbox secret, provider raw payload, or AI payload in list results;
- dashboard one-time authorization and explicit workspace filtering remain unchanged;
- SaaS 6 quota, SaaS 7 billing, and SaaS 8 append-only audit behavior are unchanged.

## Caching decision

No new framework cache was added. The existing discovery/business lookup cache is already workspace-keyed, expiry-bounded, and used only for first-page external search results. Categories and settings are inexpensive configuration reads relative to invalidation/security complexity. Authorization, suppression, send eligibility, quota, billing, credentials, and locks remain uncached.

Redis is not required. Postgres indexes, bounded queries, grouped aggregates, and selective existing cache behavior are sufficient at the measured scale. Revisit external caching only after production evidence shows a bottleneck Postgres cannot reasonably handle.

## Benchmark methodology and results

`npm run benchmark:performance:v2` connects only to local Postgres (default `127.0.0.1:54322`), refuses non-local hosts, creates fixtures inside a transaction, runs three warm calls, reports the median, and rolls the transaction back.

Fixture: 6,000 primary-workspace leads, 2,000 decoy-workspace leads, thousands of email rows, 1,500 DMs, 500 deals, 3,000 activity rows, and 400 synthetic workspaces.

| Query | Before | After | Change | Calls before → after |
|---|---:|---:|---:|---:|
| Leads page | 29.24 ms | 18.98 ms | 35.09% faster | 1 → 1 |
| Pipeline page | 23.38 ms | 14.67 ms | 37.25% faster | 1 → 1 |
| Email Log page + summary | 94.43 ms | 23.87 ms | 74.72% faster | 2 → 1 |
| Lifecycle page | 57.63 ms | 57.40 ms | 0.40% faster | 1 → 1 |
| Admin workspace directory | 638.71 ms | 6.29 ms | 99.02% faster | one unbounded result → one 50-row page |

The Lifecycle result is effectively unchanged; its exact aggregate/classification work dominates, so no semantic redesign was attempted.

Post-change plan evidence:

| Plan | Rows scanned | Rows returned | Index | Execution |
|---|---:|---:|---|---:|
| Lead status page | 50 | 50 | `leads_workspace_status_created_at_idx` | 0.22 ms |
| Email type page | 50 | 50 | `emails_workspace_type_created_at_id_idx` | 0.09 ms |
| DM status page | 50 | 50 | `dm_queue_workspace_status_created_at_idx` | 0.07 ms |

These are database query measurements only. They support reduced server work and payload/call count; they do not by themselves claim a browser rendering improvement.

## Remaining risks and revisit thresholds

- Email Report intentionally reads mailbox/provider truth. Its 30-day default and 366-day maximum bound time, but a very high-volume mailbox can still return a large provider result. Add provider-native incremental aggregation only if measured mailbox volume warrants it.
- Lifecycle exact counts and derived sorting still classify the eligible workspace population. Consider a maintained projection only if measured workspace sizes make the current ~58 ms local result materially worse; that would be a business-semantics project, not a casual index change.
- Pipeline uses six fixed concurrent requests. Combine them into one multi-stage RPC only if request overhead becomes measurable.
- Admin Usage/Billing selection lists are still whole-platform reference data. Add shared paged workspace search if platform workspace count grows beyond comfortable selector size.
- Category, suburb, and mailbox configuration reads are intentionally unpaged because they are editable reference datasets. Add targeted pagination only if a workspace grows these into thousands.
- Offset pagination remains suitable for the current numbered-page UX. Move individual screens to keyset pagination only if deep-page latency is measured as a real problem.
- Exact totals scan matching index entries. Remove totals or replace with approximate/next-page UX only if count latency becomes significant.
