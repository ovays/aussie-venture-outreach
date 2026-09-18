# ReachAgent V2 golden baseline design

Design date: 9 September 2026 (Australia/Sydney)  
Historical migration set: migrations `001`–`054`
Mode: production read-only; design only; V2 not implemented

Decision-resolution update: 14 September 2026 (Australia/Sydney)
Current approval state: **GOLDEN BASELINE DESIGN STATUS: READY TO BUILD**. This authorizes only Prompt 6 to create and test baseline SQL in a disposable environment; it does not authorize production changes, data migration, deployment, or application refactoring. Section 17 is the controlling decision record and supersedes earlier recommendations and historical `NOT READY` records where they conflict.

## Executive decision

ReachAgent V2 must start from one immutable, curated, dump-derived golden baseline. It must not replay the 54 historical migrations. Replay stops at migration 041, whose complete content is the invalid two-byte token `cl`; skipping it still omits live Finder schema.

This design reuses the completed evidence in `docs/reachagent-supabase-schema-audit.md`: repository migrations and callers, Git history, live PostgREST metadata, exact-count `HEAD` queries, `get_lead_status_counts()`, and the prior FK consistency check. No expensive production query was repeated.

The production catalog gate was completed read-only on 14 September 2026 after Docker became available. `supabase db dump --linked --schema public,extensions` produced the verified, data-free artifact `docs/reachagent-live-schema-only.sql` (211,398 bytes; SHA-256 `5C1FFE0835E08AFCFA71D8B2BE18695661944F934A53D7F363111EE841A16F24`). A temporary auth schema dump and catalog-only SQL inside explicit read-only transactions supplied the cross-schema auth trigger, installed-extension inventory, trigger enable modes, FORCE-RLS state, and validity flags omitted or obscured by the main dump. Section 16 supersedes the earlier unavailable-catalog statements and records the exact reconciliation.

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

The live catalog confirms the table shape, names, defaults, priority check, pair unique, reverse FK index, both cascading FKs, updated-at trigger, RLS state, and three policies. It also confirms that `city_suburbs.priority` has **no live check constraint**.

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

Final V2 decision: strengthen `city_suburbs.priority` to `integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 10)`. This differs deliberately from live production. The later data-import preflight must count null and out-of-range values; nulls map explicitly to `1`, while out-of-range rows fail import and require reviewed remediation. The live reverse FK index is `category_suburb_priorities_city_suburb_idx`. The V2 access decision is in section 17.

Acceptance: boundary checks, duplicate rejection, both cascades, timestamp update, no seed/backfill, Settings role tests, Finder inheritance/override/reset tests.

## 3. Canonical lead-status recommendation

Final historical SQL allows `new`, `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `closed`, `closed_manual`, `dead`. TypeScript adds `interested` and `closed_won`; obsolete migration 003 briefly added `dm_queued`.

The exact live `leads_status_check` accepts only `new`, `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `closed`, `closed_manual`, and `dead`. Live counts were: `researched` 10, `email_ready` 100, `contacted` 2,602, `replied` 101, `negotiating` 1, `closed` 1, `closed_manual` 3, `dead` 174; zero `new`. Production rejects `interested`, `closed_won`, and `dm_queued` at the database constraint.

Decided compatibility-first V2 contract:

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

The compatibility baseline retains current columns, but only `settings.active_cities` is authoritative for global city scope. Category city arrays remain compatibility/display data and must be labelled non-operative until a later normalized restriction model is approved. Full rules are decided in section 17.

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

The production dump now certifies the definitions above and adds the missing priority reverse index. Across `public` and `extensions`, all 115 constraints are validated and all 113 indexes (45 constraint-backed plus 68 standalone) are valid and ready. The exact expressions, predicates, opclasses, collations, ownership, and referential actions are preserved in the dump. Potential performance gaps (`follow_ups.lead_id`, `deals.lead_id`, DM joins/status/date, category-name lookup) still require workload-specific `EXPLAIN`; catalog existence alone does not establish adequacy.

### Functions/RPCs

The earlier audit confirmed that all ReachAgent-called RPC names/signatures at its historical cutoff existed live. Final repository definitions through that cutoff come from:

- 001/009/035: `update_updated_at_column`, `handle_new_auth_user`, `is_active_admin`;
- 036/038/039/040: AI analytics, lead counts, dashboard, lifecycle/health;
- 043–048: delivery suppression/report/selection, email-report lookup, literal escaping, final email summary and global-search RPCs;
- 049–051: recipient claim and final data-quality helpers/reports/actions;
- 052: `claim_hostinger_inbound_receipt`.

Post-cutoff migrations 053-054 are live and their final bodies match the repository. All ReachAgent RPC bodies match their final repository definitions. Of 40 repository public functions, 39 match exactly after pg_dump normalization; `handle_new_auth_user` differs as described in section 16. Production also has the ReachAgent-affecting live-only `normalize_lead_fields()` and two live-only helpers used exclusively by the excluded product. The dump captures identity arguments, result, language, volatility, parallel/security settings, `search_path`, owner, and ACL. Security-definer functions still require hardening.

### Triggers

