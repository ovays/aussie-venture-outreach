# ReachAgent V2 deployment baseline

Audit captured on 2026-09-15 before Prompt 14 deployment changes. Source-control checkpoint: branch `reachagent-v2-application`, commit `f5f60bd6243846795b5911cc936dd1ad092a4a9d`. The worktree already contained the uncommitted Prompt 8–13 V2 implementation; those changes were preserved.

## Existing deployment assumptions

V1 uses root `.env.local`, the hosted Supabase project `obppfnujusqiwjhwzosv`, and Trigger.dev project `proj_pkyxowcjibwfokooeqaw`. The V1 environment contains operational Supabase, Trigger, AI, Resend, Hostinger, Google Maps, and Outscraper variables. The repository had no `vercel.json`, no `.vercel/project.json`, and no discoverable Vercel CLI, so the V1 Vercel project name, ID, production URL, aliases, and account could not be verified locally. Prompt 14 must not infer or modify them.

V2 was local-only: `.env.v2.local`, an isolated `.v2-local` Supabase workdir, three migrations under `supabase-v2/migrations`, V2 runtime assertion, safe-false execution gates, and Trigger configuration already moving toward an explicit V2 ref and Node 24. No hosted V2 Supabase ref, Trigger ref, Vercel link, URL, or cloud credentials existed.

## Audited surfaces and risks

| Surface | Pre-Prompt-14 finding | Risk |
|---|---|---|
| Next.js | 16.2.4 App Router; config only asserted a V2 Supabase target | Other deployment targets and gates were not build-fatal |
| Environment loading | `build:v2` injects `.env.v2.local`, while Next also discovers root `.env.local` | Unset V2 names could inherit V1 operational values |
| Supabase clients | Browser/server/service clients all use `NEXT_PUBLIC_SUPABASE_URL`; V2 target assertion exists | Remote matching ref was required, but no unified deployment validator existed |
| Supabase migrations | Dedicated `00000000000000`, `00000000000001`, `00000000000002`; golden hash verified | Hosted apply workflow and destination-empty check were missing |
| Trigger.dev | Known V1 ref was hard-coded historically; current V2 config uses Node 24 | No hosted V2 project exists; schedule-bearing daily/digest tasks must not be deployed initially |
| Trigger secrets | Application paths use only `TRIGGER_SECRET_KEY`; old audit/docs reference `TRIGGER_SECRET_KEY_PROD` fallback | A V2 process could inherit the V1 generic/production secret without a project boundary |
| Vercel | Repository unlinked and CLI unavailable | Project/alias/secret inheritance cannot be inspected or safely created here |
| Resend | Shared `sendEmail` has the V2 send gate; test-email has its own gate before a direct SDK call | Every path needs a regression proving the provider is unreachable while false |
| Hostinger | Report/inbound paths read mailbox metadata; no current delete/move/mark implementation found | Missing credentials caused a generic report failure; V1 mailbox credentials must stay absent |
| Finder/providers | Finder can use Google Maps/Outscraper; pipeline jobs and scheduled Finder are independently gated | Provider keys inherited from `.env.local` would make explicit manual actions capable of calls |
| AI | Anthropic/OpenAI/Gemini are called only by explicit workflow/actions, not boot/page load | Provider keys are unnecessary for first deployment and should remain unset |
| Auth | Profiles default to `member`; no `ADMIN_EMAIL` elevation in V2 auth | Hosted server-side bootstrap was local-only and non-idempotent |
| Browser/API actions | Manual pipeline is jobs-gated; outbound send transport is send-gated | UI may remain visible, but server gates must be the authority |

The bundled Next.js 16 documentation was read before edits. Relevant constraints: root `.env*` load order can merge values, `NEXT_PUBLIC_*` values are frozen into the client bundle at build time, Route Handlers are request-time by default, and `next.config.ts` executes during build/server phases. This is why validation belongs in `next.config.ts` and diagnostics remain a dynamic server route.

## Required V2 variables

Remote V2 requires: `REACHAGENT_ENV`, `NEXT_PUBLIC_REACHAGENT_RUNTIME`, `V2_DEPLOYMENT_BRANCH`, `V2_VERCEL_PROJECT_NAME`, `NEXT_PUBLIC_APP_URL`, V2 Supabase URL/anon/service-role/ref, and V2 Trigger secret/ref. All eight irreversible gates must be explicitly `false`. Provider credentials are optional and should be absent initially. Bootstrap email/password and the database connection URL are operator-only command inputs, never committed app configuration.

Forbidden V2 inputs include the known V1 project refs, `TRIGGER_SECRET_KEY_PROD`, `TRIGGER_PROJECT_ID`, V1/production Supabase aliases, `ADMIN_EMAIL`, legacy sender/follow-up flags, `TRIGGER_ACCESS_TOKEN` in the app runtime, `RESEND_API_KEY_Gmail`, and all V1 shadow-read credentials. Generic `SUPABASE_URL`, if present remotely, must exactly equal `NEXT_PUBLIC_SUPABASE_URL`.

## Isolation decision

Must be separate: hosted database and auth tenant, service/anon keys, Trigger project and secret, Vercel project/deployment/URL/aliases/environment variables, test users, operational data, schedules, mailbox/provider connections, and any future shadow credentials.

May remain shared: Git repository, V2 branch history, source modules, npm packages/SDK versions, deterministic templates, tests, and non-secret documentation. Provider accounts or billing organizations may technically be shared later only with separate scoped credentials and explicit approval; no provider credential is required for the first deployment.

## Blockers at audit completion

No hosted V2 projects or refs exist. Vercel, Supabase, Trigger.dev, and `psql` CLIs are unavailable; the repo is unlinked; no cloud authentication was discoverable. Cloud project creation, hosted baseline application, hosted auth, deployment, and hosted smoke tests therefore require user action and remain unclaimed.
