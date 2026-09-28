# Final V1 → V2 delta audit — Phase 1

Audit date: 28 September 2026 (Australia/Sydney)  
Repository branch/commit: `reachagent-v2-application` / `0e17054`  
Mode: **read-only current-state reconciliation; no sync was run**

## Executive result

V1 identity was verified as `obppfnujusqiwjhwzosv`. V2 identity was verified as
the distinct project `ojrxfjlgjhzhdpnkyboa`. The target workspace was explicitly
limited to `00000000-0000-0000-0000-000000000001`.

The original 12-table migration footprint has not gained any missing effective
email, follow-up, lead, category, template, DM, deal, or ownership key. The
current actionable source-only delta is:

- 192 `inbound_receipts` rows, a previously omitted operational idempotency
  ledger: `INSERT_SAFE` by ID and unique `receipt_key`.
- 3 `activity_log` rows: `INSERT_SAFE`; two are unmatched-inbound events tied
  to two of those receipts and one is `digest_sent`.
- 2 `leads` rows: `MANUAL_REVIEW`; V1 moved from `replied` in V2 to the stricter
  `dead` state after the rehearsal, but there is no trustworthy per-row baseline.
- 2 `recipient_outreach_ownership` rows: `CONFLICT`; V2 has newer active owners
  pointing to V2-only test/canary leads. They must not be overwritten.
- 1 allowlisted setting, `system_active`: `MANUAL_REVIEW` and operationally
  **do not migrate**. It changed in live V1 from the previously matching value
  to `true` at `2026-09-27T14:15:29.844523Z`; V2 remains deliberately `false`.

The effective original footprint now contains 64,031 V1 rows: the prior 64,028
plus three source-only activity events. Adding the newly audited 192 inbound
receipts gives 64,223 candidate operational rows. Of those, 64,024 match,
195 are `INSERT_SAFE`, two leads are `MANUAL_REVIEW`, and two ownership rows are
`CONFLICT`. The 267 redundant V1 drafts remain `EXPECTED_DEDUP` and must not be
reintroduced.

Phase 2 is safe only as a conflict-skipping, insert-only pass for the 195 safe
rows after a fresh consistency check. Full convergence is not yet safe because
the live source changed during this audit and the five setting/lead/ownership
decisions are unresolved.

## Identity and safety proof

| Side | Expected and verified identity | Safe proof |
|---|---|---|
| V1 | `obppfnujusqiwjhwzosv` | Exact API hostname ref plus service-role JWT `ref`; neither value was printed |
| V2 | `ojrxfjlgjhzhdpnkyboa` | Exact API hostname ref, explicit V2 project-ref marker, DB URL embedded ref, and accepted opaque `sb_secret_…` credential; no secret/URL was printed |
| Separation | distinct | Different refs and different API URLs; same-database execution is rejected |

Hosted V2 catalog inspection returned database `postgres`, confirmed
`has_schema_privilege('reachagent_function_owner','public','CREATE') = false`,
and confirmed the current workspace-aware constraints and indexes. The catalog
session itself was not server-enforced read-only
(`default_transaction_read_only = off`), so safety came from executing only the
three literal catalog `SELECT`
queries; no DDL/DML path existed in that mode.

The audit client has an HTTP transport guard which rejects every method except
`GET` and `HEAD`. It contains no RPC, email, Trigger.dev, AI, Stripe, Finder,
Hostinger, deployment, migration, or Git mutation call.

## Previous migration assets and exact rules

Discovered assets:

- `scripts/migrate-v1-to-v2-rehearsal.ts` — mapping, preview, execute, and
  validation implementation.
- `docs/reachagent-v2-migration-rehearsal.md` — 26 September rehearsal report.
- `scripts/audit-v2-operational-tenancy.ts` — V2 tenancy audit.
- `scripts/verify-v2-hosted-db.ps1` and `scripts/verify-v2-hosted-safety.ts` —
  hosted V2 identity/safety checks.
- V1 schema history in `supabase/migrations/`; V2 schema and current constraints
  in `supabase-v2/migrations/00000000000000_*` through `00000000000019_*`.

