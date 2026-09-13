# ReachAgent Supabase live-schema reconciliation audit

Audit date: 8 September 2026 (Australia/Sydney)  
Scope: production Supabase `public` API schema versus the 52 checked-in files in `supabase/migrations`, plus current application/agent callers.  
Mode: read-only. No database or repository object was changed; this report is the only file created.

## Executive conclusion

**A fresh V2 project cannot safely be built by replaying the repository migrations today.** Replay reaches migration 041, whose entire two-byte content is the invalid SQL token `cl`, and stops. Even if 041 were skipped, the clone would omit the live `category_suburb_priorities` table and the live `city_suburbs.last_used_at` and `city_suburbs.priority` columns on which Finder and Settings depend.

Production is therefore **not reproducible** from the repository. The exposed live column shapes of all other ReachAgent tables agree with the migration-derived shapes, but direct PostgreSQL catalog access was unavailable, so live index definitions, check/unique constraint bodies, trigger bodies, and RLS policy definitions could not be independently extracted. Those areas are explicitly marked unverified rather than guessed.

The other critical finding is real lead-category drift. The shared Finder insertion used for both Google Places and Outscraper writes `category_name` but not `category_id`. Read-only production counts found 2,884 of 2,992 leads (96.4%) with `category_id IS NULL`; 2,622 of those are `email_ready` or `contacted`. Manual creation and CSV import do set `category_id`. All 108 non-null category references resolve to a live category and their denormalized `category_name` matches.

## Evidence, access, and limits

The audit used:

- all 52 checked-in SQL migration files, byte inspection of migration 041, and Git history;
- all application, Trigger.dev, agent, and test references to tables, columns, statuses, and RPCs;
- the live Supabase PostgREST OpenAPI document using the configured service-role credential (metadata only);
- read-only `HEAD ... Prefer: count=exact` aggregate queries, `get_lead_status_counts()`, and a category-FK consistency aggregate performed in memory without reporting row data.

The live API exposed tables, views, columns, types, defaults, nullability, PK annotations, FK annotations, and RPC argument signatures. It does **not** expose `pg_index`, `pg_constraint` check expressions, `pg_trigger`, `pg_policy`, function source bodies, sequences, or the migration ledger. No direct Postgres URL, Supabase management token, or pre-existing catalog-introspection RPC was available. Consequently:

- live indexes, exact unique/check constraints, triggers, sequences, RLS enablement/policies, function bodies, and applied migration versions remain **not directly verified**;
- live lead statuses reported as present prove that those values have been accepted, but absence of a status does not prove the current check rejects it;
- no enum types were visible in the API; migrations use `TEXT CHECK`, not PostgreSQL enums;
- no checked-in schema dump or generated `Database` TypeScript type exists.

## 1. Migration baseline

Order is filename order. `S` means schema/table/column, `I` index, `C` constraint/data contract, `F` function/RPC/trigger, and `R` RLS/policy.

