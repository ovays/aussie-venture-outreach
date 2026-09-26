# SaaS 7 — Billing, Stripe, and entitlement mapping

## Architecture

Stripe selects a commercial plan; it does not enforce product behavior:

```text
Stripe subscription -> server price mapping -> workspace base entitlement
                    -> SaaS 6 deterministic quota checks -> product operations
```

SaaS 6 remains authoritative for limits, usage counters, idempotent consumption, and per-workspace overrides. SaaS 7 never edits or resets usage and never edits overrides.

## Database model and migration

Migration: `supabase-v2/migrations/00000000000016_billing_stripe.sql`.

- `workspace_billing_accounts`: exactly one row per workspace, unique Stripe customer and subscription identifiers, normalized subscription state, period dates, cancellation flag, trial end, and safe synchronization state/error fields.
- `stripe_webhook_events`: minimal event ID/type/status/workspace/timestamps/error ledger. Full Stripe payloads are not retained.
- `billing_inactive`: an internal fail-closed entitlement profile with zero limits in every SaaS 6 dimension. No commercial profiles, prices, or limits are seeded.
- `sync_workspace_billing_entitlement`: service-role-only transaction that persists normalized billing state and changes only the SaaS 6 base entitlement.

Tables use workspace foreign keys, uniqueness constraints, bounded fields, indexes, update timestamps, RLS, and explicit grants. Browser roles have no mutation grants and cannot execute the synchronization function.

## Stripe to plan mapping

The browser sends only `starter`, `growth`, or `pro`. The server maps these codes to configured recurring Stripe Price IDs:

| Internal plan | Server variable |
| --- | --- |
| `starter` | `STRIPE_PRICE_STARTER_MONTHLY` |
| `growth` | `STRIPE_PRICE_GROWTH_MONTHLY` |
| `pro` | `STRIPE_PRICE_PRO_MONTHLY` |

Each configured Price ID must be unique and begin with `price_`. Webhooks reverse this same map. An unknown/duplicate price fails closed to `billing_inactive`. For an active or trialing subscription, the plan code must also exist as a non-internal `entitlement_profiles` row with all six approved limits before Checkout is exposed. No amounts are hardcoded or displayed.

## Customer, Checkout, and portal flows

`ensureStripeCustomer` resolves workspace context before it is called, reads the local workspace billing row, and creates a test-mode customer only when absent. Stripe creation uses the stable idempotency key `reachagent-workspace-{workspace UUID}`. Workspace metadata is added for operator convenience, but the local unique customer/workspace row is authoritative.

`POST /api/billing/checkout` requires an authenticated owner/admin membership (or platform admin). Its strict body accepts only `{ "planCode": ... }`; arbitrary fields and Price IDs are rejected. The server selects the configured price/customer and constructs success/cancel URLs from `NEXT_PUBLIC_APP_URL`. Checkout does not change entitlements; only a verified webhook can synchronize them.

`POST /api/billing/portal` uses the server-resolved workspace and its locally stored customer ID. No browser customer ID is accepted. `GET /api/billing` returns a sanitized member-facing summary and accepts no workspace identifier.

## Webhook processing and idempotency