All repository-exact triggers are live and match: `update_leads_updated_at`, `update_categories_updated_at`, `update_settings_updated_at`; `on_auth_user_created`; three AI updated-at triggers; `update_category_email_templates_updated_at`; `update_category_suburb_search_state_updated_at`; `leads_set_normalized_email`; final `leads_refresh_data_quality`; and `leads_clear_outreach_suppression_on_email_change`. Production additionally has the reconstructed `update_category_suburb_priorities_updated_at` and live-only `normalize_lead_fields_trigger`. All 18 relevant non-internal triggers, including four excluded-product triggers, are enabled in normal/origin mode; exact definitions and ordering implications are in section 16.

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

Production RLS/policies/grants are captured exactly in the verified dump and catalog addendum. Their presence does not make them suitable for V2: approval still requires positive/negative tests as anon, user, active/inactive admin, and service role, plus remediation of the specific exposure findings in section 16.

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

- Freeze 001–054 unchanged as V1 history; document invalid 041 and the end of V1 at 054.
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

Design gates complete in this prompt:

1. **COMPLETE** — non-empty schema-only dump/catalog evidence is hashed and data-free.
2. **COMPLETE FOR BASELINE DESIGN** — ReachAgent ownership boundary is catalog-supported; unrelated WhatsApp/bookings objects remain excluded.
3. **COMPLETE** — 041 shape, strengthened nullability/check, indexes, trigger, RLS posture and sparse semantics are decided.
4. **COMPLETE** — canonical ten-status contract and cross-layer source-of-truth rule are decided.
5. **COMPLETE AS A MIGRATION RULE** — deterministic exact/alias/ambiguous/unmatched classification and rejection rules are decided. Producing per-class data counts is a Prompt 6/data-rehearsal acceptance check, not a remaining design choice.
6. **COMPLETE** — global and category/location authorities are selected.
7. **COMPLETE FOR DESIGN** — the verified dump contains no unexplained owned-schema catalog gap.
8. **COMPLETE** — least-privilege RLS/ACL/default-privilege and SECURITY DEFINER contracts are decided.
9. **COMPLETE** — seed boundaries, stable-ID rules and excluded ephemeral data are decided.

Build, validation and cutover gates intentionally remain future execution work: clean disposable restore/catalog diff; sanitized data rehearsal; generated types/build/feature tests; and separate backup/freeze/cutover/rollback/monitoring approval. These do not block starting Prompt 6 in a disposable environment.

Any failed gate blocks cloning; it does not authorize production patching.

## 13. Catalog coverage

The verified dump and read-only catalog queries now cover exact public/extension relations and columns, defaults/nullability, PK/FK/check/unique definitions, indexes and predicates, public function bodies and attributes, public triggers, the ReachAgent auth trigger, RLS enable/FORCE state, policies, grants/default privileges/owners, installed extensions, and all three public view definitions. There are no public or extensions sequences. All 115 constraints are validated; all 113 indexes are valid and ready.

The Supabase migration ledger was not dumped because it is outside the requested schemas and is unnecessary for live-object reconstruction. Index usage statistics were intentionally not queried; usage is operational telemetry, not schema. Section 16 records the repository/live differences that remain design decisions.

## 14. Final answers

1. Existing migrations cannot safely create V2; 041 is invalid and required schema is missing.
2. Production is not repository-reproducible.
3. ReachAgent owns the 25 listed tables; ten WhatsApp/bookings objects are unrelated by current evidence.
4. Section 2 gives the complete provable 041 contract and deterministic V2 DDL; byte-exact history/catalog-only details are unrecoverable without catalog access.
5. Canonical compatibility statuses are the ten in section 3; exclude `closed_won` and `dm_queued`.
6. Category drift is severe: 2,884/2,992 null FKs; 2,622 outreach-active; all 108 non-null rows valid/name-consistent.
7. Remediate by reviewed unique name/alias mapping in staging; quarantine ambiguity; only later enforce non-null.
8. Use IDs/normalized joins, separate global/category priority and runtime state, and one city-scope authority.
9. Exact live catalog objects are captured; the repository/live divergences and unsafe ACL/RLS choices are documented in section 16.
10. The golden baseline is curated owned schema plus final verified catalog objects and minimal seeds—never historical repairs/unrelated objects.
11. Freeze 001–054; V2 starts separate baseline/history.
12. Prove it via disposable restore, catalog/RLS diff, fixtures, generated types, application tests and data rehearsal.
13. Do not alter production, migrations, or deployments and do not implement V2 now.

## Historical Prompt 3 completion record

GOLDEN BASELINE DESIGN COMPLETE

Existing files modified: 0  
Production database changes: 0  
Production data changed: 0  
Migrations applied: 0  
Deployments performed: 0

Files created during Prompt 3:

- `docs/reachagent-supabase-schema-audit.md`
- `docs/reachagent-v2-golden-baseline-design.md`

At the time of Prompt 3 no safe successful schema-only dump was obtained. This historical statement is superseded by the successful read-only catalog validation in section 16.

## 15. Historical failed catalog attempt (14 September 2026)

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
| PostgREST catalog schemas | Not exposed: zero-row requests against both `pg_catalog` and `information_schema` returned `PGRST106` (`Invalid schema`). No business rows were requested or exported. |
| Native PostgreSQL clients | `psql` and `pg_dump` are not installed or discoverable. |
| Supabase CLI | Not installed globally; runnable through `npx`. |
| Docker | No working Docker command/engine is available. Supabase CLI 2.116.0 therefore cannot run its remote dump helper. |
| Supabase Dashboard / SQL Editor | No in-app or connected browser session was available, so there was no authenticated dashboard path for read-only catalog SQL. |