| # | Migration | Purpose and affected objects |
|---:|---|---|
| 001 | `001_initial_schema.sql` | S: creates `categories`, `leads`, `emails`, `dm_queue`, `follow_ups`, `deals`, `activity_log`, `settings`, and seed rows. C: PKs, FKs and checks for category/location/content/status, lead channel/status/deal type, email type/status, DM platform/status, follow-up number/status, deal type, settings key unique. F: `update_updated_at_column`; update triggers on leads/categories/settings. R: enables RLS and gives **all authenticated users full CRUD** plus service-role full access on all eight tables. No secondary indexes. |
| 002 | `002_add_dm_limit.sql` | Data-only, idempotent setting seed `daily_dm_limit`. |
| 003 | `003_add_dm_queued_status.sql` | C: replaces `leads_status_check`, adding legacy `dm_queued`. Assumes `leads.status`. |
| 004 | `004_city_suburbs.sql` | S: creates/seeds `city_suburbs(id, city, suburb, active, created_at)`. No RLS, secondary index, or `(city,suburb)` uniqueness. |
| 005 | `005_exhausted_queries.sql` | S: creates `exhausted_queries`; seeds Outscraper setting. C: query PK. R: authenticated/service full access. |
| 006 | `006_increase_outscraper_limit.sql` | Data-only manual setting correction; exact-key update silently no-ops if key differs/missing. |
| 007 | `007_dead_letter.sql` | S: creates `dead_letter_queue`. R: authenticated/service full access. |
| 008 | `008_api_settings.sql` | S: creates `search_cache`; seeds API settings. I/C: unique `search_cache_query_idx`. R: authenticated/service full access. |
| 009 | `009_profiles_auth_rbac.sql` | S: creates `profiles` linked to `auth.users`. I: role, active. C: unique email, role check. F: `handle_new_auth_user`, trigger on `auth.users`. R: self-read/admin-read/service-manage. |
| 010 | `010_quota_orchestration_settings.sql` | Data settings; removes obsolete setting. C: email types gain FU3; follow-up number gains 3. Assumes initial tables/check names. |
| 011 | `011_add_halal_confidence_score.sql` | S: nullable integer `leads.halal_confidence_score`. |
| 012 | `012_add_closed_manual_and_halal_reasons.sql` | S: `leads.halal_reasons jsonb`. C: replaces lead status check, adds `closed_manual` but accidentally removes `dm_queued`. |
| 013 | `013_expand_halal_restaurant_keywords.sql` | Data-only category keyword update by exact category name; later superseded by 014. |
| 014 | `014_expand_category_keywords.sql` | Data-only keyword updates for five exact names; overlaps/supersedes 013 for Halal Restaurants. |
| 015 | `015_lead_filtering_settings.sql` | Idempotent settings seeds. |
| 016 | `016_add_use_priority_suburbs.sql` | S: `categories.use_priority_suburbs boolean NOT NULL default false`. |
| 017 | `017_reactivation_settings.sql` | S: `leads.reactivation_sent_at`; settings. C: email types gain `reactivation`. |
| 018 | `018_discovery_run_metrics.sql` | S: creates `discovery_run_metrics` and full funnel metrics. I: `run_at DESC` (without `IF NOT EXISTS`). No RLS. |
| 019 | `019_rename_daily_email_limit.sql` | Data-only rename by exact old key. On clean replay it no-ops because 001 already seeds the new key. |
| 020 | `020_followup3_delay_setting.sql` | Idempotent FU3 delay setting. |
| 021 | `021_add_lead_source.sql` | **Broken/no-op:** comment only; claims to add `leads.source` but contains no DDL. Repaired by 030. |
| 022 | `022_add_email_edit_tracking.sql` | S: nullable `emails.edited_at`; `edited_by_user boolean default false`. |
| 023 | `023_add_email_sync_failed_status.sql` | C: email status check gains `email_sync_failed`. |
| 024 | `024_unique_resend_id.sql` | C: unique `emails.resend_id`; data-dependent on no duplicate non-null IDs. |
| 025 | `025_expand_hotels_resorts_keywords.sql` | Data-only exact-name category keyword update. |
| 026 | `026_per_city_content_type.sql` | S: `categories.city_content_types jsonb`, `leads.content_type text`. C: lead content check. Data: backfills all null content types using legacy category/city rules. |
| 027 | `027_email_threading_and_dedup.sql` | S: `emails.message_id`. I: partial unique delivered `(lead_id,type)`. Data/manual fix: demotes duplicate delivered rows to `failed` and logs it before index creation. |
| 028 | `028_distributed_locks.sql` | S: creates `distributed_locks(lock_key PK, locked_at)`. No RLS. |
| 029 | `029_distributed_lock_owner_token.sql` | S: nullable `distributed_locks.owner_token`. |
| 030 | `030_backfill_lead_source_column.sql` | S: actually adds/comments `leads.source`; explicitly documents likely out-of-band production creation and repairs broken 021. |
| 031 | `031_daily_reactivation_limit.sql` | Idempotent setting seed. |
| 032 | `032_ai_configuration.sql` | S: creates `ai_providers`, `ai_models`, `ai_workflow_configurations`; seeds Anthropic/models/workflows. I: partial enabled model. C: provider key/workflow key unique and provider/model composite unique; FKs. F: three updated-at triggers. R: authenticated/service full access. Plain inserts are not replay-idempotent. |
| 033 | `033_add_openai_provider.sql` | Data-only plain provider/model inserts; not idempotent. |
| 034 | `034_add_gemini_provider.sql` | Data-only plain provider/model inserts; not idempotent. |
| 035 | `035_restrict_ai_configuration_writes.sql` | F: `is_active_admin`. R: replaces authenticated full access with read plus active-admin manage; service policies remain. |
| 036 | `036_ai_request_analytics.sql` | S: creates `ai_request_logs`. I: created/workflow/provider/status time indexes. C: status, non-negative metrics, time order, JSON object. F: `get_ai_request_analytics`. R: admin read, service manage. |
| 037 | `037_category_email_template_storage.sql` | S: creates `category_email_templates`, adds `emails.generation_source`, setting and seeds follow-up/reactivation templates. I: template type; conditional normalized category-name unique; partial one-pending-initial unique. C: category/template unique, template type, generation source, setting-value checks. F: updated-at trigger. R: authenticated read/admin manage/service. Conditional uniqueness silently skips when category duplicates exist; pending-email duplicates abort. |
| 038 | `038_database_query_foundation.sql` | I: lead status/date, city/status/date; email lead/date, status/sent, replied; activity lead/date, event/date. F: `get_lead_status_counts`. |
| 039 | `039_dashboard_summary.sql` | F: `get_dashboard_summary(timestamptz)`; large read-only dashboard aggregation dependent on current lead/email/activity fields and status vocabulary. |
| 040 | `040_lifecycle_navigation_queries.sql` | I: email `(created_at,id)`, `(status,created_at,id)`, `(type,created_at,id)`. F: `get_lifecycle_page`, `get_email_log_summary`, `get_health_summary`. |
| 041 | `041_category_suburb_priorities.sql` | **Fatal:** exactly two bytes, `cl`; invalid SQL. Creates nothing. Filename implies category suburb priorities but no table/columns/indexes/FKs/RLS exist in repository history. |
| 042 | `042_category_suburb_search_state.sql` | S: creates `category_suburb_search_state`. I/C: unique `(category_id,city_suburb_id)` plus reverse suburb index and FKs. F: updated-at trigger. R: authenticated read/admin manage/service. Its comment assumes the missing 041 table but has no SQL dependency on it. |
| 043 | `043_terminal_delivery_suppression.sql` | S: `leads.delivery_suppressed_emails text[] NOT NULL default {}`. C: email statuses gain `suppressed`. F: atomic `suppress_lead_delivery_email`. |
| 044 | `044_delivery_failure_report.sql` | I: partial activity metadata email/date. F: `get_delivery_failure_report`. |
| 045 | `045_delivery_failure_lead_selection.sql` | F: `get_delivery_failure_lead_selection`. |
| 046 | `046_hostinger_inbound_receipts.sql` | S: creates `inbound_receipts`. I/C: receipt key unique, status/update index, partial unique inbound activity event. C: provider/status checks. R: service-role only. |
| 047 | `047_email_report_lead_domain_lookup.sql` | I: normalized lead email and domain expression indexes. F: `get_email_report_leads`. |
| 048 | `048_global_search.sql` | S: creates `extensions` schema and `pg_trgm`. I: GIN trigram business/email/subject/DM handle. F: literal escaping; Leads, Pipeline, Email Log, Deals, DM Queue search RPCs; replaces email-log summary. Conditional extension-schema resolution throws if pg_trgm installation fails. |
| 049 | `049_data_quality_and_recipient_ownership.sql` | S: lead normalization/suppression columns; creates `lead_data_quality_flags`, `recipient_outreach_ownership`. I: normalized email, open-flag identity/email, owner lead. C: issue/status/ownership checks and FKs. F: normalization/data-quality triggers; classifiers, refresh, claim, reports. R: authenticated read/service manage. Data: backfills normalized emails, flags, and ownership. |
| 050 | `050_data_quality_ui_actions.sql` | S: flag resolution columns/FK. I: flag status/update. F: replaces refresh/summary/report; adds flag-status and remove-email RPCs. Data: resolves historic empty-email flags. |
| 051 | `051_fix_data_quality_classification.sql` | F: adds canonical identity/classification helpers; replaces group refresh, lead refresh trigger, and v2 report. Data: reclassifies open groups. |
| 052 | `052_hostinger_inbound_reliability.sql` | S: `inbound_receipts.attempts NOT NULL default 0`. I: partial email message-id. F: `claim_hostinger_inbound_receipt`. |

### Baseline defects and overlaps

- 041 is a guaranteed clean-replay syntax failure and its intended DDL is absent.
- 021 is a no-op that 030 later repairs.
- 003 adds `dm_queued`; 012 replaces the whole check and removes it.
- 013 is superseded by 014; 006/019 are manual setting corrections; 027/030/050/051 explicitly contain repair/backfill behavior.
- Functions are repeatedly replaced: email-log summary (040/048), data-quality refresh/report/summary/trigger (049/050/051).
- Many migrations assume exact earlier constraint names and objects. That is valid for one clean pass but fragile after manual divergence.
- Conditional/no-op behavior exists in exact-name category updates, exact-key setting updates, all `IF NOT EXISTS` DDL, 037's category index branch, and data backfills restricted to current null/state values.

