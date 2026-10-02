# Customer Inbox, Privacy, and Compliance (Prompt 6)

## Customer Inbox model

`/dashboard/inbox` uses the customer-only `/api/customer-inbox` projection. Conversations are grouped by the durable lead ID, not subject. Lists are server-paginated at 25 conversations. Detail is bounded to the latest 50 messages and returns only business identity, customer-safe status/outcome/suppression, mailbox addresses, subject, text content, direction, and timestamps. Provider IDs, receipt UIDs, raw payloads, OAuth data, delivery internals, claims, locks, and workflow metadata are excluded.

Outbound content comes from the existing workspace-scoped `emails` rows. Customer-visible inbound content is stored in the provider-neutral `customer_inbound_messages` table. `inbound_receipts` remains operational and is never exposed. Existing historical replies for which only `replied_at` was stored appear as replied conversations; their body cannot be reconstructed and the UI says it was not stored.

Attachments are deferred because no safe durable attachment subsystem currently exists.

## Provider sync reality

- Gmail: OAuth supports sending and bounded live operational reporting. There is no automatic inbound webhook/polling ingestion. The customer Inbox does not call Gmail live.
- Microsoft: OAuth supports sending and bounded live operational reporting. There is no automatic delta/webhook ingestion. The customer Inbox does not call Microsoft live.
- Hostinger: webhook/receipt/task processing exists and can identify replies. Trigger execution is currently disabled. Hostinger's metadata lookup intentionally does not fetch body text because its body endpoint marks mail as read, so current stored replies may have metadata without a body.
- Resend: inbound matching exists only when an inbound receiving domain is externally provisioned. It currently retrieves headers for matching, not a durable body.

Automatic Gmail/Microsoft reply ingestion remains a beta risk and is not represented as synchronized.

## Authorization and mailbox privacy

Workspace is resolved server-side from active membership. Browser-supplied workspace IDs are not authoritative. The workspace-scoped service client structurally filters all Inbox tables, so guessed foreign lead/message IDs return not found.

Owners, admins, and members may read their workspace Inbox. Platform-admin role alone is not mailbox-content authority: the API requires real membership and the `emails`/`customer_inbound_messages` RLS policies require membership without a platform-admin bypass. Platform operational mailbox responses remain limited to connection/provider/status/sync/error/count metadata and never return tokens or provider credentials. The legacy Email Log endpoint is reduced to operational type/status/timestamps and omits subject, recipient, and body.

Break-glass support content access is deferred. Any future design must require a recorded reason, time bound, audit log, and preferably customer approval.

## Sender identity and unsubscribe

Sender identity comes from workspace settings: brand name, display name, contact email, website, optional business/contact address, and the connected default sending mailbox. At the final provider boundary, missing identity fails closed. A non-Aussie-Venture workspace must have its own connected send-capable mailbox; it cannot fall back to AV Resend, AV sender details, or an AV Message-ID domain. The final Message-ID domain comes from the selected mailbox. The configured AV workspace may continue using its explicitly scoped environment connection.

Before a provider call, the final boundary creates a random 256-bit opaque unsubscribe token, stores only its SHA-256 hash, and adds organisation identification plus an unsubscribe link. The public POST endpoint is rate-limited, idempotent, has no redirect, accepts no email/workspace/lead parameter, and returns no sensitive data. Suppression is workspace-scoped by normalized email. Recipient unsubscribe cannot be cleared in the customer UI.

Manual **Do not contact** is owner/admin-only, durable, cancels scheduled follow-ups, and is audited without message content. It is distinct from **Not Interested**, which remains a reversible business outcome. Suppression state is visible in Leads and Inbox using customer-safe labels.

## Enforcement and readiness

The service-role `claim_outbound_email_for_send` function checks central suppression under the same final claim used by initial, follow-up, and reactivation sends. A suppressed address cannot reach a provider. Existing delivery suppression and recipient ownership checks remain in place.

Readiness requires completed onboarding, a category, a location, a send-capable mailbox, sender/brand/contact identity, valid personalisation and follow-up configuration, and the unsubscribe/suppression foundation. Passing checks says **Ready for activation**, but `systemActive` is always returned false and no activation control is exposed. Trigger jobs and provider execution remain disabled.

Existing daily/workspace quota consumption and provider error states remain available. There is no sophisticated mailbox warm-up, complaint feedback loop, or independently configurable mailbox daily cap; these remain beta deliverability risks.

## Retention and deferred work

No new legal retention period is claimed. Outbound messages, customer-safe inbound messages, suppressions, and audit/activity events follow current database retention; configurable retention/deletion is deferred. Gmail production OAuth verification and Microsoft production consent are external tracks. Provider-neutral automatic reply ingestion, attachment storage/download authorization, break-glass access, suppression clearing policy, and configurable retention remain deferred.

## Migration

Migration `00000000000022_customer_inbox_privacy_compliance.sql` creates `outreach_suppressions`, `unsubscribe_tokens`, and `customer_inbound_messages`; adds indexes/RLS; removes the platform-admin-only content-read bypass; and replaces the final send-claim function with central suppression enforcement.

Apply to hosted V2 only after review and backup using the repository's normal migration runner. Do not apply it to V1. This implementation task did not apply, deploy, commit, or push the migration.
