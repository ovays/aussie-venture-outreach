# ReachAgent V2 golden baseline verification

Original verification date: 14 September 2026 (Australia/Sydney)
Hosted-compatibility revision: 16 September 2026 (Australia/Sydney)
Contract: section 17 of `docs/reachagent-v2-golden-baseline-design.md`
Outcome: **VERIFIED**

## Migration isolation and artifacts

V1 remains frozen and untouched at `supabase/migrations/001_*` through `054_*`.
V2 uses the independent `supabase-v2` configuration and migration root. Nothing
under `supabase/migrations` is linked or copied into it, so V2 tooling cannot
discover or replay the historical files when invoked from the V2 root.

| Artifact | Result |
|---|---|
| Migration | `supabase-v2/migrations/00000000000000_reachagent_v2_golden_baseline.sql` |
| Migration size | 223,752 bytes |
| Current SHA-256 | `797D845B5505D7BA6B5AFE856582D4D08B9919614BBD791E507C81A9235C24C4` |
| Superseded SHA-256 | `C193213A560FB3BB29CB0ECAC2324F4D7B4151F480E8C1FD676143435BC9BDA2` |
| Seed | `supabase-v2/seed.sql` (intentionally empty; comments only) |
| Catalog/functional tests | `supabase-v2/tests/verify_catalog_and_behavior.sql` |
| Negative security tests | `supabase-v2/tests/verify_security_negative.sql` |
| Production preflight | `supabase-v2/build/readonly_production_preflight.mjs` |

The migration is a curated, dump-derived artifact. The verified production dump
was restored only into a disposable source-catalog database, then the unrelated
product objects were removed and every approved V2 schema/security change was
applied. A fresh dump of that curated catalog was manually reconciled for the
canonical status contract, Supabase migration-runner compatibility, required
extension creation, the Auth trigger, and the no-login function owner. It is not
a mechanical copy of production.

The 16 September revision changes only the ownership bootstrap needed for hosted
Supabase compatibility. The project `postgres` credential cannot transfer schema
ownership to the platform-managed `supabase_admin` role. The baseline therefore
leaves `extensions` under its existing platform owner, temporarily grants the
migration session membership in `reachagent_function_owner`, assigns
`reachagent_private` and all approved definer routines to that NOLOGIN owner, and
revokes the migration-issued `INHERIT`/`SET` membership before completion. A
temporary `CREATE` grant on `public`, required by PostgreSQL for function
ownership transfer, is also revoked. Any platform-issued creator membership
remains restricted to `ADMIN`
only, with neither `INHERIT` nor `SET`. Explicit schema/function revokes and grants
remain in force. This is not a functional product/schema-intent change.

Hosted-like non-superuser verification then proved one related compatibility issue
in `00000000000001`: it replaces an existing private function owned by the NOLOGIN
role. That migration now obtains and revokes the same temporary migration-issued
membership around its existing statements. Its SHA-256 changed from
`62C97F96799A01B5245456C00A530DA2B1631C0D10489F61C987E395B4901D14`
to `75DA9844FB2BAAFC3CF1E46AE8E85E792F256CCD22909FB759D5090DF95D25D1`.
No function body or product/schema intent changed. Migration `00000000000002`
needed one proven hosted-default-ACL compatibility edit: its workflow-table revoke
now includes `service_role` before the same explicit allowlist is granted. Its
SHA-256 changed from `685CF5F20DBF61320772909EA55F6994E7D697ADCCECDC5A24A49C4CB56D5083`
to `CB07CE3BA5D469B8F47B168923D16FC7BEE8CC9208609A04C33E9534BD2E544B`.
No table, policy, function body, or intended role capability changed.

Hosted verification also proved Supabase injects broad direct grants/default
ACLs for new `public` objects. The golden baseline now clears those direct grants
before rebuilding its existing explicit allowlist and revokes the broad future
defaults for `postgres`. This restores the original locally verified ACL intent;
it does not change functional product/schema intent. Managed `supabase_admin`
defaults remain platform-owned and unchanged; ReachAgent does not create objects
as that role.

## Disposable restore

| Item | Value |
|---|---|
| Runtime | Docker Engine 29.8.0 |
| Image | `public.ecr.aws/supabase/postgres:17.6.1.104` |
| PostgreSQL | 17.6 |
| Verification database | `reachagent_v2` in disposable container `reachagent-v2-verify` |
| Platform preparation | Minimal local-only `auth.users`, `auth.uid()`, and `auth.role()` stubs; these are supplied by real Supabase and are not in the migration |
| Restore order | empty database -> platform stubs -> V2 baseline only -> empty V2 seed -> tests |
| V1 migrations applied | 0 |
| Production dump layered into target | No |
| Final exact-file restore | PASS |