## 2. Live schema definition

Notation below: `!` = non-null, `?` = nullable; `=...` = live default; `→` = live FK annotation. All IDs are UUID unless stated otherwise. Decimal columns are `numeric`; timestamps are `timestamptz`. PK/FK annotations are live API metadata. Exact check/unique bodies and generated expressions are outside available metadata.

| Live ReachAgent table | Live columns |
|---|---|
| `categories` | `id! PK=gen_random_uuid`, `name!`, `halal_filter?=false`, `cities?='all'`, `custom_cities? text[]`, `content_type?='remote'`, `pitch_template?`, `dm_template?`, `search_keywords? text[]`, `status?='active'`, `created_at?=now`, `updated_at?=now`, `use_priority_suburbs!=false`, `city_content_types? jsonb` |
| `leads` | `id! PK=gen_random_uuid`, `business_name!`, `category_id?→categories`, `category_name!`, `halal?=false`, `address?`, `suburb?`, `city!`, `state?`, `phone?`, `email?`, `website?`, `instagram_handle?`, `facebook_url?`, `google_rating? numeric`, `google_reviews_count? int`, `description?`, `services?`, `outreach_channel?='email'`, `status?='new'`, `deal_value? numeric`, `deal_type?`, `content_created?=false`, `payment_received?=false`, `notes?`, `created_at?=now`, `updated_at?=now`, `halal_confidence_score? int`, `halal_reasons? jsonb`, `reactivation_sent_at?`, `source?`, `content_type?`, `delivery_suppressed_emails! text[]`, `normalized_email?`, `outreach_suppression_reason?`, `outreach_suppressed_at?` |
| `emails` | `id! PK`, `lead_id?→leads`, `type!`, `subject!`, `body_html!`, `body_text!`, `resend_id?`, `status?='pending_send'`, `sent_at?`, `opened_at?`, `replied_at?`, `created_at?=now`, `edited_at?`, `edited_by_user?=false`, `message_id?`, `generation_source?` |
| `follow_ups` | `id! PK`, `lead_id?→leads`, `follow_up_number! int`, `scheduled_at!`, `sent_at?`, `email_id?→emails`, `status?='scheduled'`, `created_at?=now` |
| `dm_queue` | `id! PK`, `lead_id?→leads`, `platform!`, `handle!`, `profile_url?`, `message_text!`, `status?='pending'`, `created_at?=now`, `sent_at?` |
| `deals` | `id! PK`, `lead_id?→leads`, `deal_value! numeric`, `deal_type!`, `content_created?=false`, `content_created_at?`, `payment_received?=false`, `payment_received_at?`, `notes?`, `closed_at?=now`, `created_at?=now` |
| `activity_log` | `id! PK`, `event_type!`, `lead_id?→leads`, `description!`, `metadata? jsonb`, `created_at?=now` |
| `settings` | `id! PK`, `key!`, `value!`, `description?`, `updated_at?=now` |
| `city_suburbs` | `id! PK`, `city!`, `suburb!`, `active?=true`, `created_at?=now`, **`last_used_at?`**, **`priority? int=1`** |
| `category_suburb_priorities` | **Live only:** `id! PK`, `category_id!→categories`, `city_suburb_id!→city_suburbs`, `priority! int`, `created_at!=now`, `updated_at!=now` |
| `category_suburb_search_state` | `id! PK`, `category_id!→categories`, `city_suburb_id!→city_suburbs`, `last_searched_at?`, `exhausted_at?`, `created_at!=now`, `updated_at!=now` |
| `category_email_templates` | `id! PK`, `category_id!→categories`, `template_type!`, `subject_template?`, `body_template?`, `created_at!=now`, `updated_at!=now` |
| `exhausted_queries` | `query! text PK`, `city!`, `category!`, `exhausted_at?=now`, `expires_at?=now+3 days` |
| `search_cache` | `id! PK`, `query!`, `results! jsonb`, `api_used!`, `created_at?=now`, `expires_at?=now+7 days` |
| `dead_letter_queue` | `id! PK`, `operation!`, `payload! jsonb`, `error?`, `resolved!=false`, `created_at?=now`, `resolved_at?` |
| `discovery_run_metrics` | `id! PK`, `run_id!`, `run_at!=now`; all target/API/funnel/output counters are `int!=0`; five rate/cost fields are nullable numeric; `exit_reason?`, `runtime_ms?`; `safety_limit_hit!=false`, `safety_limit_reason?`, `cost_guard_hit!=false`; four query-breakdown fields nullable jsonb |
| `distributed_locks` | `lock_key! text PK`, `locked_at!=now`, `owner_token?` |
| `profiles` | `id! PK→auth.users` (migration relationship), `email!`, `full_name?`, `role!='member'`, `is_active!=true`, `created_at!=now` |
| `ai_providers` | `id! PK`, `provider_key!`, `display_name!`, `enabled!=false`, `created_at!=now`, `updated_at!=now` |
| `ai_models` | `id! PK`, `provider_id!→ai_providers`, `model_key!`, `display_name!`, `enabled!=false`, `created_at!=now`, `updated_at!=now` |
| `ai_workflow_configurations` | `id! PK`, `workflow_key!`, `model_id!→ai_models`, `enabled!=true`, `created_at!=now`, `updated_at!=now` |
| `ai_request_logs` | `id! PK`, `created_at!=now`, `started_at!`, `finished_at!`, `workflow!`, `provider?`, `model?`, `status!`, `duration_ms!`, token counts nullable int, `estimated_cost_usd? numeric`, `error_message?`, `retry_count!=0`, `request_source!='application'`, `metadata! jsonb` |
| `inbound_receipts` | `id! PK`, `provider!`, `receipt_key!`, mailbox/folder/uid/provider-message nullable text, `status!='pending'`, `payload! jsonb`, outcome/run/processing/error nullable fields, `created_at!=now`, `updated_at!=now`, `attempts!=0` |
| `lead_data_quality_flags` | `id! PK`, `lead_id!→leads`, `normalized_email?`, `issue_type!`, `reason!`, `related_lead_ids! uuid[]`, `status!='open'`, `metadata! jsonb`, `created_at!=now`, `updated_at!=now`, `resolved_at?`, `resolution_reason?`, `resolved_by?→profiles` |
| `recipient_outreach_ownership` | `normalized_email! text PK`, `owner_lead_id?→leads`, `state!='active'`, `claimed_at!=now`, `last_activity_at!=now`, `metadata! jsonb` |