No exact snapshot or cutoff timestamp is recorded. The rehearsal report has a
date, not a transaction-consistent cutoff. This audit therefore used IDs and
actual natural keys, not an invented timestamp.

Original migration rules:

1. Preserve source IDs and explicitly add the seed `workspace_id`.
2. Copy only explicitly listed shared columns. Preserve V2-only category policy,
   `send_envelope`, `claimed_at`, and SaaS/platform fields/defaults.
3. Use conflict-ignore semantics; do not update an existing V2 row.
4. For V1 email rows whose status is `pending_send`, `sent`, or
   `email_sync_failed`, group by `(lead_id,type)`. If a group has multiple rows,
   retain the first `sent` row when present, otherwise the first row. The current
   excluded set is exactly 267 `pending_send` rows across 267 duplicate groups.
5. Exclude `lead_data_quality_flags`; V2 derives them from leads and has a
   partial open-flag unique key.
6. Migrate only the documented 21 business setting keys. Exclude provider,
   runtime, cost/spend, and infrastructure settings.
7. Never overwrite V2 SaaS/platform tables or V2-only columns.

## Table classification and counts

`Difference` is V2 seed count minus raw V1 count. For email, the raw difference
is intentionally misleading because V1 contains the 267 excluded drafts.

| Table | V1 raw | V1 effective | V2 seed | Difference | INSERT_SAFE | UPDATE_SAFE | NO_CHANGE | EXPECTED_DEDUP | V2_ONLY | CONFLICT | MANUAL_REVIEW |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| categories | 31 | 31 | 35 | +4 | 0 | 0 | 31 | 0 | 4 | 0 | 0 |
| city_suburbs | 351 | 351 | 354 | +3 | 0 | 0 | 351 | 0 | 3 | 0 | 0 |
| category_email_templates | 155 | 155 | 159 | +4 | 0 | 0 | 155 | 0 | 4 | 0 | 0 |
| category_suburb_priorities | 264 | 264 | 264 | 0 | 0 | 0 | 264 | 0 | 0 | 0 | 0 |
| category_suburb_search_state | 1,461 | 1,461 | 1,461 | 0 | 0 | 0 | 1,461 | 0 | 0 | 0 | 0 |
| leads | 3,509 | 3,509 | 3,516 | +7 | 0 | 0 | 3,507 | 0 | 7 | 0 | 2 |
| emails | 12,109 | 11,842 | 11,847 | −262 | 0 | 0 | 11,842 | 267 | 5 | 0 | 0 |
| follow_ups | 8,087 | 8,087 | 8,089 | +2 | 0 | 0 | 8,087 | 0 | 2 | 0 | 0 |
| deals | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| dm_queue | 10 | 10 | 10 | 0 | 0 | 0 | 10 | 0 | 0 | 0 | 0 |
| recipient_outreach_ownership | 3,217 | 3,217 | 3,217 | 0 | 0 | 0 | 3,215 | 0 | 0 | 2 | 0 |
| activity_log | 35,104 | 35,104 | 35,147 | +43 | 3 | 0 | 35,101 | 0 | 46 | 0 | 0 |
| inbound_receipts | 192 | 192 | 0 | −192 | 192 | 0 | 0 | 0 | 0 | 0 | 0 |
| settings (global; 21-key allowlist) | 21 | 21 | 21 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 1 |

The V2-only rows are separately classified and require no deletion. Their IDs
and distributions align with pre-existing V2 test/canary data; current-state
absence from V1 is not deletion evidence.

Tables intentionally not synchronized:

| Table/class | V1 | V2 seed | Classification | Reason |
|---|---:|---:|---|---|
| lead_data_quality_flags | 778 | 483 | 778 `DO_NOT_MIGRATE` | Deterministically derived; explicitly excluded by original tool |
| exhausted_queries | 150 | 0 | 150 `DO_NOT_MIGRATE` | Expiring Finder runtime state |
| search_cache | 7,861 | 0 | 7,861 `DO_NOT_MIGRATE` | Generated/expiring provider cache |
| discovery_run_metrics | 208 | 0 | 208 `DO_NOT_MIGRATE` | Historical Finder run telemetry omitted by original tool |
| non-allowlisted settings | 6 | n/a | 6 `DO_NOT_MIGRATE` | Provider selection, limits, pricing, and spend telemetry |
| SaaS/platform tables | n/a | preserved | `DO_NOT_MIGRATE` | Workspaces/members/profiles, billing/Stripe, entitlements/quotas, OAuth, audit/security/observability, AI SaaS configuration, onboarding, migrations |

