# ReachAgent customer signup and onboarding

## Signup and provisioning

`/signup` uses Supabase Auth with full name and workspace name stored as signup metadata. No service-role value is exposed. With email confirmation enabled, the customer confirms and signs in before provisioning.

An authenticated customer without an active membership is sent to `/no-workspace`. That page calls `POST /api/workspace/provision`, which accepts no body. Platform administrators are never provisioned. The route invokes `public.provision_customer_workspace()` using the customer's authenticated Supabase session.

The database function derives the user from `auth.uid()`, serializes calls with a transaction advisory lock, and returns the existing membership on retries. In one transaction it creates the workspace, assigns the non-internal `external_beta` entitlement, creates the owner membership, adds paused default settings, and initializes onboarding. Any error rolls back every insert. It never references or copies the Aussie Venture workspace.

## External beta and isolation

`external_beta` has temporary limits: 100 outbound emails, 100 AI requests, 100 discovery requests, five members, two mailboxes, and 500 stored leads per quota period/count dimension. These are entitlements only: execution stays off. The new workspace starts without leads, emails, activity, mailboxes, categories, or access to another tenant. Existing RLS and server-side workspace resolution enforce tenant IDs.

## Onboarding

The nine durable steps are Business, Mailbox, Categories, Locations, Personalisation, Follow-ups, Team, Review, and Complete. Each continuation stores `onboarding_current_step`; a returning customer resumes that step.

- Business stores workspace/brand name, website, business type, country, primary city, sender name, and contact email.
- Mailbox links to existing Gmail and Microsoft OAuth routes. It can be skipped, with a clear paused warning.
- Categories are created paused and only with the active workspace ID. Suggestions are neutral and not copied from another workspace.
- Locations store customer-facing cities and suburbs/areas in the existing workspace-scoped location table.
- Personalisation stores `template` or `ai_personalised`; it does not call AI.
- Follow-ups store enabled preference and days 7/14/21/90, validating strict order. Reactivation remains disabled.
- Team lists active membership and pending invitations. Owners/admins can add an existing profile or create a safe pending invitation for admin/member; no email is sent. Members cannot manage onboarding.
- Review displays all setup areas. Complete only sets onboarding complete and a timestamp.

Completion explicitly writes `system_active=false` and `reactivation_enabled=false`. It does not run discovery, call AI, send mail, enable jobs, or start follow-ups.

## Migration

Apply `supabase-v2/migrations/00000000000020_customer_signup_and_onboarding.sql` to hosted V2 only after review and backup, using the normal Supabase migration process for the V2 project. Do not apply it to V1. Do not edit or re-run migration 15. After applying, verify the `external_beta` catalog rows, `workspace_invitations` RLS/grants, and function grants; then test with a new disposable Auth user. No additional secret or Stripe configuration is required. Gmail/Microsoft OAuth still requires the existing provider configuration for live connections.