The same public schema also exposes seven tables and three views with **no repository migration and no ReachAgent code caller**. Their exposed shapes are:

| Unmigrated live object | Exposed columns |
|---|---|
| `clients` | `id`, business/owner/contact/address fields, WhatsApp configuration, plan/trial/Stripe fields, AI settings, integration IDs, timestamps (31 columns) |
| `customers` | `id`, `client_id`, phone/name, opt-out/deletion state, first/last seen and message count (11 columns) |
| `conversations` | `id`, client/customer IDs, WhatsApp message ID, role/text/intent, escalation/model/token/latency/error fields, `sent_at` (13 columns) |
| `bookings` | IDs, customer/contact/date/time/guest/note fields, status/confirmation/cancellation/reminder fields, timestamps (19 columns) |
| `escalations` | IDs, reason/message, owner alert/response/reminder fields, resolution fields, `created_at` (14 columns) |
| `knowledge_base` | `id`, `client_id`, category/question/answer, active/order fields, timestamps (9 columns) |
| `weekly_reports` | IDs/week range, message/customer/intent/booking metrics, busiest period, top questions/intents, time saved, delivery/report fields (28 columns) |
| `v_conversation_thread` | conversation/customer display fields (10 columns) |
| `v_bookings_full` | booking fields plus resolved customer name/phone (21 columns) |
| `v_daily_summary` | `client_id`, `business_name`, daily message/booking/open-escalation counts, `ai_active` (6 columns) |

These objects describe a separate multi-client WhatsApp/bookings product. They are production schema drift for a whole-project clone, but should not automatically be copied into a ReachAgent V2 baseline until ownership is confirmed. OpenAPI does not expose their view definitions or complete catalog contracts.

No live table named `cities`, `suburbs`, or `followups` is exposed. The actual names/contracts are the `active_cities` settings row, `city_suburbs`, and `follow_ups`. ReachAgent migrations declare UUID/text primary keys and no explicit sequences; none is required by the migration-derived ReachAgent schema. The live sequence catalog remains unverified because it is not exposed through PostgREST metadata.

## 3. Table-by-table live versus migrations

| Table | Live state | Migration-derived expected state | Difference | Severity |
|---|---|---|---|---|
| `categories` | Exposed; 14 columns | Same 14 columns | Column shape matches; live checks/index/policies not catalog-verified | None/Unverified |
| `leads` | Exposed; 35 columns | Same 35 columns | Column shape/FK match; status check not catalog-verified; data has severe FK nullness | High |
| `emails` | Exposed; 16 columns | Same 16 columns | Column shape/FK match; live partial uniqueness/status check unverified | None/Unverified |
| `follow_ups` | Exposed; 8 columns | Same | No column drift | None |
| `dm_queue` | Exposed; 9 columns | Same | No column drift | None |
| `deals` | Exposed; 11 columns | Same | No column drift | None |
| `activity_log` | Exposed; 6 columns | Same | No column drift | None |
| `settings` | Exposed; 5 columns | Same | No column drift | None |
| `city_suburbs` | Exposed; 7 columns | Five columns from 004 | Live-only `last_used_at`, `priority`; Finder orders/updates them | Critical |
| `category_suburb_priorities` | Exposed; 7 columns and two FKs | Absent; 041 is invalid `cl` | Entire operational configuration table unreproducible | Critical |
| `category_suburb_search_state` | Exposed; 7 columns/two FKs | Same from 042 | Shape matches, but intended priority companion is missing on replay | High (dependency) |
| `category_email_templates` | Exposed; 7 columns/FK | Same from 037 | Shape matches | None |
| `exhausted_queries` | Exposed | Same from 005 | Shape matches | None |
| `search_cache` | Exposed | Same from 008 | Shape matches | None |
| `dead_letter_queue` | Exposed | Same from 007 | Shape matches | None |
| `discovery_run_metrics` | Exposed | Same from 018 | Shape matches; migration does not enable RLS | Medium |
| `distributed_locks` | Exposed | Same from 028/029 | Shape matches; migration does not enable RLS | Medium |
| `profiles` | Exposed | Same from 009 | Public column shape matches; auth trigger live state unverified | Unverified |
| `ai_providers` | Exposed | Same from 032 | Shape matches | None |
| `ai_models` | Exposed | Same from 032 | Shape/FK match | None |
| `ai_workflow_configurations` | Exposed | Same from 032 | Shape/FK match | None |
| `ai_request_logs` | Exposed | Same from 036 | Shape matches | None |
| `inbound_receipts` | Exposed | Same from 046/052 | Shape matches | None |
| `lead_data_quality_flags` | Exposed | Same from 049/050 | Shape/FKs match | None |
| `recipient_outreach_ownership` | Exposed | Same from 049 | Shape/FK matches | None |
| `clients` | Exposed; 31 columns, no ReachAgent caller | Absent | Separate WhatsApp/bookings product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `customers` | Exposed; 11 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `conversations` | Exposed; 13 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `bookings` | Exposed; 19 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `escalations` | Exposed; 14 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `knowledge_base` | Exposed; 9 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| `weekly_reports` | Exposed; 28 columns, no ReachAgent caller | Absent | Separate-product table is not reproducible | High (whole-project); Low (ReachAgent) |
| Views `v_conversation_thread`, `v_bookings_full`, `v_daily_summary` | Exposed; no ReachAgent callers | Absent | Separate-product view definitions are not reproducible | High (whole-project); Low (ReachAgent) |

## 4. Column drift audit

| Table.column | Live definition | Migration definition | Code references | Impact | Severity |
|---|---|---|---|---|---|
| `city_suburbs.last_used_at` | nullable `timestamptz` | Absent | `agents/finder.ts` orders least-recently-used and updates after search | Clean clone query/update fails; Finder cannot start normally | Critical |
| `city_suburbs.priority` | nullable `integer`, default `1` | Absent | Finder weighted rotation; Settings list/PATCH/UI | Clean clone selects/updates a missing field | Critical |
| `category_suburb_priorities.*` | Live table: UUID PK; non-null category/suburb FKs, priority, timestamps | Entire table absent because 041 is invalid | Finder, `/api/city-suburbs`, Settings UI, suburb helpers/tests | Per-category priorities fail; Finder catches read failure and falls back globally, while Settings operations fail | Critical |

No other ReachAgent live-versus-migration column difference was visible in PostgREST metadata. Types, exposed defaults, nullability and FKs match for the remaining tables/columns. That statement does not cover unexposed check/unique definitions or numeric precision.

