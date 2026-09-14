# ReachAgent V2 golden baseline design

Design date: 9 September 2026 (Australia/Sydney)  
Historical cutoff: migrations `001`–`052`  
Mode: production read-only; design only; V2 not implemented

## Executive decision

ReachAgent V2 must start from one immutable, curated, dump-derived golden baseline. It must not replay the 52 historical migrations. Replay stops at migration 041, whose complete content is the invalid two-byte token `cl`; skipping it still omits live Finder schema.

This design reuses the completed evidence in `docs/reachagent-supabase-schema-audit.md`: repository migrations and callers, Git history, live PostgREST metadata, exact-count `HEAD` queries, `get_lead_status_counts()`, and the prior FK consistency check. No expensive production query was repeated.

Direct PostgreSQL catalog access was unavailable. A renewed read-only access audit on 14 September 2026 found a linked project reference and pooler host/user, but the stored pooler URL has no password; no database password, direct database URL, Supabase Management API token, `psql`, `pg_dump`, or working Docker engine is available. A supported `supabase db dump --linked --schema public,extensions` attempt failed before producing a dump because the CLI requires Docker in this environment. PostgREST cannot expose exact live index/check/function/trigger/policy definitions, grants, sequences, view SQL, extension ownership, or the migration ledger. Those details remain approval gates rather than guessed facts.

## 1. ReachAgent ownership boundary

### Include

These 25 public tables are ReachAgent-owned by migration history or current callers:

| Domain | Tables |
|---|---|
| Core CRM | `categories`, `leads`, `emails`, `follow_ups`, `dm_queue`, `deals`, `activity_log`, `settings` |
| Finder | `city_suburbs`, `category_suburb_priorities`, `category_suburb_search_state`, `exhausted_queries`, `search_cache`, `discovery_run_metrics` |
| Reliability | `dead_letter_queue`, `distributed_locks`, `inbound_receipts` |
| Auth | `profiles` and its relationship to `auth.users` |
| AI | `ai_providers`, `ai_models`, `ai_workflow_configurations`, `ai_request_logs` |
| Templates/quality | `category_email_templates`, `lead_data_quality_flags`, `recipient_outreach_ownership` |

Include their verified constraints, indexes, functions, triggers, policies/grants, the required `extensions` schema, and `pg_trgm`.

### Exclude by default

Seven live tables—`clients`, `customers`, `conversations`, `bookings`, `escalations`, `knowledge_base`, `weekly_reports`—and three views—`v_conversation_thread`, `v_bookings_full`, `v_daily_summary`—have no ReachAgent migration or caller. Their shapes describe a separate WhatsApp/bookings product. They are whole-project drift, not ReachAgent dependencies. Exclude them unless a named owner supplies a cross-product requirement and separate migration/security approval. Never drop or alter them in production.

Also exclude live-only `show_limit()` and `show_trgm(text)` unless a catalog dump proves they are required extension objects. They have no ReachAgent caller.

## 2. Exact reconstruction of missing migration 041

### Proven contract

Git proves 041 was introduced as `cl`; no valid version exists in inspected history. The historical file cannot be recovered byte-for-byte and must remain unchanged. Its required schema is reconstructable at the contract level:

- Live: `city_suburbs.last_used_at` is nullable `timestamptz`; `city_suburbs.priority` is nullable integer default `1`.
- Live: `category_suburb_priorities` has UUID PK `id`; non-null UUID FKs `category_id` and `city_suburb_id`; non-null integer `priority`; non-null timestamps defaulting to `now()`.
- Tests: priority is 1–10; `(category_id, city_suburb_id)` is unique; both FKs use `ON DELETE CASCADE`; no mapping seed/backfill and no update of existing `city_suburbs` rows.
- Code: Settings upserts the pair; Finder reads category-first; no category rows means inherit global priorities; after any category customization, unmapped active suburbs have effective priority `1`.

Exact live constraint/index/trigger/policy names and bodies are catalog-only and unavailable.

### Canonical V2 DDL candidate

This is the exact recommended V2 contract, not an edit to migration 041:

```sql
ALTER TABLE public.city_suburbs
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN priority integer DEFAULT 1,
  ADD CONSTRAINT city_suburbs_priority_check
    CHECK (priority BETWEEN 1 AND 10);

CREATE TABLE public.category_suburb_priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL
    REFERENCES public.categories(id) ON DELETE CASCADE,
  city_suburb_id uuid NOT NULL
    REFERENCES public.city_suburbs(id) ON DELETE CASCADE,
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_suburb_priorities_category_suburb_unique
    UNIQUE (category_id, city_suburb_id)
);

CREATE INDEX category_suburb_priorities_city_suburb_idx
  ON public.category_suburb_priorities (city_suburb_id);

CREATE TRIGGER update_category_suburb_priorities_updated_at
  BEFORE UPDATE ON public.category_suburb_priorities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

Keep `city_suburbs.priority` nullable for exposed-live fidelity; application null means `1`. Strengthening it to `NOT NULL` requires a null-count preflight and approval. The reverse FK index is recommended, but its live existence/name is unverified. Apply the approved RLS matrix below, not an assumed live policy.

Acceptance: boundary checks, duplicate rejection, both cascades, timestamp update, no seed/backfill, Settings role tests, Finder inheritance/override/reset tests.

## 3. Canonical lead-status recommendation

Final historical SQL allows `new`, `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `closed`, `closed_manual`, `dead`. TypeScript adds `interested` and `closed_won`; obsolete migration 003 briefly added `dm_queued`.

Live counts were: `researched` 10, `email_ready` 100, `contacted` 2,602, `replied` 101, `negotiating` 1, `closed` 1, `closed_manual` 3, `dead` 174; zero `new`, `interested`, `closed_won`, `dm_queued`.

Recommended compatibility-first V2 contract:

```text
new, researched, email_ready, contacted, replied,
interested, negotiating, closed, closed_manual, dead
```

- Add `interested`: it is a real UI action and active-deal state.
- Retain `closed` and `closed_manual`: both have live rows and `closed_manual` triggers cancellation side effects.
- Exclude `closed_won`: no live rows or identified writer, inconsistent UI presence, duplicates current closed semantics.
- Retire `dm_queued`; DM lifecycle belongs in `dm_queue.status`.

A later product migration may rename terminal outcomes, but only with an approved mapping and side-effect redesign. One ordered constant must drive the DB check, TypeScript, Zod validation, UI, jobs, RPC stage arrays, reports, and generated Supabase types. APIs must reject unknown values before PostgreSQL.

## 4. Null `category_id` remediation

### Reused counts

| Metric | Count |
|---|---:|
| Leads total | 2,992 |
| Non-null `category_id` | 108 (3.6%) |
| Null `category_id` | 2,884 (96.4%) |
| Null FK in `email_ready`/`contacted` | 2,622 |
| Null FK and null `source` | 2,883 |
| Null FK and `source='manual'` | 1 |
| Non-null FK and `source='manual'` | 108 |
| Non-null FK and null `source` | 0 |
| Non-null FK missing target/name mismatch | 0 / 0 |

The unified Google Places/Outscraper Finder insert omits `category_id`; manual and CSV paths store it.

### Remediation plan

1. Snapshot categories by normalized `lower(trim(name))`; add only reviewed historical aliases.
2. Classify all 2,884 nulls as unique exact, unique alias, ambiguous, or unmatched.
3. Report those counts and sampled IDs for review. They were not previously measured and must not be guessed.
4. Backfill only approved unique mappings in staging/V2; synchronize retained `category_name` from the referenced row.
5. Explicitly map or quarantine ambiguous/unmatched rows—never select arbitrarily.
6. Prove count conservation, zero dangling FKs, and zero ID/name disagreement by status/source.
7. Require future Finder writes to persist the loaded category ID and name before V2 application cutover.
8. Only after all rows/write paths pass may `category_id NOT NULL` be approved.

The 2,622 outreach-active null-FK leads are first priority because FK-based follow-up/reactivation templates currently fall back. Preserve email, ownership, and suppression history.

## 5. Recommended category/location model