The read-only command `supabase db dump --linked --schema public,extensions` was attempted again using a temporary candidate path. It reached the remote-dump setup and then failed with the CLI's Docker prerequisite error; the candidate was zero bytes and was removed. The tracked `docs/reachagent-live-schema-only.sql` remains the same zero-byte file already present in `HEAD`. It is a pre-existing placeholder, not a successful dump, and is excluded from all readiness evidence.

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

## 16. Successful production catalog validation (14 September 2026)

This section supersedes section 15. Docker became available and the requested linked dump succeeded. Production remained read-only throughout: the main artifact was created by `pg_dump --schema-only`; the supplementary catalog queries ran inside transactions that reported `transaction_read_only=on`; no business table was queried.

### Verified artifact and coverage

- Artifact: `docs/reachagent-live-schema-only.sql`
- Size: 211,398 bytes
- SHA-256: `5C1FFE0835E08AFCFA71D8B2BE18695661944F934A53D7F363111EE841A16F24`
- Data scan: no `COPY`, `INSERT INTO`, or psql COPY terminator records
- Server: PostgreSQL 17.6
- Public catalog: 32 tables, 3 views, 43 functions, 68 standalone indexes, 17 non-internal triggers, and 58 policies
- Constraint/index state: 115/115 constraints validated; 113/113 total indexes valid and ready
- RLS: enabled on 30/32 public tables; FORCE RLS on 0 tables
- Sequences: none in `public` or `extensions`

The 32 public tables are exactly the 25 ReachAgent-owned tables in section 1 plus the seven excluded WhatsApp/bookings tables. The three views are exactly the three excluded WhatsApp/bookings views. The dump is the exact source for every table column, type, collation, nullability, default, owner, comment, PK/FK/check/unique definition, index expression/predicate, public function body, public trigger definition, policy expression, ACL/default privilege, and view definition. The temporary auth dump and catalog query additionally confirm `auth.users.on_auth_user_created` and all trigger enable modes.

### Installed extensions

| Extension | Version | Schema | Owner |
|---|---:|---|---|
| `pg_stat_statements` | 1.11 | `extensions` | `postgres` |
| `pg_trgm` | 1.6 | `public` | `supabase_admin` |
| `pgcrypto` | 1.3 | `extensions` | `postgres` |
| `plpgsql` | 1.0 | `pg_catalog` | `supabase_admin` |
| `supabase_vault` | 0.3.1 | `vault` | `supabase_admin` |
| `uuid-ossp` | 1.1 | `extensions` | `postgres` |

`pg_trgm` being installed in `public` explains the live `public.gin_trgm_ops` indexes and the previously unexplained `show_limit()`/`show_trgm(text)` API metadata. Those routines are extension members and are omitted from schema-only pg_dump output rather than ReachAgent-owned functions. V2 should install `pg_trgm` in a deliberately selected schema and generate its indexes against the resulting qualified opclass; it should not hand-copy extension functions.

### Migration 041: exact live result

| Object | Exact live catalog result | Comparison with section 2 candidate |
|---|---|---|
| `city_suburbs.last_used_at` | nullable `timestamptz`, no default | MATCH |
| `city_suburbs.priority` | nullable integer, default `1`, **no check constraint** | DIFFERENT: proposed V2 check is a strengthening |
| Priority table columns | UUID `id DEFAULT gen_random_uuid()`; non-null UUID FKs; non-null integer `priority`; non-null timestamps `DEFAULT now()` | MATCH |
| Priority bound | `category_suburb_priorities_priority_check`, inclusive 1-10 | MATCH |
| Pair uniqueness | `category_suburb_priorities_category_suburb_unique` on `(category_id, city_suburb_id)` | MATCH |
| FKs | named FKs to `categories(id)` and `city_suburbs(id)`, both `ON DELETE CASCADE` | MATCH |
| Reverse index | `category_suburb_priorities_city_suburb_idx` on `city_suburb_id` | MATCH |
| Trigger | `update_category_suburb_priorities_updated_at`, BEFORE UPDATE, row-level, calls `update_updated_at_column()`; enabled in origin mode | MATCH |
| RLS/policies | enabled, not forced; authenticated read; `is_active_admin()` manage; service-role manage | MATCH the intended policy family |

The historical file `041_category_suburb_priorities.sql` remains the invalid token `cl` and was not changed. The live objects now make 041 catalog-reconstructable. A live-equivalent reconstruction must omit the proposed `city_suburbs_priority_check`; a deliberately strengthened V2 contract may include it only after approval and a data preflight.

### Exact live lead-status constraint

`leads_status_check` is:

```sql
CHECK (status = ANY (ARRAY[
  'new', 'researched', 'email_ready', 'contacted', 'replied',
  'negotiating', 'closed', 'closed_manual', 'dead'
]))
```

It exactly matches final historical migration 012. It does not accept `interested`, `closed_won`, or `dm_queued`. The ten-status recommendation in section 3 deliberately adds `interested`, so it is a V2 product decision rather than a live-equivalent baseline fact.

### Function/RPC body reconciliation

