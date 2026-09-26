# V1 → V2 migration rehearsal

Date: 26 September 2026 (Australia/Sydney)

Result: **V1 → V2 MIGRATION REHEARSAL PASS**

V1 `obppfnujusqiwjhwzosv` was read-only throughout. V2
`ojrxfjlgjhzhdpnkyboa` was the only writable target. No real email send, no
Trigger.dev job, no paid AI call, no Finder run, and no production cutover
occurred.

## Purpose

Rehearse copying V1 business data into the V2 workspace-scoped schema without
touching V1, sending email, or invoking any Trigger job. The migration is
idempotent and workspace-scoped: every migrated row is tagged with the target
workspace `00000000-0000-0000-0000-000000000001`.

## Script and commands

- Script: `scripts/migrate-v1-to-v2-rehearsal.ts`
- Preview (zero target writes): `npm run migrate:v1-v2:preview`
- Execute (writes, requires confirm token): `npm run migrate:v1-v2:rehearsal`
- Validate (read-only): `npm run validate:v1-v2:rehearsal`

Execute is gated by `MIGRATION_REHEARSAL_CONFIRM=V1_TO_V2_REHEARSAL` and refuses
to run without it. The module exposes no mutation path against V1.

## Migration model

- **V1 source** is a read-only client (`ReadOnlyV1Source`) built from
  `.env.local`; mutation methods are intentionally absent.
- **V2 target** is `.env.v2.local`. The script asserts the V1 service-role key
  decodes to ref `obppfnujusqiwjhwzosv`, the V2 host is
  `ojrxfjlgjhzhdpnkyboa`, and the two projects are distinct.
- **Workspace scoping**: every row is upserted with
  `workspace_id = 00000000-0000-0000-0000-000000000001`. V2-only columns
  (category-policy facts, send envelope, `categories.exclude_*`, etc.) are not
  listed and keep their V2 defaults.
- **Conflict strategy**: `ON CONFLICT DO NOTHING`, so re-running is a no-op once
  applied.
- **Email dedup**: V2 enforces one open/delivered email per `(lead_id, type)`
  via a partial unique index. Redundant non-terminal drafts are dropped, keeping
  the delivered `sent` record.
- **Settings**: only the 21-key business allowlist is migrated; runtime/infra,
  provider, and spend-telemetry keys are excluded.
- **`lead_data_quality_flags` is excluded** and derived deterministically in V2
  from `leads` via a trigger, avoiding collision on the partial unique index.

## Rehearsal results

Preview reported `rows_to_insert=0` and `rows_already_present=64028`, confirming
the execute step had already completed and is idempotent. The 64,028 rows are
distributed as:

| Table | V1 rows | V2 target-workspace rows | Present |
|---|---|---|---|
| categories | 31 | 35 | YES |
| city_suburbs | 351 | 354 | YES |
| category_email_templates | 155 | 159 | YES |
| category_suburb_priorities | 264 | 264 | YES |
| category_suburb_search_state | 1461 | 1461 | YES |
| leads | 3509 | 3516 | YES |
| emails | 11842 | 11847 | YES |
| follow_ups | 8087 | 8089 | YES |
| deals | 0 | 0 | YES |
| dm_queue | 10 | 10 | YES |
| recipient_outreach_ownership | 3217 | 3217 | YES |
| activity_log | 35101 | 35129 | YES |

The small per-table excess in V2 is pre-existing disposable test data with
non-overlapping IDs; it is left untouched. `emails` dropped 267 redundant
non-terminal `(lead_id, type)` records. 21 business settings were migrated; 6
runtime/infra keys were excluded.

## Validation

`--validate` compared V1 against the target workspace and ran direct SQL
integrity checks over the V2 Postgres connection:

- All 12 tables: `all_V1_present=YES`, `missing=0`.
- Workspace scope: every table has zero null `workspace_id` and zero
  other-workspace rows.
- Foreign keys: no orphaned references across workspaces.
- Duplicate `emails.resend_id`: 0.

Status/type distribution mismatches are fully explained by the pre-existing V2
test data (the "extra" counts above) and are not a migration defect.

## Idempotency

Re-running `--execute` is safe: it re-reads V1, re-dedupes emails, and upserts
with `ON CONFLICT DO NOTHING`, leaving existing rows unchanged. `--preview` and
`--validate` are read-only and can be re-run freely.

## Production cutover

This rehearsal does not constitute a production cutover. No V1 data was
modified, no email was sent, and no Trigger job was created or invoked.