| Concern | Canonical model |
|---|---|
| Category identity | `categories.id` authoritative; name is display/compatibility data. |
| Global city scope | One authority. Compatibility may retain `settings.active_cities`; preferred later end state is a normalized cities table. |
| Suburb/availability | `city_suburbs`; add normalized `(city,suburb)` uniqueness only after duplicate preflight. |
| Global weight | `city_suburbs.priority`, 1–10, default 1. |
| Category weight | Sparse `category_suburb_priorities`; no rows inherit global, customized/unmapped means 1. |
| Content behavior | Keep `content_type` and `city_content_types`; Finder uses them. |
| Category location restriction | If required, use normalized joins such as `category_cities`; current editable `categories.cities/custom_cities` are ignored by Finder and must not be represented as effective scope. |
| Runtime state | `category_suburb_search_state`, separate from priority configuration. |

The compatibility baseline retains current columns. V2 approval must select one city-scope authority; normalization is a later incremental migration with data/behavior tests.

## 6. Exact available catalog inventory

### Indexes and constraints

Repository-exact secondary index names/contracts:

- config: `search_cache_query_idx`, `profiles_role_idx`, `profiles_is_active_idx`, `ai_models_provider_enabled_idx`, conditional unique `categories_name_trimmed_lower_key`, `category_email_templates_type_idx`;
- Finder: `discovery_run_metrics_run_at_idx`, unique backing `category_suburb_search_state_category_suburb_unique`, `category_suburb_search_state_city_suburb_idx`;
- leads: `leads_status_created_at_idx`, `leads_city_status_created_at_idx`, `leads_business_name_trgm_idx`, `leads_email_trgm_idx`, `leads_email_report_address_idx`, `leads_email_report_domain_idx`, `leads_normalized_email_idx`;
- emails: `emails_resend_id_key`, partial unique `emails_lead_type_delivered_key`, partial unique `emails_one_pending_initial_per_lead_key`, `emails_lead_id_created_at_idx`, `emails_status_sent_at_idx`, `emails_replied_at_idx`, `emails_created_at_id_idx`, `emails_status_created_at_id_idx`, `emails_type_created_at_id_idx`, `emails_subject_trgm_idx`, `emails_message_id_not_null_idx`;
- activity/reliability: `activity_log_lead_id_created_at_idx`, `activity_log_event_type_created_at_idx`, partial `activity_log_delivery_email_created_at_idx`, partial unique `activity_log_inbound_receipt_event_key`, `inbound_receipts_status_updated_at_idx`;
- queue/quality: `dm_queue_handle_trgm_idx`, `lead_data_quality_flags_open_key`, `lead_data_quality_flags_email_idx`, `lead_data_quality_flags_status_updated_idx`, `recipient_outreach_owner_lead_idx`.

Every ReachAgent table has a PK. Repository uniques also cover settings key, profile email, AI provider/workflow and provider/model, category/template, receipt key, and sparse configuration/state pairs. Checks cover all documented status/type/value sets.

Live PostgREST confirms PK/FK annotations and exposed column defaults/nullability, not `pg_index` or check/unique bodies. Therefore no secondary index is certified live-equivalent. The catalog gate must capture `pg_get_indexdef`, `pg_get_constraintdef`, validity, predicates, expressions, opclasses, collation, and ownership. Candidate gaps (`follow_ups.lead_id`, `deals.lead_id`, DM joins/status/date, category-name lookup) require `EXPLAIN`, not guesswork.

### Functions/RPCs

The earlier audit confirmed that all ReachAgent-called RPC names/signatures at its historical cutoff existed live. Final repository definitions through that cutoff come from:

- 001/009/035: `update_updated_at_column`, `handle_new_auth_user`, `is_active_admin`;
- 036/038/039/040: AI analytics, lead counts, dashboard, lifecycle/health;
- 043–048: delivery suppression/report/selection, email-report lookup, literal escaping, final email summary and global-search RPCs;
- 049–051: recipient claim and final data-quality helpers/reports/actions;
- 052: `claim_hostinger_inbound_receipt`.

Post-cutoff repository migrations 053-054 must also be reconciled when catalog access becomes available: 053 replaces `claim_recipient_outreach`, adds `release_recipient_outreach_claim` and `clear_lead_outreach_suppression_on_email_change`; 054 replaces `get_leads_search_page`. Their live application and bodies are unverified.

Bodies remain unavailable. Before approval compare `pg_get_functiondef` plus identity args, result, language, volatility, parallel/security/leakproof flags, `search_path`, owner and ACL. Harden security-definer functions.

### Triggers