The repository contains 40 public function names and production contains all 40. After normalizing pg_dump quoting/whitespace, 39 final repository bodies match production. This includes every ReachAgent RPC and all post-cutoff migration 053-054 functions: `claim_recipient_outreach`, `release_recipient_outreach_claim`, `clear_lead_outreach_suppression_on_email_change`, and the final seven-argument `get_leads_search_page` are live and match their final repository definitions.

One repository function is different live:

- `handle_new_auth_user()` is `DIFFERENT`. Migration 009 assigns `member` unless `app.admin_email` matches. Live instead falls back to `COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'role', ''), 'member')`. Because the live function is SECURITY DEFINER and creates `profiles`, copying this fallback could allow caller-controlled signup metadata to select `admin`, depending on the Auth signup surface. V2 must not copy this behavior without an explicit security decision; the recommended contract ignores user-supplied role metadata.

Production also has three `LIVE ONLY` public functions:

- `normalize_lead_fields()` trims `leads.business_name` and `leads.email` and converts empty strings to null. It is ReachAgent-affecting and paired with a live-only trigger.
- `set_updated_at()` and `update_customer_on_message()` support only the excluded WhatsApp/bookings objects.

All public functions are owned by `postgres`. The dump records identity arguments, results, language, volatility/parallel flags, security mode, search path, and ACLs. Several SECURITY DEFINER routines are executable by `anon`; that is a V2 security blocker even where bodies match.

### Trigger reconciliation

There are 18 relevant non-internal triggers across `public` and the ReachAgent auth integration; all report enabled mode `O` (normal/origin). Four belong only to excluded WhatsApp/bookings tables. The 14 ReachAgent-affecting triggers are:

- `auth.users`: `on_auth_user_created` -> `handle_new_auth_user()`;
- AI/config: the three AI updated-at triggers, category/template/search-state/priority updated-at triggers, plus settings updated-at;
- leads: `update_leads_updated_at`, `leads_set_normalized_email`, `leads_refresh_data_quality`, `leads_clear_outreach_suppression_on_email_change`, and live-only `normalize_lead_fields_trigger`.

All repository trigger definitions match live. The two ReachAgent `LIVE ONLY` definitions are the reconstructed priority updated-at trigger and `normalize_lead_fields_trigger`. The latter runs BEFORE INSERT OR UPDATE OF `business_name,email`; on email updates its name sorts before `leads_set_normalized_email`, so normalized-email derivation sees the trimmed/null-normalized value.

### RLS, policies, grants, and ACL findings

For the 25 ReachAgent tables, RLS is enabled on 23 and disabled on `city_suburbs` and `distributed_locks`; no table uses FORCE RLS. `discovery_run_metrics` has RLS enabled but no policy. There are 51 ReachAgent policies. Repository policy intent matches live except for the three now-reconstructed priority-table policies and an additional `profiles."Users can view own profile"` SELECT policy with no explicit role, duplicating the authenticated-only `Users can read own profile` predicate for PUBLIC.

Exact policy SQL and all ACLs are retained in the dump. Material security findings are:

- `city_suburbs` and `distributed_locks` have RLS disabled while `anon`, `authenticated`, and `service_role` each have table `ALL`;
- core operational tables grant object-level `ALL` to `anon`; RLS blocks row access where enabled, but this is unnecessary exposure and fragile if RLS changes;
- default privileges grant `ALL` on future public tables, functions, and sequences to `anon`, `authenticated`, and `service_role`;
- many functions, including multiple SECURITY DEFINER reporting/mutation functions, explicitly grant execute to `anon`;
- authenticated full-access policies on shared core tables are not tenant-isolated and cannot be copied into a multi-tenant SaaS baseline;
- the extra PUBLIC profile policy and the live auth-role metadata fallback require removal or explicit justification.

These are catalog findings only; production was not changed.

### Views and ownership boundary

The live views are `v_bookings_full`, `v_conversation_thread`, and `v_daily_summary`; their exact definitions join or aggregate only the excluded WhatsApp/bookings tables. No ReachAgent function, trigger, FK, view, or repository caller depends on those seven tables or three views. The section 1 exclusion boundary is therefore catalog-confirmed, subject only to named-owner governance approval.

### Baseline readiness decision

The catalog itself is complete enough to draft a curated V2 baseline, but the golden baseline is **NOT READY for approval or application**. Remaining blockers are now design/security gates rather than missing catalog evidence:

1. approve a safe `handle_new_auth_user()` contract and reject caller-controlled role elevation;
2. decide whether to reproduce or strengthen `city_suburbs.priority`, with a null/out-of-range preflight before adding a check;
3. approve the canonical status set and reconcile DB, TypeScript/UI, jobs, and RPC assumptions for `interested`/`closed_won`;
4. replace broad anon/authenticated ACLs, default privileges, SECURITY DEFINER execute grants, and non-tenant policies with an approved least-privilege matrix;
5. decide the V2 treatment of live-only `normalize_lead_fields()`/trigger and its ordering with normalized-email logic;
6. complete the category-ID remediation, named ownership approval, seed design, disposable restore/catalog diff, role tests, and data rehearsal already required by sections 4 and 8-12.

No V2 golden baseline migration was created.

## Current catalog validation completion record

CATALOG VALIDATION COMPLETE

Production schema changes: 0
Production data changes: 0
Historical migrations changed: 0
Migrations applied: 0
Deployments performed: 0

Schema-only dump:
SUCCESS

GOLDEN BASELINE STATUS:
NOT READY