## Timestamp evidence

Times are UTC. `—` means the mapped table has no such column. For ownership,
`claimed_at`/`last_activity_at` are shown instead of nonexistent created/updated
columns. The audit also compared every other mapped lifecycle timestamp.

| Table | V1 MIN(created) | V1 MAX(created) | V1 MAX(updated) | V2 MAX(created) | V2 MAX(updated) |
|---|---|---|---|---|---|
| categories | 2026-05-01 06:25:58 | 2026-09-21 09:09:16 | 2026-09-21 13:13:35 | 2026-09-21 09:09:16 | 2026-09-21 13:13:35 |
| city_suburbs | 2026-05-06 04:35:43 | 2026-08-29 15:07:53 | — | 2026-09-16 05:11:50 | — |
| category_email_templates | 2026-08-14 12:03:02 | 2026-09-21 09:09:46 | 2026-09-21 09:09:46 | 2026-09-21 09:09:46 | 2026-09-21 09:09:46 |
| category_suburb_priorities | 2026-08-29 15:11:36 | 2026-08-29 15:11:36 | 2026-08-29 15:13:35 | 2026-08-29 15:11:36 | 2026-08-29 15:13:35 |
| category_suburb_search_state | 2026-08-30 22:18:36 | 2026-09-23 22:09:16 | 2026-09-24 00:14:07 | 2026-09-23 22:09:16 | 2026-09-24 00:14:07 |
| leads | 2026-05-02 11:50:11 | 2026-09-24 11:42:07 | 2026-09-27 05:51:29 | 2026-09-24 11:42:07 | 2026-09-25 16:17:35 |
| emails | 2026-05-02 11:52:41 | 2026-09-24 22:07:48 | — | 2026-09-24 22:07:48 | — |
| follow_ups | 2026-05-09 23:02:14 | 2026-09-24 22:07:43 | — | 2026-09-24 22:07:43 | — |
| deals | — | — | — | — | — |
| dm_queue | 2026-05-03 01:56:14 | 2026-05-04 22:04:39 | — | 2026-05-04 22:04:39 | — |
| ownership (`claimed` / `last_activity`) | 2026-05-02 11:53:02 | 2026-09-24 22:04:01 | 2026-09-24 22:07:47 | 2026-09-24 22:04:01 | 2026-09-24 22:07:47 |
| activity_log | 2026-05-02 11:50:11 | 2026-09-27 04:37:16 | — | 2026-09-27 10:54:44 | — |
| inbound_receipts | 2026-09-02 13:58:46 | 2026-09-27 04:37:10 | 2026-09-27 04:37:16 | — | — |
| settings | — | — | 2026-09-27 14:15:29 | — | 2026-09-25 21:42:57 |

Additional high-signal maxima matched exactly for effective email
`sent_at = 2026-09-24T22:05:16.170Z` and `replied_at =
2026-09-25T16:17:11Z`; follow-up `sent_at =
2026-09-24T22:05:16.352Z`; and lead suppression/reactivation fields.

## Detailed findings

### Leads

- Total V1 leads: 3,509.
- Missing V2 lead IDs: 0.
- V2-only: 7, preserved and not deletion candidates.
- Semantically identical across all mapped fields: 3,507.
- Two value mismatches, only in `status` and `updated_at`:
  - `301ae5f8-7950-4cf1-a5c6-b4c1da7bbfa8`: V2 `replied` at
    `2026-09-17T01:00:39Z`; V1 `dead` at `2026-09-27T05:51:29Z`.
  - `d8a11683-6036-4166-a9f3-c4ecabce86b4`: V2 `replied` at
    `2026-09-25T16:17:35Z`; V1 `dead` at `2026-09-27T05:44:03Z`.
