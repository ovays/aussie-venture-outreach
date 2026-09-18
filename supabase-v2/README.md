# ReachAgent V2 Supabase root

This directory is the only migration root for ReachAgent V2.

- V1 history remains frozen in `../supabase/migrations/001_*` through `054_*`.
- V2 tooling must run with `supabase-v2` as its working directory/config root.
- Never copy, link, or configure `../supabase/migrations` beneath this root.
- The first V2 migration is `migrations/00000000000000_reachagent_v2_golden_baseline.sql`.
- Later V2 schema changes must be new incremental files in `supabase-v2/migrations`.

The baseline assumes a Supabase project already supplies `auth.users`, `auth.uid()`,
`auth.role()`, and the platform roles `anon`, `authenticated`, and `service_role`.
The disposable PostgreSQL test harness creates only those platform stubs before
applying the baseline.

`seed.sql` is intentionally empty: the approved universal provider/workflow keys
are not required for schema restore, and provider/model availability is deployment
configuration rather than a safe universal constant. Aussie Venture configuration
and all business/operational data are later import artifacts.