Remaining blockers:
The six design, security, remediation, approval, and restore-test gates listed immediately above. No live-catalog blocker remains.

## 17. Final golden-baseline decisions (Prompt 5)

This section is the final, controlling design contract. Every item below is **DECIDED**. Historical `UNVERIFIED` and `NOT READY` statements in sections 15 and 16 record the state of earlier prompts and do not describe the current approval state.

### 17.1 Auth profile and role bootstrap — DECIDED

Use Option A. `handle_new_auth_user()` always inserts `role = 'member'` and `is_active = true`; it never derives privilege from `raw_user_meta_data`, `user_metadata`, email domain, or any caller-supplied signup field. `full_name` may be copied as non-authoritative display data. Auth metadata is untrusted for authorization, including when it contains a field named `role`.

The first admin is promoted once by an authenticated deployment operator through a service-role-only, audited bootstrap procedure after matching the intended, verified Auth user ID/email. The bootstrap path is disabled or removed after use. Thereafter, only an active admin through a dedicated guarded role-management RPC, or an audited service-role recovery procedure, may change `profiles.role` or `is_active`. Users cannot update either field on their own profile. The RPC must derive the actor from `auth.uid()`, call `is_active_admin()`, accept a target user ID and enumerated role, prevent removal of the last active admin, and append an audit event. No client-supplied actor ID is trusted.

RLS permits a user to read their own profile, active admins to read profiles needed for administration, and only the guarded admin/service paths to change roles. `PUBLIC`/`anon` receive no profile access and no direct EXECUTE on the Auth trigger function.

### 17.2 `city_suburbs.priority` — DECIDED

Use Option B:

```sql
priority integer NOT NULL DEFAULT 1
  CHECK (priority BETWEEN 1 AND 10)
```

The V2 database is new, so the stronger invariant is safe for its empty baseline and matches the category-specific 1–10 scale, Finder weighting, and Settings UI. Before Aussie Venture import, report `count(*)`, null count, below-1 count, and above-10 count from the source snapshot. Import maps null to `1` explicitly because current application semantics treat null as 1. Zero/negative or above-10 values are rejected and listed for review; they are never clamped silently. No production query is needed to make this schema decision and no production value is changed here.

### 17.3 Canonical lead lifecycle — DECIDED

| Status | Decision | V2 meaning/mapping |
|---|---|---|
| `new` | KEEP | Discovered but not researched. |
| `researched` | KEEP | Research completed. |
| `email_ready` | KEEP | Initial outreach content is ready. |
| `contacted` | KEEP | Initial outreach sent. |
| `replied` | KEEP | A reply exists, without a qualified positive intent decision. |
| `interested` | ADD | Positive intent is confirmed but commercial negotiation has not begun; distinct from generic `replied` and `negotiating`. |
| `negotiating` | KEEP | Terms or deal are being actively negotiated. |
| `closed` | KEEP | Successful terminal outcome; remains compatible with live data and deals/payment/content fields. |
| `closed_manual` | KEEP | Manual terminal override; live rows and cancellation/side-effect behavior depend on it. |
| `dead` | KEEP | Unsuccessful/no-further-action terminal outcome. |
| `closed_won` | MERGE | Map to `closed`; it duplicates successful closure and has no live rows. |
| `dm_queued` | LEGACY ONLY | Never a lead lifecycle value in V2; queue state belongs in `dm_queue.status`. |

The final ordered V2 list is:

```text
new, researched, email_ready, contacted, replied,
interested, negotiating, closed, closed_manual, dead
```

That exact order and spelling must be represented once as the canonical application constant and mirrored exactly by the DB `CHECK`, TypeScript union, Zod/API schemas, UI selectors/labels, lifecycle transitions, Trigger/RPC filters, reports, tests, and generated Supabase types. APIs reject unknown status values before SQL. Existing `closed_won` import values, if any appear outside the verified live rows, map to `closed`; `dm_queued` maps only to the DM queue and never to `leads.status`. The `deals` row and payment/content fields remain commercial detail, not competing lead status vocabularies.

### 17.4 V2 RLS, ACL and grants — DECIDED

V2 is single-tenant but role-separated. Policies must be written so a future `workspace_id` predicate can be added without changing the role model. All 25 ReachAgent tables have RLS enabled. Do not use FORCE RLS in this baseline: object owners are migration/maintenance principals and application traffic must never use the owner role. Reconsider FORCE RLS when workspace isolation is implemented and tested. `service_role` remains a secret backend capability and is never shipped to browsers.

Object grants and RLS are both least-privilege; a grant alone never implies row access. `anon` receives no table, sequence, view, or ReachAgent function privileges. There is no public operational endpoint in the owned schema. Public signup uses Supabase Auth, not an anonymous `public` table policy.