- No mapped business/contact/research/social/suppression/reactivation field
  differs on any other shared lead.
- Duplicate normalized-recipient relationships are pre-existing data shape,
  not duplicate lead IDs: V1 has 173 keys / 457 related rows / 284 excess
  relationships; V2 has 174 / 460 / 286 because of V2-only test rows.
- Every V2 lead is in the seed workspace; no cross-workspace/null workspace row.

Because `dead` is safer for future sending than `replied`, Phase 2 must never
weaken it. These remain manual because no per-row baseline proves which side is
authoritative.

### Email, follow-up, DM, reply, and reactivation state

- Effective V1 emails: 11,842; all 11,842 IDs and every mapped value match V2.
- New V1 email/sent history/reply markers/provider IDs/message IDs/status or
  send-time changes: 0.
- Reply markers: 56 effective rows on each side; all values match.
- Historical V1 `sent`: 10,553; bounced 109; suppressed 34; failed 1,139.
- Valid effective V1 pending drafts: 7.
- Redundant drafts: exactly 267, all `pending_send`, paired with a retained
  delivered phase record. V2 has zero duplicate open/delivered natural keys.
- V2-only emails: 5; preserve.
- Follow-ups: all 8,087 V1 rows match; V2-only 2; preserve.
- DM queue: all 10 match.
- Deals: zero on both sides.
- Reactivation fields and the 108 effective reactivation emails match.

