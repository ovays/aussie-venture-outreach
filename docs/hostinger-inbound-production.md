# Hostinger inbound production runbook

Keep the Hostinger `message.received` webhook disabled until the migration,
Vercel deployment, Trigger.dev deployment, and production environment checks
below are complete. Trigger.dev does not inherit Vercel environment variables.

## Required Vercel production variables

- `HOSTINGER_WEBHOOK_SECRET`
- `HOSTINGER_MAILBOX_ID`
- `HOSTINGER_MAILBOX_ADDRESS`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TRIGGER_SECRET_KEY_PROD` or `TRIGGER_SECRET_KEY`

## Required Trigger.dev production variables

- `HOSTINGER_MAIL_API_TOKEN`
- `HOSTINGER_MAILBOX_ID`
- `HOSTINGER_MAILBOX_ADDRESS`
- `HOSTINGER_MAIL_API_BASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Add the four `HOSTINGER_*` variables to the Trigger.dev production environment
manually. Do not copy values into source code, logs, tickets, or test output.

In the Trigger.dev project dashboard, open the production environment's
environment-variable/secret settings. Recreate or update
`SUPABASE_SERVICE_ROLE_KEY` with the secret/protected option enabled, then save
it. Confirm its value is masked before leaving the page. If the UI cannot
change protection in place, delete only that variable and immediately recreate
it with the same current value as protected. Do not delete the Supabase key at
the provider. Add or update the four Hostinger variables in the same production
environment, marking `HOSTINGER_MAIL_API_TOKEN` protected/secret as well.

## Receipt recovery and concurrency

The task has a five-minute maximum duration and a dedicated queue with
concurrency 3. Different receipts can run in parallel without allowing a
single receipt to be claimed twice by different runs. A sequential retry of the
same Trigger run may resume immediately. A different run can reclaim a
`processing` receipt only after 10 minutes, using `processing_started_at` with
`updated_at` as fallback. A duplicate webhook enqueues that stale reclaim.
No polling job is required.

Matched replies whose lead disappeared are `failed`, not `processed` or
`unmatched`. Their receipt payload and `last_error` retain the receipt locator
and missing lead ID for investigation, and a later duplicate event can retry.

`failed` receipts reuse their existing row. Each successful processing claim
increments `attempts`, producing a new Trigger idempotency key for a deliberate
replay. If Trigger enqueue succeeds but saving `queued` fails, the attempt has
not yet advanced, so the Hostinger retry uses the same key and recovers the same
Trigger run. The worker may also atomically claim a still-`pending` receipt.
Terminal `processed`, `ignored`, `unmatched`, and `unmatched_ambiguous` receipts
are never re-enqueued.

The worker continues to fetch message metadata only. It must not call `/text`,
`/source`, attachments, message flag updates, or any endpoint that sets
`\\Seen`.

## Local credential safety

`.claude/settings.local.json` is ignored and untracked. Keep it out of Git and
do not print its contents. Manually rotate any still-active credentials or
tokens previously stored there; leave unrelated local developer settings in
place.

## Ordered production enablement

1. Keep the Hostinger webhook disabled.
2. Review the release commit and repeat the repository tests, TypeScript check,
   production build, read-only audit, diff check, and Trigger.dev dry run.
3. Back up/confirm normal Supabase migration procedures, then apply
   `052_hostinger_inbound_reliability.sql` to production.
4. Verify the partial `emails.message_id` index, `attempts` column, and
   `claim_hostinger_inbound_receipt` function exist.
5. Configure the required Vercel production variables listed above.
6. Configure the required Trigger.dev production variables separately; protect
   the Supabase service-role key and Hostinger API token.
7. Deploy the application to Vercel through the normal reviewed release flow.
8. Deploy Trigger tasks with the pinned 4.5.15 CLI through the normal reviewed
   release flow. The dry-run command alone does not deploy.
9. Send one controlled signed webhook while the external Hostinger webhook is
   still disabled, and verify one receipt progresses to its expected terminal
   state without changing mailbox unread flags.
10. Re-enable the Hostinger `message.received` webhook.
11. Monitor Trigger runs and `inbound_receipts` for `failed` or stale
    `processing` rows during the first production window; replay by resending
    the same Hostinger event after correcting any cause.