`POST /api/stripe/webhook` runs in the Node.js runtime, reads `request.text()` exactly once, and verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` before parsing or writing anything.

Handled events are:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Checkout completion retrieves the subscription from Stripe. Subscription events use their signed subscription object. Every handled object must be test-mode, contain exactly one subscription item/price, map to a configured plan, and resolve its customer through `workspace_billing_accounts`. Metadata alone is never authorization. An existing customer/subscription mismatch is rejected.

The event ID primary key claims processing. Processed/ignored duplicates return success without running synchronization. A concurrent actively-processing delivery returns `409` so Stripe retries it; processing claims older than five minutes and failed events can be atomically reclaimed. Success changes billing state and entitlement through one database transaction, then marks the event processed. If the final ledger update is interrupted after database synchronization, replay is harmless because the synchronization upsert is deterministic; operators can inspect the event and billing sync state.

Only safe, bounded error text is stored. Full payloads and secrets are not logged.

## Status and entitlement rules

| Stripe status | Behavior |
| --- | --- |
| `active` | Assign mapped commercial entitlement profile |
| `trialing` | Assign mapped commercial entitlement profile |
| `past_due` | Assign `billing_inactive` (fail closed) |
| `unpaid` | Assign `billing_inactive` |
| `canceled` | Assign `billing_inactive` |
| `incomplete` | Assign `billing_inactive` |
| `incomplete_expired` | Assign `billing_inactive` |
| `paused` | Assign `billing_inactive` |
| unknown | Normalize to ineligible and assign `billing_inactive` |

An active/trialing subscription whose Price ID is unknown is also normalized to ineligible and assigned `billing_inactive`; it can never retain or grant paid access merely because Stripe sent an unrecognized value.

No usage history or counters are deleted/reset. A downgrade preserves existing members, mailboxes, leads, and usage; SaaS 6 blocks future limited operations when usage/count is over the new limit. Overrides remain separate and continue to determine effective limits according to SaaS 6.

The Aussie Venture workspace `00000000-0000-0000-0000-000000000001`, and any workspace whose current base entitlement is `internal_beta`, is protected inside the database synchronization function. Billing webhooks can store its billing state but always retain `internal_beta`. A platform administrator can explicitly change it only through the separate SaaS 6 administration path.

## Security boundaries

- Workspace identity comes from active `workspace_members`, never request bodies, JWT workspace claims, Checkout metadata, or webhook metadata.
- Checkout/portal require owner/admin workspace role. Members can view only their sanitized summary.
- Platform-admin inspection is exposed at `GET /api/admin/billing` and in Platform Admin.
- Stripe secret/webhook secret remain server-only. Only test-mode secret keys and event objects are accepted by this release.
- RLS prevents cross-tenant direct reads; billing rows are directly readable only to workspace admins/platform admins. The member summary is served through an authorized server endpoint.
- Browser roles cannot mutate billing rows, set plan codes/Stripe IDs, or execute entitlement RPCs.
- Unknown customer, unknown price, multi-price subscription, cross-customer subscription mismatch, live-mode data, and unknown statuses fail closed.

## Required environment

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER_MONTHLY=price_...
STRIPE_PRICE_GROWTH_MONTHLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
NEXT_PUBLIC_APP_URL=https://your-v2-app.example
```

Only configure approved plans. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is not needed because this implementation redirects to server-created Checkout and portal URLs.

## Test-mode Stripe setup

1. In Stripe test mode, create products and monthly recurring Prices for only the approved plans. The amounts are an operator/commercial decision.
2. Add each test Price ID to the matching server environment variable.
3. Create a webhook endpoint at `https://<V2-host>/api/stripe/webhook` and select the four handled events above.
4. Store that endpoint's test-mode signing secret as `STRIPE_WEBHOOK_SECRET` and a restricted test secret key as `STRIPE_SECRET_KEY`.
5. Configure the Stripe Customer Portal for test mode if Manage Billing will be enabled.
6. Before exposing a plan, create its matching `entitlement_profiles` row and all six approved `entitlement_limits`. Never infer limits from Stripe pricing.

Automated tests use fakes/static safety checks and make no Stripe network calls or charges.

## Manual hosted migration and deployment

Do not run `supabase db push` or migration repair. In the Supabase Dashboard, explicitly select hosted V2 project `ojrxfjlgjhzhdpnkyboa` (not V1 `obppfnujusqiwjhwzosv`), open SQL Editor, paste the complete unchanged contents of `supabase-v2/migrations/00000000000016_billing_stripe.sql`, confirm the project again, and execute exactly once. Verify both tables, the `billing_inactive` profile/limits, function grants, RLS policies, and the unchanged Aussie Venture `internal_beta` assignment.

After migration review/application, configure test-mode Stripe environment values and webhook/portal settings, deploy application code with operational send/AI/Finder/Trigger gates unchanged, then exercise Checkout with a Stripe test card in a non-beta test workspace. Do not create a live subscription during validation.

## Rollback considerations

Application rollback is safe because SaaS 6 continues enforcing the last assigned entitlement. Disable/remove the Stripe webhook endpoint first to stop new synchronization. Preserve `workspace_billing_accounts` and `stripe_webhook_events` for diagnosis; do not drop usage history. If entitlement correction is needed, use the existing audited platform-admin entitlement operation. Database object removal should be a separately reviewed forward migration, not an edit to migration 16.