| ReachAgent table group | `anon` | Authenticated member | Admin | `service_role` |
|---|---|---|---|---|
| `leads` | none | SELECT, INSERT, UPDATE; no DELETE; RLS requires active profile | SELECT, INSERT, UPDATE, DELETE | backend CRUD |
| `emails` | none | SELECT only | SELECT; operational corrections only through guarded APIs | backend CRUD/send-state management |
| `follow_ups`, `dm_queue`, `deals` | none | SELECT, INSERT, UPDATE; no DELETE | full management | backend CRUD |
| `activity_log` | none | SELECT and INSERT; append-only | SELECT and INSERT; no UPDATE/DELETE | SELECT/INSERT and retention maintenance only |
| `categories`, `category_email_templates` | none | SELECT | full management | backend CRUD |
| `settings` | none | SELECT only for an explicit allowlist of non-secret keys; secrets must not be rows readable by clients | manage non-secret settings | backend management; secrets remain outside versioned/client-readable data |
| `city_suburbs`, `category_suburb_priorities` | none | SELECT | full management | backend CRUD |
| `category_suburb_search_state`, `exhausted_queries`, `search_cache`, `discovery_run_metrics` | none | none | SELECT for diagnostics; no direct mutation | backend CRUD/maintenance |
| `profiles` | none | SELECT own row; update only non-privileged display fields through a guarded path | user administration through guarded RPC | recovery/bootstrap management |
| `lead_data_quality_flags` | none | SELECT | SELECT plus guarded resolution/remediation actions | backend CRUD/refresh |
| `recipient_outreach_ownership` | none | SELECT | SELECT/diagnostics | backend claim/release management |
| lead suppression fields/actions | none | visible with permitted lead reads; no direct suppression mutation | guarded operational action | backend mutation |
| `ai_providers`, `ai_models`, `ai_workflow_configurations` | none | SELECT enabled/non-secret configuration | full management | backend CRUD |
| `ai_request_logs` | none | none | SELECT through bounded analytics/reporting | backend INSERT/retention; no client mutation |
| `inbound_receipts`, `dead_letter_queue` | none | none | SELECT for support through guarded/bounded views or APIs | backend CRUD/retry management |
| `distributed_locks` | none | none | diagnostic read through a guarded API only | backend CRUD |

Member INSERT/UPDATE policies must require an active profile and constrain allowed columns; use RPCs where PostgreSQL column grants cannot express the business transition. Admin policies require `is_active_admin()`, not a JWT/user-metadata role. Service access is used only by trusted server/background code. Future SaaS adds `workspace_id` to rows and policy predicates while retaining these capability boundaries.

Default privileges for the baseline owner revoke all tables, sequences and functions from `PUBLIC`, `anon`, and `authenticated`. Revoke `CREATE` on schema `public` from `PUBLIC`, `anon`, and `authenticated`; retain it only for migration/platform owners. Future objects receive no client privilege automatically. Grant each approved table operation and function EXECUTE explicitly. `service_role` privileges are explicit too, even though the platform role can bypass RLS, so intent is auditable. Trigger/helper functions that are not RPCs have EXECUTE revoked from `PUBLIC`, `anon`, and `authenticated`.

All SECURITY DEFINER routines must set a fixed trusted `search_path` (prefer `pg_catalog, public`, qualify non-catalog objects, and never include user-writable schemas), have a non-login owner, and have `PUBLIC` execution revoked before role-specific grants. They validate enum/range/cardinality inputs, derive actor identity from `auth.uid()` where applicable, and never accept a caller-supplied authorization identity. No SECURITY DEFINER function is callable by `anon`.

### 17.5 Live-only lead normalization — DECIDED

Keep database normalization plus application validation. Application/API validation gives early feedback; the DB trigger provides a canonical invariant for imports, service jobs, and future writers. On every insert or update of `business_name` or `email`, trim surrounding whitespace and convert the empty result to null. `normalized_email` is then derived from the post-normalization `email` value.

Make ordering structural instead of relying only on alphabetical trigger names: the preferred baseline is one combined BEFORE trigger that normalizes `business_name`/`email` and then assigns `normalized_email`. If separate triggers are retained for fidelity, create/name them so normalization executes first and add a trigger-order test. The normalization function is trigger-only and receives no direct client EXECUTE grant.

### 17.6 Category-ID remediation — DECIDED

Use this deterministic import algorithm for each lead whose `category_id` is null:

1. Normalize its `category_name` and every category name with Unicode normalization, trim, collapse internal whitespace, and locale-stable lowercase. Do not use fuzzy matching.
2. **Auto-map** only when the normalized value matches exactly one category.
3. If no exact match, consult a version-controlled, reviewed alias table of `normalized_alias -> category_id`. **Alias-map** only when the alias resolves to exactly one current category.
4. **Ambiguous** means an exact normalized name or reviewed alias resolves to more than one category, or evidence conflicts. Do not select one.
5. **Unmatched** means neither unique exact nor reviewed alias resolution exists. Do not invent a category.

The preflight artifact is a CSV/JSON report with source lead ID, original and normalized category name, classification, candidate category IDs/names, match rule (`exact` or alias identifier/version), proposed category ID, source/status, and reason. A summary reports counts by classification, status and source, plus count conservation. Reviewed aliases require an owner, rationale, and effective version; aliases are migration input, not implicit runtime fuzzy logic.

Only Auto-map and approved Alias-map rows are backfilled in the staged V2 import. Ambiguous and Unmatched rows block the final `NOT NULL` validation until explicitly mapped or quarantined under an approved business rule. `category_name` remains denormalized display/snapshot data for compatibility and is synchronized from `categories.name` during import; `category_id` is authoritative. The final V2 target requires `category_id NOT NULL`, but the baseline may create it nullable so the staged import can classify and load data before a later validated incremental constraint. No arbitrary fallback category is permitted.

### 17.7 Category/location authority — DECIDED

Use the smallest compatibility model:

- Global city authority is `settings.active_cities`; it selects the active cities Finder may use. A later normalized cities table is optional, not part of this baseline.
- `city_suburbs.active` defines the allowed suburb set within those global cities.
- Category-specific priorities reorder only that active global suburb set; missing category-priority rows inherit the global priority. They do not grant or remove suburb eligibility.
- `categories.cities` and `categories.custom_cities` are retained for import/API compatibility but are non-authoritative and must be labelled deprecated/non-operative in V2 UI/API documentation. Do not expose them as if Finder honors them. A future category restriction, if needed, uses a normalized join table.
- `categories.use_priority_suburbs` remains the switch for category weighting behavior.
- `categories.content_type` remains the category default and `categories.city_content_types` remains the per-city override, because Finder currently consumes both.
- `category_suburb_search_state` remains runtime cooldown state, separate from allowed locations and priority configuration.

### 17.8 Seed and data-import strategy — DECIDED

| Class | Treatment | Stable IDs |
|---|---|---|
| Baseline reference/config | Seed only universal, secret-free definitions required for an empty system: supported AI provider keys/definitions and stable workflow keys/default schema definitions. Use idempotent natural-key upserts. | Stable natural keys are mandatory; preserve UUIDs only where code or dependent seeded rows reference them. |
| Aussie Venture business data | Import later: categories, category templates, sanitized business settings, city/suburb rows and priorities, AI model/workflow selections. Never embed secrets in baseline SQL. | Preserve category, template, city/suburb and referenced AI configuration UUIDs to keep FKs/audit continuity. |
| Operational data | Separate staged import: Auth/profile IDs, leads, emails, follow-ups, DM queue, deals, activity, suppression/quality state, recipient ownership, required inbound-receipt idempotency records. | Preserve all PKs/FKs, event/provider IDs, timestamps and idempotency keys. |
| Rebuild/discard | Do not migrate active/expired distributed locks, search cache, expired exhausted-query state, or temporary discovery state. Reset category search cooldown unless an explicit cutover runbook requires continuity. Retain AI logs, discovery metrics and DLQ only under an approved retention/export policy, otherwise archive outside the operational V2 database. | No operational ID stability requirement unless retained for an approved audit archive. |

Baseline seeds and customer import are separate artifacts. Both are idempotent, dependency ordered, and verified secret-free. No historical repair migration is replayed as a seed.

### 17.9 Historical migrations — DECIDED

Keep migrations `001`–`054` untouched in their current folder as the frozen V1 historical record for now. Configure V2 tooling/project metadata to use a new, separate V2 migration root so it can never discover or replay V1 files. Prompt 6 creates the first immutable V2 golden baseline in that root; all later V2 changes are incremental migrations there. Add documentation identifying the roots and invalid historical 041. A later move to a `legacy/v1` folder is optional repository housekeeping and must preserve Git history; it is not required for V2 and is not done in this prompt. Do not keep V1 only on a branch because that weakens day-to-day auditability.

### 17.10 SECURITY DEFINER review — DECIDED

The verified dump contains these 15 ReachAgent SECURITY DEFINER functions. “Current roles” lists explicit live grants; these grants are evidence, not the V2 recommendation. Trigger-only functions continue to run through their triggers after direct EXECUTE is revoked. Because application admins are profile roles rather than PostgreSQL roles, `ADMIN ONLY` means EXECUTE is granted to `authenticated` but the function performs an immediate in-body `is_active_admin()` check; `service_role` is granted separately. `AUTH ONLY` means any active authenticated profile may execute it.

| Function | Purpose | Current roles | V2 class / EXECUTE | Scope and validation decision |
|---|---|---|---|---|
| `claim_hostinger_inbound_receipt` | Atomically claim/reclaim an inbound receipt | service | SERVICE ONLY | Receipt ID/run ID/stale cutoff are adequately operation-scoped when only trusted workers call it; validate non-empty run ID and bounded stale cutoff. |
| `claim_recipient_outreach` | Atomically claim recipient ownership for an outreach phase | anon, authenticated, service | SERVICE ONLY | Phase enum is validated and lead is locked; future workspace predicate is required when tenancy arrives. |
| `clear_lead_outreach_suppression_on_email_change` | Trigger helper to recompute suppression | anon, authenticated, service | SERVICE ONLY (trigger-only; no direct client EXECUTE) | No caller parameters; qualify all objects and run only from the lead trigger. |
| `get_ai_request_analytics` | Read AI-log analytics | anon, authenticated, service | ADMIN ONLY (also service) | Existing admin/service predicate is sound; validate time order and cap `recent_limit` to an approved range. |
| `get_data_quality_report` | Legacy paginated quality report | anon, authenticated, service | ADMIN ONLY (also service) | Read-only but exposes operational data; cap page/page-size and validate issue type. Retain only if a caller still requires v1. |
| `get_data_quality_report_v2` | Current searchable quality report | anon, authenticated, service | ADMIN ONLY (also service) | Validate issue type and bounded pagination; future workspace predicate required. |
| `get_data_quality_summary` | Quality counts/summary | anon, authenticated, service | ADMIN ONLY (also service) | No input parameters; definition must use the final canonical statuses and future workspace predicate. |
| `handle_new_auth_user` | Auth trigger creates profile | anon, authenticated, service | SERVICE ONLY (trigger-only; no direct client EXECUTE) | Ignore all role metadata; fixed member role; qualify objects; non-login owner. |
| `is_active_admin` | Policy helper for current user's active-admin state | anon, authenticated, service | AUTH ONLY (and service) | Safe boolean result; identity is derived only from `auth.uid()` and profile row. Anon EXECUTE is unnecessary. |
| `refresh_email_group_quality` | Internal grouped-email quality refresh | anon, authenticated, service | SERVICE ONLY (internal/trigger path) | Normalize input email and constrain affected rows; later add workspace scope. |
| `refresh_lead_data_quality` | Internal per-lead quality refresh | anon, authenticated, service | SERVICE ONLY (internal/trigger path) | Lead ID scopes the operation; later add workspace scope. |
| `release_recipient_outreach_claim` | Token-protected ownership release | anon, service | SERVICE ONLY | Normalized email plus lead ID and claim token adequately scope release for trusted workers; future workspace scope required. |
| `remove_data_quality_emails` | Destructive remediation of selected leads | anon, service | NEEDS REDESIGN, then ADMIN ONLY (and service) | Existing cardinality/lead checks help, but caller-supplied `p_actor_id` is not authorization. Derive actor from `auth.uid()`, require active admin, audit, and keep the 1–100 bound. |
| `set_data_quality_flag_status` | Resolve/reopen quality flags | anon, service | NEEDS REDESIGN, then ADMIN ONLY (and service) | Existing enums help, but derive actor from `auth.uid()`, validate selected IDs belong to the addressed group, audit the transition, and add future workspace scope. |
| `trigger_refresh_lead_data_quality` | Trigger dispatcher for quality refresh | anon, authenticated, service | SERVICE ONLY (trigger-only; no direct client EXECUTE) | No caller parameters; schema-qualify nested calls and expose only through trigger execution. |