Repository-exact triggers: `update_leads_updated_at`, `update_categories_updated_at`, `update_settings_updated_at`; `on_auth_user_created`; three AI updated-at triggers; `update_category_email_templates_updated_at`; `update_category_suburb_search_state_updated_at`; `leads_set_normalized_email`; final `leads_refresh_data_quality`; and post-cutoff `leads_clear_outreach_suppression_on_email_change` from migration 053. Add the proposed priority updated-at trigger after catalog reconciliation.

Live presence, enable mode, ordering, conditions, and bodies need `pg_trigger`/`pg_get_triggerdef`. Verify `auth.users` only in disposable Supabase, not plain PostgreSQL.

### RLS and grants

Historical intent:

| Group | Migration design | V2 decision |
|---|---|---|
| Core eight plus cache/exhaustion/DLQ | Authenticated full CRUD, service full access | Do not copy blindly; least-privilege review. |
| Profiles | own read, active-admin read, service manage | Candidate. |
| AI config | authenticated read, active-admin manage, service manage | Candidate. |
| AI logs | active-admin read, service manage | Candidate. |
| Templates/search state | authenticated read, active-admin manage, service manage, anon revoked | Candidate for priority table. |
| Inbound receipts | service only | Retain unless architecture changes. |
| Quality/ownership | authenticated read, service manage | Review ordinary-user visibility. |
| City suburbs/metrics/locks | No migration RLS | Must be explicit, not inherited accidentally. |

Production RLS/policies/grants are unavailable. Approval requires `relrowsecurity`/`relforcerowsecurity`, every policy expression, table/function ACL, default privileges, and positive/negative tests as anon, user, active/inactive admin, and service role.

## 7. Golden baseline composition

Create a future immutable `00000000000000_reachagent_v2_baseline.sql` only after approval:

1. schemas/extensions in catalog-proven Supabase placement;
2. foundational trigger/policy helpers;
3. independent tables: categories, settings, city suburbs, profiles, cache/metrics/locks/DLQ, AI providers, receipts;
4. dependent tables: AI models/workflows, leads and children, category templates/priorities/state, quality/ownership;
5. approved defaults, checks, uniques, FKs and canonical lead statuses;
6. verified secondary/expression/partial/GIN indexes;
7. only final RPC/function bodies, not superseded versions;
8. triggers including Auth integration;
9. approved RLS/force state, policies, grants, function ACLs/default privileges;
10. ownership/behavior comments and minimal immutable reference seeds.

Exclude repair/backfills (026/027/049–051), null-category remediation, business secrets/settings, locks/cache, telemetry, and unrelated product objects. Derive from a successful schema-only dump, curate, reconcile, review, restore and catalog-diff. OpenAPI is insufficient.

## 8. Seed-data strategy

- Immutable reference data: dedicated idempotent desired-state seed with stable natural keys/versioning.
- Sanitized business configuration: categories/templates, approved settings, city/suburb priorities, AI choices; preserve referenced UUIDs.
- Operational records: separate staged migration for leads/children, ownership, quality flags and idempotency history.
- Rebuildable: do not migrate locks, cache or expired queries; reset category search state unless cooldown continuity is approved; archive telemetry by policy.

Do not concatenate historical seeds: they contain obsolete exact-name updates, non-idempotent inserts and repairs. Never version production secrets. Verify reruns, no duplicates, resolved FKs, template completeness and secret-free artifacts.

## 9. Aussie Venture migration dependency order

1. Provision platform roles/schemas/extensions and apply the empty approved baseline.
2. Migrate Auth users through a supported path, then matching `profiles` UUIDs.
3. Load roots: `categories`, sanitized `settings`, `city_suburbs`, `ai_providers`.
4. Load dependent configuration: category templates/priorities/optional search state; AI models then workflows.
5. Load `leads` after approved status/category remediation; preserve IDs/timestamps.
6. Load `emails`, then `follow_ups`; also DM queue, deals and activity.
7. Load recipient ownership, required quality flags and lead suppression state.
8. Load inbound receipts/idempotency linkage before enabling inbound processing.
9. Optionally load retained metrics/logs/DLQ; never load active locks/cache.
10. Reconcile counts/checksums/invariants, generate types, test, then separately approve cutover.

Keep outbound jobs/webhooks isolated during import. Any trigger-disable procedure needs explicit approval and post-import refresh verification.