Application expectations with no migration support are exactly the three items above. Conversely, no migration-created column was found to be absent live. Several legacy columns remain used lightly or as compatibility data (`categories.pitch_template`, `dm_template`, `cities`, `custom_cities`, and lead-level deal fields), but lack of usage is not evidence they should be removed.

## 5. Lead status contract audit

“Live allows” is `Proven` only when a current row exists; otherwise it is unknown because the check expression was not exposed. `Migration allows` is the final contract after 012.

| Status | Live DB allows? | Final migration allows? | TypeScript allows? | Used by code? | Used by UI? |
|---|---|---:|---:|---:|---:|
| `new` | Unknown (0 rows) | Yes | Yes | Yes, Finder/enricher | Yes |
| `researched` | Proven (10) | Yes | Yes | Yes | Yes |
| `email_ready` | Proven (100) | Yes | Yes | Yes | Yes |
| `contacted` | Proven (2,602) | Yes | Yes | Yes | Yes |
| `replied` | Proven (101) | Yes | Yes | Yes | Yes |
| `negotiating` | Proven (1) | Yes | Yes | Reporting/selection | Yes |
| `interested` | Unknown (0 rows) | **No** | **Yes** | Yes in lifecycle/data-quality logic | **Yes; UI writes it** |
| `closed` | Proven (1) | Yes | Yes | Reporting/selection | Yes |
| `closed_won` | Unknown (0 rows) | **No** | **Yes** | Yes in lifecycle/data-quality logic | Yes in Leads options |
| `closed_manual` | Proven (3) | Yes | Yes | Yes | Yes |
| `dead` | Proven (174) | Yes | Yes | Yes | Yes |
| `dm_queued` | Unknown (0 rows) | **No** (added by 003, removed by 012) | No | No current runtime reference | No |

Drift is real. `interested` and `closed_won` are first-class TypeScript/UI values but the checked-in DB check rejects them. The Leads PATCH API uses `z.object({id}).catchall(z.unknown())`, so it does not validate status server-side and will pass the UI value to Postgres. `dm_queued` is a migration-history legacy value, not a current code contract. The live rows currently contain only the eight reported values; no `new`, `interested`, `closed_won`, or `dm_queued` rows exist.

**Future work recommendation — do not implement now:** define one canonical contract containing `new`, `researched`, `email_ready`, `contacted`, `replied`, `negotiating`, `interested`, `closed`, `closed_won`, `closed_manual`, `dead` only if the product genuinely needs both generic/explicit closed variants. Otherwise normalize the close vocabulary first. Generate the DB check, TypeScript union, API validator, UI options, Trigger jobs, and RPC stage sets from that single decision. Retire `dm_queued` unless DM workflow requirements reintroduce it deliberately.

## 6. Category and suburb drift

Live `categories` has `cities`, `custom_cities`, `content_type`, `use_priority_suburbs`, and `city_content_types`; migrations reproduce all five. There is no `cities` table. Global active cities are stored as comma-separated text in `settings.active_cities`. Live `city_suburbs` has the two unreproducible fields above, and live `category_suburb_priorities` is wholly unreproducible.

Finder today loads category `id`, `name`, `search_keywords`, `use_priority_suburbs`, `status`, `content_type`, and `city_content_types`. It **does not load or use `categories.cities` or `categories.custom_cities`**. It builds locations exclusively from global `settings.active_cities` joined in application code to active `city_suburbs`. It uses category-specific priority rows only to alter priority, not to restrict the active suburb set. `content_type` and `city_content_types[city]` are used to resolve each inserted lead's content type and to decide whether suburb cooldown applies.

Answers:

1. **Yes.** `city_suburbs.last_used_at`, `city_suburbs.priority`, and all of `category_suburb_priorities` cannot be reproduced.
2. **Yes.** `categories.cities` and `custom_cities` are editable/persisted by Settings but ignored by current Finder location selection.
3. **No, not consistently populated.** The 108 non-null FKs are internally consistent (zero missing targets and zero name mismatches), but 2,884/2,992 leads have no FK at all.

The normalized category-name uniqueness backstop in 037 is conditional: it is created only if no trim/lower duplicates exist. Thus clean seeded replay creates it, while a drifted production database can silently remain without it.

## 7. Finder category foreign-key audit

| Creation path | Sets `category_id`? | Resolution | Can be null? | Template consequence |
|---|---:|---|---:|---|
| Google Places Finder | **No** | Active category row is loaded, but insert writes only `category_name` | Yes; column nullable | Initial template generation currently falls back to an exact `category_name` lookup, so it can still bind while that name remains unchanged and unique. Stored follow-up/reactivation lookup requires the FK and therefore uses its hardcoded fallback when the FK is null. Renames and duplicate names remain fragile. |
| Outscraper Finder/fallback | **No** | Same unified Finder result loop and same insert | Yes | Same exact-name initial-template fallback and hardcoded follow-up/reactivation fallback |
| CSV import | Yes | Exact trimmed/lower category-name map; unknown category rejects row | Input requires resolved category | Stored templates work |
| Manual Add Lead | Yes | API requires UUID plus category name; shared `createLead` loads category by ID | API requires it, DB itself permits null | Stored templates work when ID is valid; API does not independently assert supplied name equals loaded name |
| Legacy importer | No separate active path found | Historic/unknown | DB permits null | Legacy nulls remain |

Safe live aggregates:

| Metric | Count |
|---|---:|
| Total leads | 2,992 |
| With `category_id` | 108 (3.6%) |
| Without `category_id` | 2,884 (96.4%) |
| `email_ready` or `contacted` without `category_id` | 2,622 |
| Null category + null source (Finder/legacy shape) | 2,883 |
| Null category + `source='manual'` | 1 |
| Non-null category + `source='manual'` | 108 |
| Non-null category + null source | 0 |

These counts strongly align with the code defect: every non-null FK row is manual-source, while essentially every Finder/legacy-source row lacks it.

## 8. Index reconciliation

Repository-created secondary indexes are:

- identity/config: `search_cache_query_idx`; `profiles_role_idx`, `profiles_is_active_idx`; `ai_models_provider_enabled_idx`; `categories_name_trimmed_lower_key` (conditional); `category_email_templates_type_idx`;
- Finder/metrics: `discovery_run_metrics_run_at_idx`; `category_suburb_search_state` unique constraint index and `...city_suburb_idx`; **none reproducible for `category_suburb_priorities` or the extra `city_suburbs` fields**;
- lead/search: `leads_status_created_at_idx`, `leads_city_status_created_at_idx`, `leads_business_name_trgm_idx`, `leads_email_trgm_idx`, `leads_email_report_address_idx`, `leads_email_report_domain_idx`, `leads_normalized_email_idx`;
- email: unique `emails_resend_id_key`, partial unique `emails_lead_type_delivered_key`, partial unique `emails_one_pending_initial_per_lead_key`, `emails_lead_id_created_at_idx`, `emails_status_sent_at_idx`, `emails_replied_at_idx`, `emails_created_at_id_idx`, `emails_status_created_at_id_idx`, `emails_type_created_at_id_idx`, `emails_subject_trgm_idx`, `emails_message_id_not_null_idx`;
- activity/delivery: `activity_log_lead_id_created_at_idx`, `activity_log_event_type_created_at_idx`, partial `activity_log_delivery_email_created_at_idx`, partial unique `activity_log_inbound_receipt_event_key`, `inbound_receipts_status_updated_at_idx`;
- queue/data quality: `dm_queue_handle_trgm_idx`; `lead_data_quality_flags_open_key`, `...email_idx`, `...status_updated_idx`; `recipient_outreach_owner_lead_idx`.

The live API cannot enumerate indexes, so live-present/missing/duplicate index claims cannot be made. Therefore **live indexes are not currently proven reproducible**. At least the intended priority-table indexes are not reproducible because the table itself is missing from migrations.

Likely query gaps to validate with `EXPLAIN` before V2 (future work) are category-name filtering, `follow_ups.lead_id`, `deals.lead_id`, DM status/date and lead joins, and category-priority `(category_id,city_suburb_id)` uniqueness/reverse-FK access. PostgreSQL does not automatically index referencing FK columns. No index should be added until catalog dump and workload plans confirm the need.

## 9. Constraint reconciliation

Migration-reproducible PKs exist on every ReachAgent table listed above (UUID IDs except `exhausted_queries.query`, `distributed_locks.lock_key`, and `recipient_outreach_ownership.normalized_email`). Live API PK annotations agree. Live FK annotations agree for leads→categories; emails/DM/follow-ups/deals/activity→leads; follow-ups→emails; AI model/config relations; category templates/state; data-quality/ownership relations. The live-only priority table has FKs to categories and city suburbs that migrations cannot reproduce.

Repository unique contracts include settings key; profile email; provider/workflow keys; provider+model; email resend ID; delivered lead+type; pending initial per lead; category+template type; category+suburb search state; receipt key; flag open identity; and conditional normalized category name. Check contracts cover all status/type/value sets described in the migration inventory.

Because live unique/check definitions were not exposed, exact equality cannot be certified. Data-dependent blockers are duplicate `resend_id` values (024), delivered email duplicates (027 repairs them), normalized category-name duplicates (037 silently skips uniqueness), duplicate pending initial emails (037 aborts), and any duplicates conflicting with the missing priority-table uniqueness when its real DDL is eventually reconstructed.

## 10. RPC and function reconciliation

Every RPC currently called by ReachAgent exists live and has the same exposed argument signature as its migration. Live function **bodies** could not be read, so “body match” remains unverified.

| Live/app function | Signature summary | Migration(s) | Caller | Result |
|---|---|---|---|---|
| `get_dashboard_summary` | optional `p_as_of timestamptz` | 039 | dashboard summary | Signature matches; body unverified |
| `get_leads_search_page` | statuses[], category, city, search, page, size, ids-only | 048 | Leads API | Signature matches |
| `get_pipeline_search_page` | statuses[], search, page, size | 048 | Pipeline API | Signature matches |
| `get_lifecycle_page` | as-of, filter/search/sort, page/size | 040 | Lifecycle API | Signature matches |
| `get_email_log_search_page` | type/status/search/page/size | 048 | Email Log API | Signature matches |
| `get_email_log_summary` | type/status/search | 040, replaced 048 | Email Log API | Final signature matches |
| `get_health_summary` | optional as-of | 040 | health API | Signature matches |
| `get_deals_search_page` | search/page/size | 048 | Deals API | Signature matches |
| `get_dm_queue_search_page` | platform/status/city/search/page/size | 048 | DM Queue API | Signature matches |
| `get_delivery_failure_report` | status/type/search/page/size | 044 | failure API | Signature matches |
| `get_delivery_failure_lead_selection` | status/type/search/include IDs | 045 | failure selection API | Signature matches |
| `get_email_report_leads` | addresses[], domains[] | 047 | email report | Signature matches |
| `get_ai_request_analytics` | time/workflow/provider/status/recent limit | 036 | AI analytics | Signature matches |
| `suppress_lead_delivery_email` | lead UUID, email | 043 | tracker | Signature matches |
| `claim_hostinger_inbound_receipt` | receipt UUID, run ID, stale-before | 052 | inbound processor | Signature matches |
| `claim_recipient_outreach` | lead UUID, phase | 049 | data quality/send paths | Signature matches |
| `refresh_lead_data_quality` | lead UUID | 049/050/051 | data quality | Final signature matches |
| `get_data_quality_summary` | no args | 049/050 | data-quality API | Final signature matches |
| `get_data_quality_report_v2` | six filters plus page/size | 050/051 | data-quality API | Final signature matches |
| `set_data_quality_flag_status` | issue/status/IDs/email/reason/actor | 050 | admin action API | Signature matches |
| `remove_data_quality_emails` | IDs[], actor | 050 | admin action API | Signature matches |

Other migrated/live public functions include `get_lead_status_counts`, legacy `get_data_quality_report`, identity/classification helpers, `literal_ilike_pattern`, `classify_email_quality`, `refresh_email_group_quality`, and `is_active_admin`. Trigger-returning functions are not exposed as RPC endpoints.

Live exposes `show_limit()` and `show_trgm(text)` with **no migration definition and no code caller**. They appear extension/support-related, but provenance cannot be proven from available metadata. Per the audit rule, these are High for whole-schema reproducibility, though Low operational impact to ReachAgent. Therefore the answer to “are all production RPCs represented?” is **No**; the answer for current ReachAgent callers is **Yes by name/signature**.

## 11. Database trigger audit

Migration-defined triggers are:

| Table | Trigger | Function/purpose | Source |
|---|---|---|---|
| `leads` | `update_leads_updated_at` | timestamp maintenance | 001 |
| `categories` | `update_categories_updated_at` | timestamp maintenance | 001 |
| `settings` | `update_settings_updated_at` | timestamp maintenance | 001 |
| `auth.users` | `on_auth_user_created` | upsert profile | 009 |
| AI provider/model/workflow tables | three `update_*_updated_at` | timestamp maintenance | 032 |
| `category_email_templates` | `update_category_email_templates_updated_at` | timestamp maintenance | 037 |
| `category_suburb_search_state` | `update_category_suburb_search_state_updated_at` | timestamp maintenance | 042 |
| `leads` | `leads_set_normalized_email` | canonical email before insert/update | 049 |
| `leads` | `leads_refresh_data_quality` | refresh flags after insert/email/identity changes | 049, replaced 051 |