No function is `PUBLIC SAFE`; ReachAgent has no anonymous RPC requirement. `normalize_lead_fields()` is not SECURITY DEFINER in the verified dump and is covered as a trigger-only helper in section 17.5. All reporting functions that remain SECURITY DEFINER rely on both explicit grants and in-body role/workspace guards; a missing guard is repaired in the baseline definition, not compensated for by trusting PostgREST exposure.

### 17.11 Final decision matrix

| Decision | Final choice | Reason | Baseline impact |
|---|---|---|---|
| Auth role bootstrap | Always member; one-time audited service bootstrap; later active-admin RPC | Signup metadata is caller-controlled and cannot confer privilege | Replace live fallback; guarded role mutation only |
| City suburb priority | Non-null integer 1–10, default 1 | Consistent invariant and Finder/UI semantics | Stronger column/check; staged null-to-1 import rule |
| Lead statuses | Ten ordered values including `interested`; merge `closed_won` to `closed`; exclude `dm_queued` | Preserves live behavior and a meaningful positive-intent state without duplicate terminal/queue states | One DB/app/API/UI/RPC contract |
| Anon access | None to ReachAgent tables/functions/views/sequences | No owned public data path is required | Revoke all anonymous/public grants |
| Authenticated access | Active-member operational CRUD without destructive deletes; read-only configuration; no infrastructure/log access | Supports staff workflow with bounded blast radius | Explicit grants plus active-profile RLS |
| Admin access | Business/config management and guarded sensitive actions; infrastructure mostly diagnostic | Separates management from worker internals | `is_active_admin()` policies and guarded RPCs |
| Service access | Trusted backend/background operational access only | Claims, sends, receipts, cache and locks need server authority | Explicit service grants; secret never reaches clients |
| Default privileges | No automatic client grants | Prevents future objects becoming exposed accidentally | Revoke defaults; grant per object |
| SECURITY DEFINER | No anon; fixed path/owner; explicit matrix; redesign actor-taking mutations | Definer rights must not bypass identity and RLS accidentally | Harden 15 routines and revoke helper EXECUTE |
| Lead normalization | DB normalization plus application validation; normalization precedes derived email | Protects every write path and removes trigger-order ambiguity | Combined/preordered BEFORE trigger |
| Category-ID remediation | Deterministic exact/approved-alias mapping; block ambiguity; final target non-null | Avoids corrupt fuzzy or arbitrary mappings | Nullable load phase plus later validated NOT NULL |
| Category/location authority | Global active cities + active suburbs; category priorities reorder only; existing content overrides remain | Matches Finder with minimal redesign | Mark category city arrays non-operative/deprecated |
| Seed strategy | Minimal universal reference seeds; customer and operational data imported separately; ephemeral state rebuilt | Keeps baseline reusable, secret-free and deterministic | Separate idempotent seed/import artifacts |
| Historical migrations | Freeze 001–054 in place; separate V2 migration root | Safest audit trail and prevents replay of broken history | Prompt 6 starts only the V2 root |

### 17.12 Readiness outcome

All design and security choices requested by Prompt 5 are resolved. No additional production evidence is required to begin constructing and restoring the baseline in a disposable environment. Prompt 6 must still perform the source priority aggregate, category-mapping report, disposable restore/catalog diff, role-negative tests, and synthetic/application validation before any later data migration or cutover approval.

**GOLDEN BASELINE DESIGN STATUS: READY TO BUILD**

Remaining blockers to building the baseline: none.
Remaining gates after it is built: disposable verification, staged data rehearsal, application compatibility tests, and separately approved production cutover controls.