## 10. Historical migration strategy

- Freeze 001–052 unchanged as V1 history; document invalid 041 and cutoff 052.
- Use a separate V2 migration root/project so clean V2 never evaluates V1.
- Begin immutable incremental V2 migrations after the baseline.
- Separate schema, data migration, and operational repair scripts.
- Never fake-mark 041 applied or rewrite migrations to manufacture replay success.
- Retain V1 history for audit/maintenance.

## 11. Disposable restore-test plan

1. Obtain a non-empty safe schema-only dump and catalog extracts; hash and scan for secrets/data.
2. Create a brand-new disposable Supabase project matching target versions/extensions.
3. Apply only the V2 baseline once and capture all diagnostics.
4. Diff catalogs: relations/columns/defaults; constraints; indexes; functions/security; triggers; RLS/policies; ACL/default privileges; extensions; views; sequences; comments.
5. Assert all 25 owned tables and absence of ten unrelated objects/unapproved helpers.
6. Load synthetic fixtures for every status, FK cascade, priority bound/inheritance, email uniqueness, normalization, claims, receipts and quality triggers.
7. Test all five DB roles, allowed and denied paths.
8. Generate Supabase types; type-check/build; run RPC, Finder, template, lifecycle/search, suppression, inbound and quality tests.
9. Rehearse sanitized production data using section 9; reconcile per-table counts and especially 2,992 leads/category mappings.
10. Retain evidence and destroy the disposable project. No mutation command receives production credentials.

Success: zero unexplained catalog diffs, rejected source records, policy failures, or application-test failures.

## 12. V2 baseline approval gates

1. Non-empty schema-only dump/catalog evidence, hashed and secret-free.
2. Named-owner approval of inclusion/exclusion boundary.
3. 041 shape, nullability, constraints, indexes, trigger, RLS and sparse semantics approved.
4. Ten-status contract and every source mapping approved across DB/API/UI/jobs/RPCs.
5. Exact/alias/ambiguous/unmatched counts for 2,884 null FKs reviewed; no arbitrary mapping.
6. One location-scope authority selected; ignored fields explicitly retained or retired.
7. Zero unexplained constraint/index/function/trigger/extension/sequence/catalog diffs.
8. Least-privilege RLS/grants and security-definer review passed.
9. Seeds idempotent, dependency-safe and secret-free.
10. Clean disposable restore/catalog diff passed.
11. Sanitized data rehearsal preserves relationships, suppression and idempotency.
12. Generated types, build and feature/integration tests passed.
13. Backup, freeze, cutover, rollback, monitoring and owners approved.

Any failed gate blocks cloning; it does not authorize production patching.

## 13. Unavailable catalog details

Still unavailable: exact live secondary indexes/predicates/opclasses/usage; check/unique bodies/names; function/trigger bodies/configuration; RLS enable/force and policy expressions; grants/owners/default privileges; unrelated view SQL; sequences; extension ownership; `show_limit`/`show_trgm` provenance; applied migration ledger.

This does not block completion of the design. It blocks executable baseline SQL approval. No detail above fills these gaps by guesswork.

## 14. Final answers

1. Existing migrations cannot safely create V2; 041 is invalid and required schema is missing.
2. Production is not repository-reproducible.
3. ReachAgent owns the 25 listed tables; ten WhatsApp/bookings objects are unrelated by current evidence.
4. Section 2 gives the complete provable 041 contract and deterministic V2 DDL; byte-exact history/catalog-only details are unrecoverable without catalog access.
5. Canonical compatibility statuses are the ten in section 3; exclude `closed_won` and `dm_queued`.
6. Category drift is severe: 2,884/2,992 null FKs; 2,622 outreach-active; all 108 non-null rows valid/name-consistent.
7. Remediate by reviewed unique name/alias mapping in staging; quarantine ambiguity; only later enforce non-null.
8. Use IDs/normalized joins, separate global/category priority and runtime state, and one city-scope authority.
9. Exact live catalog objects remain unavailable; repository definitions and live signatures/shapes are documented.
10. The golden baseline is curated owned schema plus final verified catalog objects and minimal seeds—never historical repairs/unrelated objects.
11. Freeze 001–052; V2 starts separate baseline/history.
12. Prove it via disposable restore, catalog/RLS diff, fixtures, generated types, application tests and data rehearsal.
13. Do not alter production, migrations, or deployments and do not implement V2 now.

