# SaaS customer Outreach and Settings

Prompt 5 replaces the customer placeholders with workspace-scoped product pages. `/dashboard/outreach` is category-based: a category describes the kind of business to target, and workspace locations describe where ReachAgent should look. It is not a generic campaign builder.

## Customer configuration

- Categories show a customer-safe name, location summary, and Enabled/Paused configuration. New categories are created Paused. Changing this state stores configuration only.
- Locations use the existing `city_suburbs` records and support a city plus an optional suburb or area. The server resolves the workspace; no browser-provided workspace ID is accepted.
- Personalisation uses the canonical `initial_email_mode` workspace setting. Template uses saved templates. AI Personalised records a preference for later execution and does not call an AI service.
- Automatic follow-ups and the first, second, final, and reconnect delays use the canonical workspace settings. Values must be positive, within bounds, and strictly increasing. The default customer presentation is Day 7, 14, 21, and 90.
- Readiness checks onboarding, categories, locations, mailbox, personalisation, and timing. Even when complete, the page says activation is not enabled. Prompt 5 never changes `system_active` and starts no jobs or schedules.

## Settings

Customer Settings contains Business, Mailbox, Personalisation, Outreach, Team, and Usage sections. Business edits cover the workspace/business name, website, industry, country, primary city, sender/display name, brand name, contact email, and existing profile fields. Mailboxes are represented by safe public connection DTOs and expose no tokens or secrets. The same personalisation and outreach component is used on both pages, so there is no parallel state.

Team lists active members and pending invitations. Owners and admins can change existing member roles/status through the established workspace-member endpoint; this work does not send invitation email. Usage uses the existing workspace-scoped quota overview and customer labels for stored leads, discovery, outbound, AI, mailboxes, and members. Billing remains hidden from customers.

## Access and isolation

Owners and workspace admins may edit. Members receive the same allowlisted DTO but controls are read-only, and mutation endpoints independently require workspace-admin access. Reads and writes use the server-resolved workspace plus the workspace-scoped service client. Category and location identifiers are additionally constrained by that workspace, preventing cross-workspace reads or mutation. No Aussie Venture values are used as customer defaults or copied into new workspaces.

Platform admins retain the pre-existing advanced Settings branch, including operational configuration, diagnostics, category templates, and AI/provider tooling. The customer surface does not expose those controls.

## Deferred to Prompt 6

Privacy/compliance activation gates, legal identity and sender/compliance cleanup, suppression/consent policy, retention controls, customer-facing compliance language, and permission to enable real execution remain deferred. Existing environment-backed legacy mailbox sender values belong to that cleanup and are not expanded here. Gmail production verification remains an external track. Stripe, deployment, hosted writes, performance optimisation, and actual outreach activation are also out of scope.

No database migration is required; Prompt 5 reuses existing workspace settings, categories, locations, mailbox connections, membership, and quota tables.