Historical delivered/sent means an effective email with `status='sent'` (or
the original tool's delivered partial-key status `email_sync_failed`). A valid
pending draft is the retained row for an otherwise unique `(lead_id,type)`
phase. A redundant draft is a skipped `pending_send` member of a duplicate
original-rule group for which the retained record is preferred. Phase 2 must
rerun the exact original algorithm and assert the skipped-ID set remains 267,
not merely trust this count.

### Suppression

All safety-sensitive suppression checks are zero-delta:

- V1 lead-level suppression missing in V2: 0.
- V1 delivery-suppressed address sets missing members in V2: 0.
- Lead suppression-state disagreement: 0.
- V1 bounced/suppressed terminal email state weakened in V2: 0.

Phase 2 rule remains monotonic: combine delivery suppression by normalized set
union; never clear a non-null/manual suppression; never convert
`delivery_uncertain`, bounced, or suppressed state to a weaker state. Any such
future disagreement is `MANUAL_REVIEW`.

### Recipient ownership

- Counts: 3,217 / 3,217.
- Exact matches: 3,215.
- Missing/extra/duplicate natural keys: 0.
- Orphan owners: 0.
- Conflicts: 2. Both sides say `active`, but owner IDs, claim/activity times,
  and metadata differ. V2 owners are the V2-only canary/test leads
  `5c4a6b00-0000-4000-8000-00000000c003` and
  `b0e00000-0000-4000-8000-000000000101`, with claims on 18 September.

Recipient addresses are represented in the audit output only by SHA-256. Phase
2 must skip these two records. It must not overwrite a newer/conflicting V2
owner. A human must decide whether to retain the V2 canary ownership, release it
through an approved product path, or restore V1 ownership after the canary data
is intentionally retired.

### Deals, inbound, and lifecycle

There are no deals. All 56 reply markers match. V1 has 192 durable inbound
receipts that the original migration omitted; V2 has none. Their status mix is:
67 processed, 77 unmatched, 22 unmatched-ambiguous, 15 failed, and 11 ignored.
IDs and all 192 `receipt_key` natural keys are unique and absent from V2.

The three safe activity inserts are:

- two `inbound_reply_unmatched` events referencing source-only receipts; and
- one `digest_sent` historical event.

The inbound ledger should be inserted before those activity records so that V2
cannot later treat already-observed provider receipts as new work.

### Categories and templates

Every V1 mapped category, template, suburb priority, and search-state row is
semantically identical in V2. Natural-key duplicates/conflicts are zero for:

- category `lower(trim(name))`;
- `(category_id,template_type)`;
- `(category_id,city_suburb_id)` for priorities and search state.

The four V2-only categories, four V2-only templates, three V2-only suburbs, and
their V2-only category-policy fields are `V2_INTENTIONAL_CHANGE` / `V2_ONLY`.
They must not be overwritten or deleted. Existing Template/Personalized and
category-policy architecture remains authoritative.

### Settings

Twenty of the 21 original allowlisted business settings match. `system_active`
is the only mismatch: V1 `true`, V2 `false`. It is both a historical allowlist
member and an execution gate. For this final sync it is `MANUAL_REVIEW` plus an
explicit Phase 2 denylist: preserve V2 `false`.

The six excluded V1 keys remain excluded:
`daily_outscraper_limit`, `google_maps_cost_per_request`,
`google_maps_monthly_limit`, `google_maps_spend_reset_month`,
`google_maps_spend_this_month`, and `primary_search_api`.

No secret, API key, OAuth/provider credential, deployment gate, billing,
security, or SaaS setting is a migration candidate.

## Natural-key, duplicate, and integrity findings

Hosted V2 catalog confirms these operative keys:

- ownership PK `(workspace_id,normalized_email)`;
- inbound unique `(workspace_id,receipt_key)`;
- category index `(workspace_id,lower(trim(name)))`;
- template and category/suburb unique keys partitioned by workspace;
- unique `(workspace_id,resend_id)` for non-null provider IDs;
- activity inbound-event key `(workspace_id,event_type,
  metadata->>'inbound_receipt_id')` when the receipt ID is non-null;
- email partial indexes for delivered, pending initial, and open-or-delivered
  `(workspace_id,lead_id,type)` states.

There are zero source or seed-target orphans across every mapped FK:
category/template/priority/search-state references; lead/category; email/lead;
follow-up/lead and email; deal/lead; DM/lead; ownership/lead; activity/lead.
Every audited V2 tenant table has zero null workspace rows and zero rows outside
the seed workspace. There are no source or target natural-key duplicates except
the 267 intentional raw V1 email phase groups. There are no resend-ID duplicates.

The proposed 195 safe inserts reference no missing parent. The two inbound
activity rows reference receipts included earlier in the same proposed order.

## Conflict/change-history classification

There is no trustworthy baseline snapshot, so the primary historical labels
are `SOURCE_ONLY`, `TARGET_ONLY`, `VALUE_MISMATCH`, and `MATCH`; no fabricated
three-way history is claimed.

- `SOURCE_ONLY`: 192 inbound receipts and 3 activity events.
- `TARGET_ONLY`: 71 rows across mapped operational tables; preserved as
  `V2_ONLY`.
- `VALUE_MISMATCH`: two leads, two ownership rows, one setting.
- `MATCH`: 64,024 operational rows plus 20 allowlisted settings.

The two lead timestamp sequences strongly suggest a V1-only post-rehearsal
change, but are still manual. Ownership is `BOTH_CHANGED_CONFLICT` only as an
inference from the V2 canary owners and later claim dates; without baseline
values, the formal label remains `VALUE_MISMATCH / CONFLICT`.

## Phase 2 controlled sync design (not executed)

Extend `scripts/migrate-v1-to-v2-rehearsal.ts`; do not create an unrelated
migration system. Split it into a reusable mapping/normalization module and
separate `audit`, `plan`, and guarded `execute-plan` entry points.

### Preconditions

1. Keep all V1 access structurally SELECT-only. Prefer a direct V1 DB role with
   `default_transaction_read_only=on` and one `REPEATABLE READ, READ ONLY`
   snapshot. If that cannot be supplied, briefly quiesce V1 writers and rerun
   the two-pass audit until counts/hashes match. REST pagination alone cannot
   provide a global consistent snapshot.
2. Re-prove both project identities by the same independent markers. Refuse V1
   and V2 equality, unknown refs, unknown workspace, or a V2 credential whose
   project cannot be corroborated.
3. Assert every send/Finder/Trigger/AI/Hostinger/shadow gate is false, including
   V2 `system_active=false`. The importer must not import gate values.
4. Generate a deterministic plan artifact containing source snapshot identity,
   exact IDs/natural keys, canonical row hashes, classifications, and the 267
   expected skipped email IDs. Require an explicit review token bound to the
   artifact hash.
5. Refuse execution if any previously safe row has changed, any count/hash is
   stale, any new natural-key conflict appears, or any manual/conflict record is
   included.

### Exact algorithm

1. Read V1 snapshot; map only explicit common columns; add the literal seed
   workspace ID. Never copy V2-only columns.
2. Reapply the original email dedup function and validate all partial email
   indexes in memory. Preserve all V2 `delivery_uncertain` rows and reject any
   phase collision rather than resolving it.
3. Resolve by primary key first, then the exact hosted natural keys listed
   above. Compare canonical JSON with sorted object keys, exact arrays, nulls,
   and timestamps. Do not trim/normalize values beyond the schema-defined
   category/email natural keys and original mapping.
4. Build the allowlist: 192 inbound receipts plus three activity rows if they
   remain source-only and conflict-free. Keep both leads, both ownership rows,
   and `system_active` out of the executable plan.
5. Connect to V2 only after re-verification. Start one transaction and take a
   dedicated advisory lock for this importer. Re-select every target key with
   row locks and revalidate absence/hash predicates.
6. Insert inbound receipts first using explicit IDs, mapped values, and seed
   workspace. Conflict on either ID or `(workspace_id,receipt_key)` aborts the
   whole transaction; do not `DO UPDATE`.
7. Insert the three activity rows next. Conflict on ID or inbound-event natural
   key aborts. No email, follow-up, lead, ownership, category, or setting write
   occurs in this safe pass.
8. Run all postconditions inside the same transaction. Commit only if every
   expected count, hash, natural key, FK, workspace, duplicate, and suppression
   assertion passes. Otherwise roll back.
9. Rerun dry-run. It must report zero safe inserts, the same 267 expected
   deduplications, the unresolved records still skipped, and no new conflict.

The importer must use direct database inserts only and import no `pending`,
`queued`, or `processing` inbound receipt (none currently exist). It must not
call application routes, RPCs, webhook processors, mail providers, jobs, or
external services. Current safe inserts do not require lead updates or their
derived-quality trigger path.

### Proposed execution order

1. Identity/gate/workspace checks.
2. Consistent V1 snapshot and complete dry-run plan.
3. In-memory dedup/natural-key/FK/suppression validation.
4. Begin V2 transaction and advisory lock.
5. Revalidate target preconditions.
6. Insert 192 `inbound_receipts`.
7. Insert 3 `activity_log` rows.
8. In-transaction verification.
9. Commit; rerun read-only audit.
10. Separately review, never automatically apply, the two lead and two
    ownership decisions. Keep `system_active=false`.

### Rollback

Before execution, store an encrypted/local review artifact with the exact 195
IDs, natural keys, canonical hashes, and target pre-counts. The primary rollback
is transaction rollback before commit. If a post-commit compensating rollback
is explicitly authorized, delete only rows whose IDs and full hashes equal the
insert manifest, in reverse order (`activity_log`, then `inbound_receipts`), in
one transaction. Abort rollback if any row changed. There is no broad delete,
truncate, workspace reset, or V1 action. No update rollback is needed for the
proposed safe pass.

## Exact post-Phase-2 verification

Run only against explicitly verified V2, parameterizing `$1` as the seed
workspace and comparing against the signed plan manifest:

```sql
-- Workspace and planned inserts.
SELECT count(*) FROM public.inbound_receipts WHERE workspace_id = $1; -- 192
SELECT count(*) FROM public.activity_log WHERE workspace_id = $1;     -- pre + 3

SELECT count(*) FROM public.inbound_receipts
WHERE workspace_id = $1 AND id = ANY($2::uuid[]);                    -- 192
SELECT count(*) FROM public.activity_log
WHERE workspace_id = $1 AND id = ANY($3::uuid[]);                    -- 3

-- No null/other-workspace planned IDs.
SELECT count(*) FROM public.inbound_receipts
WHERE id = ANY($2::uuid[]) AND workspace_id IS DISTINCT FROM $1;      -- 0
SELECT count(*) FROM public.activity_log
WHERE id = ANY($3::uuid[]) AND workspace_id IS DISTINCT FROM $1;      -- 0

-- Natural-key uniqueness.
SELECT count(*) FROM (
  SELECT receipt_key FROM public.inbound_receipts
  WHERE workspace_id = $1 GROUP BY receipt_key HAVING count(*) > 1
) d;                                                                  -- 0
SELECT count(*) FROM (
  SELECT event_type, metadata->>'inbound_receipt_id'
  FROM public.activity_log
  WHERE workspace_id = $1 AND metadata->>'inbound_receipt_id' IS NOT NULL
  GROUP BY event_type, metadata->>'inbound_receipt_id' HAVING count(*) > 1
) d;                                                                  -- 0

-- Activity receipt references in the plan resolve.
SELECT count(*)
FROM public.activity_log a
WHERE a.workspace_id = $1
  AND a.id = ANY($3::uuid[])
  AND a.metadata->>'inbound_receipt_id' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.inbound_receipts r
    WHERE r.workspace_id = $1
      AND r.id::text = a.metadata->>'inbound_receipt_id'
  );                                                                  -- 0

-- Existing safety invariants remain unchanged.
SELECT count(*) FROM (
  SELECT resend_id FROM public.emails
  WHERE workspace_id=$1 AND resend_id IS NOT NULL
  GROUP BY resend_id HAVING count(*) > 1
) d;                                                                  -- 0
SELECT count(*) FROM (
  SELECT lead_id,type FROM public.emails
  WHERE workspace_id=$1
    AND status IN ('pending_send','sending','sent','delivery_uncertain','email_sync_failed')
  GROUP BY lead_id,type HAVING count(*) > 1
) d;                                                                  -- 0
SELECT value FROM public.settings WHERE key='system_active';           -- false
SELECT has_schema_privilege('reachagent_function_owner','public','CREATE'); -- false
```

In addition, rerun the TypeScript audit and require: email effective
missing/mismatched = 0; expected dedup = 267; source-only inbound/activity = 0;
all mapped FK orphan counts = 0; all audited `other_workspace` and
`null_workspace` counts = 0; suppression weakening counts = 0; and the two
ownership plus two lead decisions still excluded or explicitly resolved.

## No-mutation attestation and local files

Hosted V1 remained read-only. Hosted V2 remained read-only. This phase executed
only REST `GET`/`HEAD` selections and literal PostgreSQL catalog `SELECT`s.
No INSERT, UPDATE, DELETE, UPSERT, TRUNCATE, ALTER, CREATE, DROP, mutating RPC,
migration, migration-history repair, database push, email, Trigger job, AI call,
Stripe call, Finder run, Hostinger mutation, gate change, deployment, Git commit,
push, or deploy was executed by this audit.

Created locally and intentionally left uncommitted:

- `scripts/audit-final-v1-v2-delta.ts`
- `docs/FINAL_V1_V2_DELTA_AUDIT.md`

All pre-existing unrelated modified/untracked paths were preserved unchanged,
including `.claude/settings.local.json`, `.commandcode/`,
`supabase-v2/build/curate_source.sql`, `supabase-v2/.branches/`,
`supabase-v2/supabase/`, `supabase/.temp/`, and all `.env*` files.

## Blockers, safety decision, and next step

Blockers/uncertainties:

1. No exact previous cutoff or baseline snapshot exists.
2. V1 is live and `system_active` changed during this audit, so REST pagination
   cannot claim a single globally consistent instant.
3. Two lead lifecycle decisions and two ownership conflicts require human
   disposition. `system_active` must stay V2 `false` regardless.
4. `inbound_receipts` is operationally important but was absent from the
   original tool; Phase 2 must extend and test that tool explicitly.

No destructive action is required or proposed. Phase 2 appears safe for the
195 insert-only rows under the guarded algorithm; it is not safe for automatic
full reconciliation.

**Exact next step:** review and approve this plan, decide whether the safe pass
should include all 192 historical inbound receipts, and provide either a
transaction-consistent read-only V1 connection or an approved short V1 writer
quiescence window. Then implement only the dry-run plan generator/validator,
rerun it immediately against both verified projects, and return that artifact
for approval before writing any V2 row.
