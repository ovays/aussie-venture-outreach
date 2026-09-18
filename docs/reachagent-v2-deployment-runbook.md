# ReachAgent V2 isolated deployment runbook

Stop immediately if any value points to Supabase `obppfnujusqiwjhwzosv`, Trigger.dev `proj_pkyxowcjibwfokooeqaw`, a V1 Vercel project/alias, or copied V1 credentials. Never link this checkout ambiguously and never run V1 migrations `001`–`054`.

## 1. Create the V2 Supabase project

In the Supabase dashboard, create a new empty project named clearly for ReachAgent V2 staging. Do not clone V1 and do not import data. Record only in an approved secret manager/operator shell: project ref, API URL, anon key, service-role key, and direct or session-pooler database URL. The database URL identity (hostname or username) must contain the new 20-character project ref.

Set the operator shell variables without writing them to the repository:

```powershell
$env:REACHAGENT_ENV='v2_staging'
$env:NEXT_PUBLIC_REACHAGENT_RUNTIME='v2'
$env:V2_SUPABASE_PROJECT_REF='<new-v2-ref>'
$env:NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF='<new-v2-ref>'
$env:NEXT_PUBLIC_SUPABASE_URL='https://<new-v2-ref>.supabase.co'
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY='<new-v2-anon-key>'
$env:SUPABASE_SERVICE_ROLE_KEY='<new-v2-service-role-key>'
$env:V2_SUPABASE_DB_URL='<new-v2-postgres-url>'
```

Explicitly set all gates to `false`: `ORCHESTRATOR_ENABLED`, `ORCHESTRATOR_SHADOW`, `OUTREACH_SEND_ENABLED`, `TRIGGER_JOBS_ENABLED`, `FINDER_SCHEDULE_ENABLED`, `HOSTINGER_MUTATIONS_ENABLED`, `SHADOW_OBSERVABILITY_WRITE_ENABLED`, and `V2_SHADOW_ALLOW_PRODUCTION_READS`. Leave V1 aliases and `V2_SHADOW_SUPABASE_*` unset.

## 2. Apply and verify the database

Install PostgreSQL client tools so `psql` is available. Run:

```powershell
npm run db:v2:apply:hosted -- -ProjectRef <new-v2-ref>
```

The script fails unless the ref is explicit and non-V1, target identity matches it, public schema is empty, all gates are explicitly false, the migration directory contains exactly three files, and all three hashes match. It applies only golden baseline `00000000000000`, performance/reliability `00000000000001`, then observability `00000000000002`. It runs the catalog/security/no-real-data verification and writes `docs/reachagent-v2-hosted-db-verification.txt`. Re-run verification with `npm run db:v2:verify:hosted -- -ProjectRef <new-v2-ref>`.

Approved hosted-compatible golden SHA-256: `797D845B5505D7BA6B5AFE856582D4D08B9919614BBD791E507C81A9235C24C4` (supersedes `80266A4A68FE173F721B3E00BB7C2B31A54CF8FF02D78EBC4FF88CC40A898A39`). The revision preserves the exact managed `auth.uid()`/`auth.role()` claim semantics inside the dedicated-owner routines without requiring an unavailable grant on Supabase's managed `auth` schema. It retains the hosted-compatible ownership transfer and explicit ACL allowlist, and does not change product tables, columns, constraints, policies, or behavior.

Approved hosted-compatible performance/reliability SHA-256: `75DA9844FB2BAAFC3CF1E46AE8E85E792F256CCD22909FB759D5090DF95D25D1` (supersedes `62C97F96799A01B5245456C00A530DA2B1631C0D10489F61C987E395B4901D14`). Its only change is the proven temporary membership wrapper required to replace the existing private NOLOGIN-owned function. Each migration file is applied in one transaction.

Approved hosted-compatible observability SHA-256: `CB07CE3BA5D469B8F47B168923D16FC7BEE8CC9208609A04C33E9534BD2E544B` (supersedes `685CF5F20DBF61320772909EA55F6994E7D697ADCCECDC5A24A49C4CB56D5083`). Its only change is revoking hosted-injected `service_role` table privileges before granting the existing explicit workflow-table allowlist.

## 3. Create the V2 Trigger.dev project

In Trigger.dev dashboard, create a distinct project such as `reachagent-v2-staging`. Copy its project ref and secret only into the V2 environment. Set `TRIGGER_V2_PROJECT_REF` and `TRIGGER_SECRET_KEY`; never set `TRIGGER_PROJECT_ID` or `TRIGGER_SECRET_KEY_PROD`. Confirm the ref is not the known V1 ref. `trigger.config.ts` pins `runtime: "node-24"` and fails closed on missing/V1 refs.