## Completion record

GOLDEN BASELINE DESIGN COMPLETE

Existing files modified: 0  
Production database changes: 0  
Production data changed: 0  
Migrations applied: 0  
Deployments performed: 0

Files created during Prompt 3:

- `docs/reachagent-supabase-schema-audit.md`
- `docs/reachagent-v2-golden-baseline-design.md`

No safe successful schema-only dump was obtained. The repository's tracked `docs/reachagent-live-schema-only.sql` is zero bytes and must not be treated as dump evidence.

## 15. Production catalog validation addendum (14 September 2026)

This addendum records the continuation of the catalog gate. It reuses the earlier audit and does not repeat its production data queries.

### Read-only access audit

| Access path | Result |
|---|---|
| Supabase linked project | Available: linked-project metadata and a project reference are present. No identifier or credential is reproduced here. |
| Pooler URL | Incomplete: scheme, host, and username are present, but the URL contains no password. It cannot authenticate as stored. |
| Direct/session/transaction database URL | Not available in repository files or process environment. |
| Database password | Not available in repository files or process environment. |
| Supabase Management API credential | No `SUPABASE_ACCESS_TOKEN` environment variable or Supabase CLI access-token file is available. |
| API credentials | Supabase URL and service-role key are present, but PostgREST/service-role access is not PostgreSQL catalog access. Values were not printed. |
| Native PostgreSQL clients | `psql` and `pg_dump` are not installed or discoverable. |
| Supabase CLI | Not installed globally; runnable through `npx`. |
| Docker | No working Docker command/engine is available. Supabase CLI 2.116.0 therefore cannot run its remote dump helper. |

The read-only command `supabase db dump --linked --schema public,extensions` was attempted. It failed with the CLI's Docker prerequisite error. The target path was already a tracked zero-byte file in `HEAD`; it was restored to that exact pre-attempt state. It is a pre-existing placeholder, not a successful dump, and is excluded from all readiness evidence.

### Migration 041 live-assumption classification

`CONFIRMED` below means confirmed by the previously captured live PostgREST schema metadata. It does not imply catalog-level confirmation of features PostgREST does not expose.

| Proposed reconstruction fact | Classification | Evidence/limit |
|---|---|---|
| `city_suburbs.last_used_at` is nullable `timestamptz` | CONFIRMED | Live column metadata. |
| `city_suburbs.last_used_at` has no exposed default | CONFIRMED | Live column metadata exposes no default. Generated/identity metadata is still catalog-only. |
| `city_suburbs.priority` is nullable integer with default `1` | CONFIRMED | Live column metadata. |
| `city_suburbs.priority CHECK (priority BETWEEN 1 AND 10)` | UNVERIFIED | Test/repository intent only; exact live check is catalog-only. |
| `category_suburb_priorities.id` is a non-null UUID primary key | CONFIRMED | Live PK/column metadata. |
| `category_suburb_priorities.id DEFAULT gen_random_uuid()` | UNVERIFIED | The live API metadata did not establish this default. |
| `category_id` is non-null UUID and references `categories(id)` | CONFIRMED | Live column/FK metadata. |
| `category_id` uses `ON DELETE CASCADE` and the proposed `ON UPDATE` behavior | UNVERIFIED | Referential actions require `pg_get_constraintdef`. |
| `city_suburb_id` is non-null UUID and references `city_suburbs(id)` | CONFIRMED | Live column/FK metadata. |
| `city_suburb_id` uses `ON DELETE CASCADE` and the proposed `ON UPDATE` behavior | UNVERIFIED | Referential actions require `pg_get_constraintdef`. |
| `priority` is non-null integer | CONFIRMED | Live column metadata. |
| `priority CHECK (priority BETWEEN 1 AND 10)` | UNVERIFIED | Test/repository intent only. |
| `created_at` and `updated_at` are non-null `timestamptz DEFAULT now()` | CONFIRMED | Live column/default metadata. |
| Unique constraint on `(category_id, city_suburb_id)` | UNVERIFIED | Test/repository intent only; unique catalog unavailable. |
| Reverse index on `city_suburb_id` | UNVERIFIED | `pg_index` unavailable. |
| Updated-at trigger and exact trigger function | UNVERIFIED | `pg_trigger` unavailable. |
| RLS enabled/FORCE state and exact policies | UNVERIFIED | `pg_class`/`pg_policy` unavailable. |

