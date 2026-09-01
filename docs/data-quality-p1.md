# Data Quality P1

P1 adds backend classification, reporting, audit, and recipient-level outreach safety. It does not merge or delete leads and has no Data Quality UI.

## Canonical recipient identity

Application code uses `normalizeEmail()` (`trim` + lowercase + empty-to-null). Migration 049 stores the same value in `leads.normalized_email`, maintained by a database trigger, and adds a partial B-tree index. It does not remove dots, tags, or otherwise rewrite provider-specific email semantics.

## Classification

Repeated normalized-email groups are classified deterministically:

- `duplicate_lead`: all normalized business names match, or both website+phone or website+social match.
- `shared_email`: all normalized business names differ and addresses are absent or differ.
- `uncertain_email_group`: a repeated recipient lacks enough consistent signals for either rule.

Single-lead rules emit `invalid_email`, `placeholder_email`, or `technical_email`. `already_contacted_email` is emitted for every non-owner lead after a recipient has meaningful delivered history or an owner is claimed. Generic business locals such as `info`, `hello`, `admin`, `bookings`, `marketing`, and `sales` are not blocked.

## Outreach ownership

`recipient_outreach_ownership.normalized_email` is the atomic ownership key. `claim_recipient_outreach()` takes a transaction advisory lock for that normalized recipient before resolving or creating ownership.

Existing data is backfilled by choosing, in order:

1. a lead with a deal or protected lifecycle state (`replied`, `negotiating`, `interested`, closed states);
2. the earliest meaningful delivered email (`sent` or `email_sync_failed`);
3. lead creation time and ID as deterministic tie-breakers.

For a recipient with no history, the first atomic claim becomes owner. A failed provider send does not transfer ownership automatically. The owner may continue its own follow-ups and reactivation. All other leads remain stored and reportable, but cannot start or run a competing email lifecycle. Ownership does not change outbound Message-ID/reference construction or inbound reply matching.

## Reporting and cleanup foundation

`GET /api/data-quality` calls server-side RPCs and supports `issue_type`, `email`, `business`, `category`, `city`, `page`, and `page_size` (maximum 200). `dry_run=true` includes aggregate counts. Rows include lifecycle/history protection flags, a deterministic `preferred_lead_id`, and suggested redundant IDs. Suggestions are read-only; no automatic deletion or merge exists.

The standalone `npm run audit:data-quality` command is also read-only. It uses paged bulk reads and reports `mutations: 0`.