No migration can reproduce any trigger that may exist on the live-only priority table. Live trigger inventory and bodies are unverified without `pg_trigger`; automation dependency beyond the list above cannot be ruled out.

## 12. RLS reconciliation

| Tables | Migration replay state/policies | Live state |
|---|---|---|
| leads, categories, emails, dm_queue, follow_ups, deals, activity_log, settings | RLS enabled; authenticated **FOR ALL USING true WITH CHECK true**; service full access | Not catalog-verifiable |
| exhausted_queries, dead_letter_queue, search_cache | Same authenticated/service full access | Not catalog-verifiable |
| profiles | RLS; own read, active-admin all-profile read, service manage | Not catalog-verifiable |
| AI configuration tables | RLS; authenticated read, active-admin manage, service manage | Not catalog-verifiable |
| ai_request_logs | RLS; active-admin read, service manage | Not catalog-verifiable |
| category_email_templates, category_suburb_search_state | RLS; authenticated read, active-admin manage, service manage; anon revoked | Not catalog-verifiable |
| inbound_receipts | RLS; service manage only | Not catalog-verifiable |
| lead_data_quality_flags, recipient_outreach_ownership | RLS; authenticated read, service manage | Not catalog-verifiable |
| city_suburbs, discovery_run_metrics, distributed_locks | **No migration enables RLS** | Not catalog-verifiable |
| category_suburb_priorities | No reproducible migration | Not catalog-verifiable |

The prior “authenticated users can access all operational records” concern is **confirmed as the migration-replay design** for the original operational tables and cache/DLQ tables. It could not be independently confirmed against live policies without an authenticated user session/catalog access. A V2 clone would recreate this broad access unless the future baseline intentionally changes it after a separate authorization review.

## 13. Generated Supabase types

There is no generated Supabase `Database` type in the repository. Both browser and server clients call `createClient` without a schema generic. Existing TypeScript interfaces are manual, feature-local shapes.

Accordingly, generated types cannot be trusted because they do not exist. Manual types correctly include many current fields but do not provide compile-time schema reconciliation, check-constraint enums, nullability guarantees, or RPC return contracts. The clearest consequence is `LeadStatus`: TypeScript permits `interested` and `closed_won` while final migration SQL does not.

## 14. Migration replay risk

### A. Will all migrations complete successfully?

**No.** Migration 041 deterministically fails on `cl`. Migrations 042+ will not be reached.

Before 041, a single clean pass on a normal empty Supabase project will probably reach that point. Notable assumptions are availability of `auth.users`/`gen_random_uuid`, no duplicated seed state, and the data checks in 024/027/037. Migration 048 also requires permission to create/use `pg_trgm` if 041 is repaired/skipped.

### B. Will the resulting schema match production?

**No.** Even skipping the syntax error produces neither `category_suburb_priorities` nor `city_suburbs.last_used_at/priority`, omits seven live tables/three views and two live public RPCs, and cannot be proven to reproduce live indexes, checks, triggers, or RLS. It would reproduce the exposed column shape of the remaining ReachAgent tables.

Likely/definite failure list:

1. `041_category_suburb_priorities.sql` — definite syntax error.
2. `024_unique_resend_id.sql` — fails on an already-populated target with duplicate non-null resend IDs; clean DB succeeds.
3. `037_category_email_template_storage.sql` — explicitly aborts if duplicate pending initial emails exist; clean DB succeeds.
4. `048_global_search.sql` — can fail if extension creation/operator-class resolution is unavailable; standard Supabase is expected to support it.
5. Plain, non-idempotent create/insert/index migrations (001, 004, 018, 032–034, 036–037, 042) fail if partially applied then replayed outside Supabase's migration ledger.

## 15. Data-dependent migration risks

| Migration | Dependency | Clean DB behavior | Existing production behavior / cloning risk |
|---|---|---|---|
| 006, 013–014, 019, 025 | Exact setting/category names | Mostly succeeds/no-ops predictably | Silently skips renamed/missing rows; later state differs |
| 024 | Unique non-null `resend_id` | Succeeds | Duplicate values abort |
| 026 | Null content types and legacy city/category names | Seed data/empty leads safe | Backfill freezes legacy inference; renamed categories change result |
| 027 | Duplicate delivered email groups | No-op then index | Mutates later duplicates to `failed` and writes activity; not a schema-only migration |
| 030 | Missing `source` | Adds column | No-op if manual production column already exists |
| 037 | Category duplicates; pending initial duplicates | Seed names unique; succeeds | Category uniqueness silently skipped on normalized duplicates; pending duplicates abort; template seed preserves custom data conditionally |
| 049 | Existing leads/emails/deals | Empty backfills | Normalizes all lead emails, creates flags/owners and runs refresh loops; result depends on lifecycle data |
| 050 | Historic open empty-email flags | No-op | Resolves matching historic flags |
| 051 | Existing open data-quality groups | No-op | Reclassifies groups using new logic |

## 16. Drift root causes

| Finding | Supported category |
|---|---|
| Invalid/missing 041 DDL versus live priority table/columns | **Migration missing from repo**; live origin is Unknown (manual production SQL is plausible but unproven) |
| `leads.source` history | **Application evolved without migration**, then explicit repair in 030; 030 itself says likely out-of-band production SQL |
| Status `dm_queued` removed by later replacement | **Overlapping migration / legacy schema** |
| `interested`, `closed_won` only in code | **Application evolved without migration** |
| Conditional category uniqueness | **Conditional migration** |
| 027 duplicate demotion, 050/051 reclassification | **Manual-fix/data-dependent migrations** |
| No generated DB types | **Generated type drift/absence** |
| Seven tables, three views, two public RPCs with no migration | **Migration missing from repo / Unknown ownership** |
| Unverified catalog-level differences | **Unknown** pending catalog dump |

Git history shows 041 was introduced already containing `cl`; there is no recoverable correct version in checked-in history. Evidence does not establish whether production DDL was manual, came from an untracked local file, or another branch/system.

## 17. Golden schema recommendation (future work only)