No proposed 041 fact is classified `DIFFERENT` on currently available evidence. Migration 041 is not fully reconstructable as a live-equivalent object until every `UNVERIFIED` row is resolved.

### Lead-status constraint validation

The exact live `leads.status` check definition remains unavailable, so the complete set accepted by production cannot be honestly stated. The earlier read-only counts prove only that production has accepted `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `closed`, `closed_manual`, and `dead`; zero observed rows do not prove acceptance or rejection.

| Source | Status vocabulary |
|---|---|
| Final historical migration 012 | `new`, `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `closed`, `closed_manual`, `dead` |
| Current TypeScript/UI (`src/lib/lead-status.ts`) | Historical nine plus `interested` and `closed_won` |
| Recommended V2 contract | Historical nine plus `interested`; exclude `closed_won` and obsolete `dm_queued` |
| Exact live check | UNVERIFIED |

### ReachAgent function body comparison

The earlier API audit established live RPC names/signatures available at that time, but not bodies. Migrations 053-054 are newer than the historical audit cutoff: 053 replaces `claim_recipient_outreach`, adds `release_recipient_outreach_claim` and `clear_lead_outreach_suppression_on_email_change`; 054 replaces `get_leads_search_page`. Their live application cannot be inferred. Since no `pg_get_functiondef` access exists, assigning `MATCH`, `LIVE NEWER`, `REPO NEWER`, `LIVE ONLY`, or `REPO ONLY` would be unsupported. Each required comparison is therefore explicitly `UNVERIFIED` rather than guessed.

| Function/RPC area | Final repository source | Live-body comparison |
|---|---|---|
| Dashboard | `get_dashboard_summary` (039) | UNVERIFIED |
| Leads search | `get_leads_search_page` (054; supersedes 048) | UNVERIFIED |
| Pipeline search | `get_pipeline_search_page` (048) | UNVERIFIED |
| Lifecycle | `get_lifecycle_page` (040) | UNVERIFIED |
| Email Log search/summary | `get_email_log_search_page`, `get_email_log_summary` (048) | UNVERIFIED |
| Health summary | `get_health_summary` (040) | UNVERIFIED |
| Deals search | `get_deals_search_page` (048) | UNVERIFIED |
| DM Queue search | `get_dm_queue_search_page` (048) | UNVERIFIED |
| Delivery failures | `get_delivery_failure_report` (044), `get_delivery_failure_lead_selection` (045) | UNVERIFIED |
| Email-report lookup | `get_email_report_leads` (047) | UNVERIFIED |
| AI analytics | `get_ai_request_analytics` (036) | UNVERIFIED |
| Delivery suppression | `suppress_lead_delivery_email` (043) | UNVERIFIED |
| Hostinger receipt claim | `claim_hostinger_inbound_receipt` (052) | UNVERIFIED |
| Recipient ownership | `claim_recipient_outreach`, `release_recipient_outreach_claim` (053) | UNVERIFIED |
| Data quality | final helpers/report in 051; actions/summary in 050 | UNVERIFIED |

Comparison must include identity arguments, result type, complete body, language, volatility, parallel/leakproof flags, security mode, per-function configuration/search path, owner, and ACL.

### Trigger comparison

No live trigger catalog was obtainable. Accordingly all requested comparisons remain `UNVERIFIED`; none can be safely labelled `MATCH`, `LIVE ONLY`, `REPO ONLY`, or `DIFFERENT`.

| Trigger area | Final repository trigger | Status |
|---|---|---|
| Lead updated-at | `update_leads_updated_at` | UNVERIFIED |
| Category updated-at | `update_categories_updated_at` | UNVERIFIED |
| Settings updated-at | `update_settings_updated_at` | UNVERIFIED |
| Auth profile creation | `on_auth_user_created` on `auth.users` | UNVERIFIED |
| AI configuration updated-at | `update_ai_providers_updated_at`, `update_ai_models_updated_at`, `update_ai_workflow_configurations_updated_at` | UNVERIFIED |
| Category template updated-at | `update_category_email_templates_updated_at` | UNVERIFIED |
| Category suburb search state updated-at | `update_category_suburb_search_state_updated_at` | UNVERIFIED |
| Lead normalized email | `leads_set_normalized_email` | UNVERIFIED |
| Data-quality refresh | `leads_refresh_data_quality` (final body from 051) | UNVERIFIED |
| Lead suppression reset after email change | `leads_clear_outreach_suppression_on_email_change` (053) | UNVERIFIED |
| Category suburb priorities updated-at | Proposed only; absent from valid historical migrations | UNVERIFIED |