Do not deploy tasks for the first application smoke. The source inventory includes `daily-pipeline` and `digest-job` schedule definitions, plus unscheduled Hostinger inbound and shadow tasks. If a later hosted smoke genuinely requires task deployment, first remove/disable schedule definitions in a reviewed change, keep jobs/Finder/shadow false, deploy only to the verified V2 ref, and do not invoke any task.

## 4. Create the V2 Vercel project

In Vercel dashboard, import the repository as a new project such as `reachagent-v2-staging`. Select production branch `reachagent-v2-application`. Do not connect or rename the V1 project, transfer V1 domains, attach V1 aliases, or copy an existing project's environment variables. Keep the generated V2 URL. Set Node.js 24.x, framework Next.js, install command `npm install`, and build command `npm run build` (also captured in `vercel.json`). Disable automatic deployments from all non-V2 branches in project settings.

## 5. Configure safe Vercel variables

Set only the new V2 Supabase and Trigger values plus:

```text
REACHAGENT_ENV=v2_staging
NEXT_PUBLIC_REACHAGENT_RUNTIME=v2
V2_DEPLOYMENT_BRANCH=reachagent-v2-application
V2_VERCEL_PROJECT_NAME=reachagent-v2-staging
NEXT_PUBLIC_APP_URL=https://<new-v2-vercel-host>
ORCHESTRATOR_ENABLED=false
ORCHESTRATOR_SHADOW=false
OUTREACH_SEND_ENABLED=false
TRIGGER_JOBS_ENABLED=false
FINDER_SCHEDULE_ENABLED=false
HOSTINGER_MUTATIONS_ENABLED=false
SHADOW_OBSERVABILITY_WRITE_ENABLED=false
V2_SHADOW_ALLOW_PRODUCTION_READS=false
```

Leave Resend, Hostinger, Google Maps, Outscraper, Anthropic, OpenAI, Gemini, shadow, and all V1 variables unset. Do not upload `.env.local`.

## 6. Deployment checkpoint and deploy

Run the suites listed in `docs/reachagent-v2-deployment.md`. If any fail, do not deploy. Commit or tag a reviewed V2 checkpoint without merging. Deploy only the new V2 Vercel project. Build-time validation must pass before any route can be published.

## 7. Bootstrap one test admin

Use a clearly V2-only address, preferably `admin@example.test` for non-delivery testing. Set `V2_BOOTSTRAP_ADMIN_EMAIL` and a temporary 12+ character `V2_BOOTSTRAP_ADMIN_PASSWORD` only in the operator shell, then run `npx tsx scripts/bootstrap-v2-admin.ts`. The idempotent server-side command creates/updates the V2 Auth user and explicitly promotes its V2 profile. It never reads `ADMIN_EMAIL` and does not import V1 users. Clear the password variable afterward.

## 8. Seed synthetic data

With the V2 app variables still in the operator shell, run `npx tsx scripts/seed-v2-test-data.ts`. Re-running is idempotent. It uses deterministic IDs, `example.test` recipients/sites, and no provider SDK. Remove only these fixtures with `npx tsx scripts/seed-v2-test-data.ts --reset`.

## 9. UI and API smoke

Log in as the V2 test admin and verify `/dashboard`, `/dashboard/leads`, `/dashboard/lifecycle`, `/dashboard/settings`, `/dashboard/email-log`, `/dashboard/email-report`, and `/dashboard/admin`, plus read-only APIs. Expect email report to return `503` with `Mailbox not configured` until a V2 mailbox is deliberately provisioned. Verify member/admin RLS with a separate V2 member if required. Do not click or call send, pipeline, Finder, reactivation, follow-up, retry research, regeneration, or provider-test controls.

Open authenticated `/api/admin/deployment-diagnostics`. It returns environment/branch/project metadata, hashed Supabase/Trigger identifiers, commit, Node version, and gate booleans only. It never returns secrets or URLs. For automation, place the signed-in cookie in operator-only `V2_SMOKE_ADMIN_COOKIE`; set `V2_DEPLOYMENT_URL`, `V2_EXPECTED_SUPABASE_PROJECT_REF`, `V2_EXPECTED_TRIGGER_PROJECT_REF`, and `V2_EXPECTED_VERCEL_PROJECT_NAME`; then run `npm run test:hosted-safety:v2`. Clear the cookie afterward.

## 10. Stop conditions and rollback

Stop if any diagnostic gate is true, either identifier hash differs from hashes computed for the new refs, the branch/project/URL is wrong, unexpected data exists, auth crosses projects, or any provider request appears.

Rollback requires no V1 database action: remove/disable the new V2 Vercel deployment, disable/delete the V2 Trigger project, rotate/delete V2-only keys, and optionally pause/delete the V2 Supabase project. Retain V1 unchanged. Synthetic reset is safe only while the validator proves the V2 target.