The final run used `ON_ERROR_STOP=1` and returned both
`VERIFY_CATALOG_AND_BEHAVIOR_PASS` and `VERIFY_SECURITY_NEGATIVE_PASS`.

## Catalog comparison

The clean restored catalog was compared with the curated source catalog using
ordered canonical queries. Results were exact for:

| Catalog surface | Restored result | Comparison |
|---|---:|---|
| Public owned tables | 25 | exact required set; PASS |
| Public columns | 272 | 272 source / 272 target / 0 differences |
| Constraints | 88 | 88 / 88 / 0 differences |
| Check constraints | 35 | PASS |
| Foreign keys | 18 | PASS |
| Primary keys | 25 | one per owned table; PASS |
| Unique constraints | 10 | PASS |
| Public indexes | 75 | 75 / 75 / 0 differences |
| Public functions | 40 | expected curated surface; PASS |
| Private invoker implementations | 10 | expected hardening support; PASS |
| Function signatures/security/owners/ACLs | 50 | 50 / 50 / 0 differences |
| Public SECURITY DEFINER functions | 15 | exact decision-matrix count; PASS |
| ReachAgent triggers including Auth | 13 | 13 / 13 / 0 differences |
| Public RLS policies | 47 | canonical policy comparison: 0 differences |
| RLS enablement | 25/25 enabled; 0 forced | PASS |
| Public views/materialized views | 0 | PASS |
| Public sequences | 0 | PASS |
| Required extension | `pg_trgm` 1.6 in `extensions` | PASS |

All excluded `clients`, `customers`, `conversations`, `bookings`, `escalations`,
`knowledge_base`, `weekly_reports`, and their three views are absent.

Function-body hashes differ from the curated production-derived source for only
seven functions: dashboard/email summaries, recipient claim/release, and three
data-quality reports. Each difference is the approved removal of `closed_won`
from lifecycle logic. The wrapper/redesign bodies are already part of the curated
source comparison and match the restored baseline.

## Approved differences from production

| Difference | Approved V2 result |
|---|---|
| Ownership boundary | Only the 25 ReachAgent tables; unrelated WhatsApp/bookings objects excluded; private schema and definer routines owned by the application NOLOGIN role with no retained `SET`/`INHERIT` membership or `CREATE` on `public` |
| `city_suburbs.priority` | `integer NOT NULL DEFAULT 1`, checked from 1 through 10 |
| Lead lifecycle | Exactly `new`, `researched`, `email_ready`, `contacted`, `replied`, `interested`, `negotiating`, `closed`, `closed_manual`, `dead` |
| `category_id` | Remains nullable for staged remediation; column comment requires a later validated migration to set `NOT NULL` only after ambiguous/unmatched counts reach zero or are explicitly quarantined |
| Lead normalization | One deterministic BEFORE trigger trims names/emails, nulls blanks, and derives normalized email in the same function |
| Auth profile creation | Always member/active; display name only from metadata; no role/admin-email fallback |
| RLS | Enabled on all 25 tables, not forced |
| Anon/PUBLIC | No public-schema usage, table grants, or SECURITY DEFINER execution |
| Member/admin/service ACL | Explicit grants plus role/profile policies; no broad production `ALL` pattern |
| Default privileges | No future grants to anon/authenticated/service role |
| SECURITY DEFINER | 15 fixed-path functions owned by `reachagent_function_owner` (`NOLOGIN BYPASSRLS`); private implementations are invoker-only and have no client schema access |
| Sensitive quality mutations | Caller-supplied actor parameters removed; user actor derives from `auth.uid()`; service calls audit as system/service role |
| Extensions | Only required `pg_trgm`; moved from production `public` to locked `extensions`; dependent opclasses are qualified |
| Seeds | No customer or operational data and no universal seed dependency |

The redesigned quality RPC signatures intentionally omit `p_actor_id`:

- `remove_data_quality_emails(uuid[])`
- `set_data_quality_flag_status(text,text,uuid[],text,text)`

The later isolated V2 application environment must update its callers before
application compatibility can pass. No application code was changed here.

## RLS, ACL and SECURITY DEFINER tests

PASS. Tests verified:

- anon cannot read/mutate leads, read settings, call operational RPCs, or call any SECURITY DEFINER function;
- authenticated active members can read/insert/update approved operational rows but cannot delete leads;
- inactive members cannot insert operational rows;
- members cannot mutate configuration, update `profiles.role`, read locks, call admin reports, or execute service claim functions;
- admins can manage approved category/suburb configuration and call guarded reports/actions;
- `set_data_quality_flag_status` records the authenticated admin from `auth.uid()`;
- service role can claim recipient ownership and inbound receipts;
- every definer routine has the fixed trusted path, no-login owner, no anon/PUBLIC execute, and the approved role grant;
- `PUBLIC`, anon, and authenticated cannot create in `public`;
- no broad client/service default ACL exists.

## Functional database tests

PASS. Synthetic-only fixtures verified:

- `' test@example.com '` becomes `email='test@example.com'` and `normalized_email='test@example.com'`;
- whitespace email becomes null and normalized email becomes null;
- priority 0 and 11 are rejected; default/in-range priority is accepted;
- `interested` is accepted; `dm_queued` and `closed_won` are rejected for leads;
- valid category FK works, invalid FK is rejected, and null remains loadable;
- email-change suppression recomputation/clearing works;
- data-quality trigger creates an open flag for invalid email;
- recipient claim and inbound receipt claim functions work for service role;
- updated-at triggers work;
- Auth insert creates a profile, and metadata containing `role=admin` still creates `role=member`.

## Read-only production migration preflight

The preflight used PostgREST `SELECT` operations only. It made no RPC or mutation
request and printed no credential. These counts are migration-readiness evidence,
not a backfill.

### Null `category_id` classification

Normalization: Unicode NFKC, trim, collapse internal whitespace, locale-stable
`en-AU` lowercase. Fuzzy matching is forbidden. No reviewed alias artifact exists,
so Alias-map is correctly zero rather than inventing aliases.

| Classification | Count |
|---|---:|
| Auto-map (exactly one normalized category) | 3,111 |
| Alias-map (reviewed alias) | 0 |
| Ambiguous | 0 |
| Unmatched | 55 |
| Total null-category leads | 3,166 |

Count conservation passed. The current count is newer than the 2,884 historical
count recorded during earlier design work; production continued receiving data.

Unmatched category-name groups:

| Category name | Count |
|---|---:|
| Boutique Hotels | 38 |
| Indoor Activities | 14 |
| Halal Bakeries | 1 |
| Manual | 1 |
| Test | 1 |

By status, unmatched rows are 40 contacted, 12 dead, and 3 replied. By source,
54 have null source and 1 is manual. These 55 rows require reviewed alias/direct
mapping or explicit quarantine before the later `category_id NOT NULL` migration.

### Source `city_suburbs.priority`

| Metric | Count |
|---|---:|
| Total | 351 |
| Null | 0 |
| Below 1 | 0 |
| Above 10 | 0 |

The source data is ready for the strengthened priority contract without value
remediation.

## Secrets and data-boundary scan

PASS. The baseline, seed, V2 config, build helpers, and tests were scanned for
JWT-like values, common provider/API-key prefixes, private-key headers, credential
assignments, production email/URL literals, and customer data. No match was found.
The migration contains schema/function DML statements but no seed `COPY` or
customer-data insert. Synthetic fixture data exists only in the test SQL.

## Failures and blockers

Intermediate verification corrected three fixture/assertion mistakes (PostgreSQL
`PUBLIC` ACL inspection, a suppression test address classified as low quality,
and an invalid inbound-receipt fixture status). A fourth run exposed a real private
helper resolution issue during member lead insertion; the baseline was fixed to
resolve the trusted private refresh helper first.

One discarded negative-test helper caused PostgreSQL 17.6 to terminate a backend
when it changed role inside PL/pgSQL and then invoked a definer function. This was
an artificial harness pattern, not an application path. The helper was removed;
the same denial is now proved by explicit ACL inspection. PostgreSQL recovered,
the database was dropped and recreated, and the final exact-file restore plus both
test suites passed from zero.

Remaining baseline build/verification blockers: **none**.

Remaining later-phase data blocker: the 55 unmatched category rows must be
reviewed before production data migration can enforce `category_id NOT NULL`.

## Final status

**V2 GOLDEN BASELINE STATUS: VERIFIED**

The hosted-compatible revision and its two proven incremental-migration wrappers
were subsequently verified from zero under a non-superuser `postgres` role and
applied to the isolated hosted V2 project. Final hosted catalog/security
verification passed on 16 September 2026; see
`docs/reachagent-v2-hosted-db-verification.txt` and the deployment record.

The next approved step is to create an isolated ReachAgent V2 application
environment and reconcile its generated types/RPC callers against this verified
database. Production migration, cutover, multi-tenancy and deployment remain
unapproved.