### RLS, grants, and SaaS security assessment

Exact live RLS enable/FORCE flags, policies, roles, `USING`/`WITH CHECK` expressions, schema/table/sequence/function grants, default privileges, owners, and security-definer settings all remain unavailable. The V1 intent is unsafe to copy wholesale into an eventual SaaS baseline:

- broad authenticated CRUD on the core tables would allow every authenticated account to read or modify all leads and operational records;
- broad authenticated settings writes would allow ordinary users to alter system-wide behavior and potentially secret-bearing configuration;
- authenticated reads of quality/ownership objects can expose cross-customer recipient identity and suppression state;
- `city_suburbs`, metrics, and distributed locks have no explicit historical RLS posture;
- service-role access bypasses RLS, so application/job queries without tenant predicates cannot become tenant-safe merely by adding policies;
- every security-definer RPC requires fixed safe `search_path`, least-privilege execute grants, caller authorization where applicable, and body review.

This remains a design finding only. Multi-tenancy is not implemented here.

### Ownership boundary and unexplained objects

A renewed repository/code search found no ReachAgent table, view, or RPC dependency on `clients`, `customers`, `conversations`, `bookings`, `escalations`, `knowledge_base`, `weekly_reports`, `v_conversation_thread`, `v_bookings_full`, or `v_daily_summary`. Incidental English words such as "bookings" in lead content are not schema dependencies. All ten objects remain classified **EXCLUDE FROM REACHAGENT V2**. They must not be altered or deleted in production.

`show_limit()` and `show_trgm(text)` still have no ReachAgent caller. Their owner, source extension, body, and purpose remain unexplained because function catalog metadata is unavailable; keep them excluded pending catalog proof.

### Baseline readiness answers

1. Successful schema-only dump: **No**.
2. All ReachAgent tables completely known: **No**; API-visible shapes are known, but generated/identity/sequence/ownership/comment and other catalog details are incomplete.
3. All constraints known: **No**.
4. All indexes known: **No**.
5. All required function bodies known: **No**.
6. All triggers known: **No**.
7. All RLS policies known: **No**.
8. All relevant grants known: **No**.
9. Migration 041 fully reconstructable: **No**.
10. ReachAgent ownership boundary confirmed: **Yes at repository/caller level**; named-owner approval remains a separate governance gate.
11. Unexplained live objects that could affect ReachAgent: **Yes**; `show_limit()` and `show_trgm(text)` provenance is unresolved, and catalog-only dependencies cannot be ruled out.
12. Enough verified information to create the V2 golden baseline: **No**.

**GOLDEN BASELINE STATUS: NOT READY**

Remaining blockers:

- a non-empty, secret-free production schema-only dump;
- authenticated read-only PostgreSQL catalog access sufficient to capture exact columns/generated/identity/sequences, constraints and referential actions, indexes, functions, triggers, RLS/policies, grants/default privileges, extensions, views, owners, ACLs, and dependencies;
- catalog resolution of every unverified migration 041 property and the exact `leads.status` check;
- full live-body comparison for all ReachAgent functions, including post-cutoff migrations 053-054, and classification as `MATCH`, `LIVE NEWER`, `REPO NEWER`, `LIVE ONLY`, or `REPO ONLY`;
- full live trigger comparison and classification;
- provenance/dependency resolution for `show_limit()` and `show_trgm(text)` and any other catalog-only live objects.

## Catalog validation completion record

CATALOG VALIDATION COMPLETE

Production schema changes: 0
Production data changes: 0
Historical migrations changed: 0
Migrations applied: 0
Deployments performed: 0

Schema-only dump:
NOT AVAILABLE

GOLDEN BASELINE STATUS:
NOT READY

Remaining blockers:
The six catalog/dump blockers listed immediately above.