| Option | Advantages | Disadvantages | Risk | Effort |
|---|---|---|---|---|
| A. Repair all historical migrations | Preserves full history and `db reset` story | 52 files include repairs/data mutations and overlapping replacements; high chance of changing historical semantics | High | High |
| B. Hand-author one current golden baseline | Clean, readable, V2-specific | Manual transcription can miss policies, function bodies, grants, extensions, sequences, and indexes | Medium | Medium–High |
| C. Use raw Supabase schema dump and restart V2 history | Highest catalog fidelity and captures hidden objects | Blind dump also imports unrelated WhatsApp/bookings objects and possibly unwanted grants/ownership metadata | Medium | Medium |
| D. **Verified, curated dump-derived baseline** | Start from an authoritative catalog dump, isolate ReachAgent-owned objects, explicitly reconcile status/041 drift, restore into a disposable project, then catalog-diff before use | Requires object-ownership decisions and a controlled validation cycle | **Low** | Medium–High |

**Recommendation: Option D.** Obtain a full production schema-only dump plus catalog queries for indexes, constraints, triggers, functions, grants and policies. Define the ReachAgent ownership boundary (especially the ten unrelated objects), turn the verified ReachAgent subset into one immutable V2 baseline, and validate it by restoring into an empty disposable Supabase project and diffing catalogs. Preserve 052 as the historical cutoff; new V2 changes begin as incremental migrations after the baseline. Do not construct the baseline from OpenAPI alone.

## 18. Eventual data-migration considerations

No data migration is proposed now.

### Essential business data

- `leads`, including normalized/suppression fields and a deliberate category-ID remediation mapping;
- `categories`, `category_email_templates`, `category_suburb_priorities`, active `city_suburbs`, category search state only if cooldown continuity matters;
- `settings` after separating environment secrets/config from business settings;
- `deals`;
- `profiles` only through a coordinated Auth user migration because IDs reference `auth.users`;
- `recipient_outreach_ownership` and delivery-suppressed addresses to prevent duplicate/unsafe outreach.

### Operational history

- `emails`, `follow_ups`, and relevant `activity_log` rows;
- `inbound_receipts` if webhook idempotency keys can recur;
- open `lead_data_quality_flags`;
- optionally `discovery_run_metrics` and resolved quality history.

### Logs/telemetry

- `ai_request_logs`, old `activity_log`, dead-letter history, historic discovery metrics. Archive or retain in V1 if compliance/analytics permits.

### Rebuildable/cache data

- `search_cache`, expired `exhausted_queries`, `distributed_locks`; do not migrate active ephemeral lock rows.
- category/suburb search state may be reset if accepting a temporary rediscovery/cooldown change.
- The unrelated clients/customers/conversations/bookings product objects require a separate ownership/migration decision and should not be swept into ReachAgent V2 by default.

## 19. Ranked findings

### P0 — must fix before V2 Supabase clone

1. Replace the invalid 041 history with an approved V2 baseline strategy; do not merely skip it without capturing the live priority DDL.
2. Obtain a catalog-complete production schema dump/introspection result and reconcile indexes, constraints, triggers, functions, grants, and RLS.
3. Decide and encode the canonical lead-status contract; current UI can send values the migration rejects.
4. Correct the future baseline for Finder category ownership and plan data remediation for 2,884 null FKs before a V2 data clone or reliance on FK-based sequence templates.
5. Decide whether the ten unrelated live objects belong in V2.

### P1 — should fix before V2 application work

1. Reproduce `city_suburbs.last_used_at/priority` and `category_suburb_priorities` with verified constraints/indexes/RLS/triggers.
2. Generate strongly typed Supabase schema/RPC types from the verified baseline.
3. Decide whether category `cities/custom_cities` should control Finder or be retired; today the UI persists ignored configuration.
4. Review broad authenticated full-access policies and the no-RLS migration state of `city_suburbs`, metrics, and locks.
5. Validate required query indexes using production plans/workload, especially FK/filter paths.

### P2 — can fix during V2

- Separate schema-only migrations from data repair/backfill steps.
- Consolidate repeated RPC replacements and remove legacy status/settings vocabulary.
- Decide retention/migration rules for logs, cache, receipts, and quality flags.

### P3 — later cleanup

- Remove genuinely unused compatibility fields only after usage telemetry and data export.
- Rationalize redundant indexes after live catalog and `pg_stat_user_indexes` review.
- Document ownership of extension helper RPCs and the separate product schema.

## 20. Required final answers

1. **Can we safely create V2 by replaying existing migrations today?** No.
2. **What prevents it?** 041 is invalid SQL; its intended live table/columns are absent; status contracts conflict; full live catalog objects are not represented/verified; extra live objects have no migrations.
3. **Is production schema reproducible?** No.
4. **Top five drift issues?** Invalid 041/missing priority schema; live-only city-suburb columns; code-vs-DB lead statuses; Finder omission of `category_id` with 96.4% null live; ten unrelated live tables/views plus two non-migrated public RPCs.
5. **Is lead status drift real?** Yes: `interested` and `closed_won` exist in TS/UI but not final migration check; `dm_queued` is a dropped legacy value.
6. **Is category/suburb drift real?** Yes, both schema and runtime semantics drift.
7. **Are Finder leads missing `category_id` in any path?** Yes, both Google Places and Outscraper use the same insert that omits it.
8. **Are all production RPCs represented?** No (`show_limit`, `show_trgm` are live-only). All current ReachAgent RPC callers are represented by name/signature.
9. **Are live indexes reproducible?** Not proven; live catalog access was unavailable, and indexes for the missing priority schema necessarily are not reproducible.
10. **Are generated Supabase types trustworthy?** No generated types exist; manual types are demonstrably out of sync on statuses.
11. **Safest golden-schema strategy?** A curated, schema-dump-derived V2 baseline restored and catalog-diffed in a disposable project (Option D).
12. **What must happen before cloning?** Acquire complete catalog metadata/dump; decide object ownership and canonical statuses; reconstruct priority schema; define category-FK remediation; review RLS; build and restore-test the curated baseline; generate types and run catalog/application verification.
13. **What should explicitly not change yet?** Do not alter production data/schema/indexes/constraints/RLS/RPCs, do not rewrite migrations, do not backfill category IDs/statuses, do not delete unrelated objects, and do not deploy until the golden baseline and data rules are approved.

## 21. Audit integrity

No secrets or row-level business data were written to this report. Only aggregate counts and schema metadata were used. No insert, update, delete, DDL, deployment, migration command, or policy/function mutation was executed.

SCHEMA AUDIT COMPLETE

Existing files modified: 0
Database changes: 0
Migrations created: 0
Production data changed: 0
Deployments performed: 0

Audit report created:
docs/reachagent-supabase-schema-audit.md
