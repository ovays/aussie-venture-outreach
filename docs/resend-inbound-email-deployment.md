# Deploying Resend Inbound Email (Reply Detection)

## Status: code is ready, infrastructure is not provisioned

`agents/tracker.ts` (`handleInboundEmail`) and the `email.received` case in
`src/app/api/webhooks/resend/route.ts` already implement reply detection:
match the inbound message's `In-Reply-To` header against `emails.message_id`,
fall back to matching the sender's address against `leads.email`, then advance
the lead to `replied` via `handleEmailReply`.

None of that code runs today. Resend only emits `email.received` for a domain
it has been configured to **receive** mail for — that is an account/DNS-level
setup step, done once in the Resend dashboard and your DNS provider, outside
this codebase. This document is that setup step. **No code changes are
required or made by this document** — everything below is dashboard/DNS
configuration.

## 1. DNS / MX records

Resend needs a domain (or subdomain) whose MX records point at Resend so it
receives mail sent to it.

- **Do not point the root `aussieventure.com` domain's MX at Resend** if it
  already has MX records for real inbound mail (e.g. Google Workspace) —
  Resend's own docs are explicit that this redirects *all* mail for that
  domain to Resend, and MX only routes correctly to whichever record has the
  lowest priority number. Since sending already uses `hello@aussieventure.com`
  (see `src/lib/resend.ts`), assume the root domain has real MX records in
  use and do not touch them.
- Instead, create a dedicated receiving subdomain, e.g.
  `reply.aussieventure.com`. MX records on a subdomain only affect that
  subdomain, so this cannot conflict with the root domain's existing mail.
- In the Resend dashboard: **Domains → your domain (or add
  `reply.aussieventure.com` as a new domain) → Receiving tab**. Resend
  generates the exact MX record (hostname + priority) for you there — copy it
  verbatim rather than guessing a value, since Resend can change the exact
  receiving host. Use whatever priority Resend shows (their docs suggest
  `10`, but always match the value they display).
- Add that MX record at your DNS provider for `reply.aussieventure.com`.
- DNS propagation can take up to 24 hours; the domain shows "Verified" in the
  Resend dashboard once it's live.

## 2. Resend dashboard configuration

1. **Domains → `reply.aussieventure.com` → Receiving** — confirm the domain
   shows as verified/active for receiving after DNS propagates.
2. **Webhooks → Add Webhook**:
   - Endpoint URL: `https://<production-app-domain>/api/webhooks/resend`
     (the existing route already handles both `email.bounced` and
     `email.received` — do not create a second webhook endpoint for this).
   - Events: enable `email.received` in addition to whatever bounce/delivery
     events are already subscribed (check the existing webhook first —
     `email.bounced` should already be enabled; adding `email.received`
     extends the same webhook rather than replacing it).
   - Save. Resend will show a signing secret for this webhook.
3. Confirm the signing secret matches `RESEND_WEBHOOK_SECRET` (see below) —
   if this is a *new* webhook endpoint rather than adding an event to the
   existing one, Resend issues a new secret and the env var must be updated
   to match, or signature verification (`src/lib/webhook-verify.ts`) will
   reject every event with 401.

## 3. Environment variables

No new environment variables are introduced by this feature — it reuses what
already exists:

| Variable | Already set? | Notes |
|---|---|---|
| `RESEND_API_KEY` | Yes | Used by `getReceivedEmailHeaders()` (`src/lib/resend.ts`) to fetch full inbound headers via `resend.emails.receiving.get()`. |
| `RESEND_WEBHOOK_SECRET` | Yes | Must match the signing secret Resend shows for the webhook endpoint that has `email.received` enabled (step 2.3 above). |

If step 2 creates a brand-new webhook (rather than adding the event to the
existing one), update `RESEND_WEBHOOK_SECRET` in production env vars to the
new secret and redeploy before testing.

## 4. Testing procedure

1. Send a real test email to an address at the receiving subdomain, e.g.
   `test@reply.aussieventure.com`.
2. In the Resend dashboard, **Emails → Receiving**, confirm the message
   appears (this verifies MX/DNS is correct independent of the webhook).
3. Check the webhook fired: **Webhooks → your webhook → Recent deliveries**
   should show an `email.received` event with a 200 response.
4. Check application logs for the request to
   `/api/webhooks/resend` — `logger.error('webhook', ...)` fires only on
   failure, so a clean run just shows the event being handled.
5. To test actual reply threading end-to-end: send a real initial pitch to a
   test lead (so `emails.message_id` is populated), reply to it from the
   test inbox so the reply's `In-Reply-To` header references that
   Message-ID, and confirm:
   - the lead's `status` advances `contacted` → `replied` (only from
     `contacted` — already-`negotiating`/`closed` leads must not regress,
     per `handleEmailReply`),
   - the matching `emails` row for that lead's `initial_pitch` gets
     `replied_at` set,
   - an `activity_log` row with `event_type = 'reply_received'` is created.
6. If the reply doesn't match via `In-Reply-To` (e.g. a new email instead of
   a reply), confirm the from-address fallback still finds the lead by
   `leads.email` and produces the same result.
7. Resend also supports **replaying** a webhook delivery from the dashboard
   (Webhooks → delivery → Resend) — use this to re-test signature
   verification and handler logic without sending a new email each time.

## 5. Rollback procedure

Reply detection can be disabled at any point without touching code or
redeploying:

- **Fastest rollback — disable the event, keep the webhook:** in the Resend
  dashboard, edit the webhook and uncheck `email.received`. Bounce handling
  (`email.bounced`) keeps working unaffected since it's the same endpoint
  with a separate event subscription.
- **Full rollback — stop receiving mail entirely:** remove the MX record for
  `reply.aussieventure.com` at your DNS provider. Resend will no longer
  receive mail for that subdomain; `email.received` naturally stops firing.
  This does not affect the root domain's outbound sending or existing mail
  service.
- Application code requires no changes for either rollback path — the
  `email.received` handler simply stops being invoked, exactly as it does
  today before this setup is completed.

## What this document does not (and cannot) do

Everything above is dashboard/DNS configuration performed by whoever
administers the `aussieventure.com` domain and the Resend account — it
cannot be automated from this codebase, and no assumption about your DNS
provider or existing mail setup has been made beyond "don't touch the root
domain's MX records." If `aussieventure.com` turns out to have no existing
inbound mail service at all, the subdomain recommendation above is still the
safer default, but pointing the root domain's MX directly at Resend is a
viable alternative in that specific case — confirm current MX records
(`dig MX aussieventure.com`) before deciding.
