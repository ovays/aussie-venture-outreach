# SaaS customer Dashboard and Leads

Prompt 4 separates the customer CRM view from ReachAgent's platform-admin operational tooling. The customer surfaces never accept a browser-selected workspace and never expose raw workflow fields.

## Customer status model

The reusable mapping is in `src/lib/customer-lead.ts`. The database's raw `leads.status` values are unchanged.

| Durable state | Customer status |
| --- | --- |
| `customer_outcome = not_interested` | Not Interested |
| `customer_outcome = interested` | Interested |
| Contacted lead with all three follow-ups sent, reactivation enabled, and the configured reactivation date reached | Reactivation Due |
| `new`, `researched`, or an unknown pre-contact value | New |
| `email_ready` | Email Ready |
| `contacted` | Contacted |
| `replied` | Replied |
| `interested`, `negotiating`, `closed`, `closed_manual` | Interested |
| `dead` | Dead |

An explicit customer outcome takes precedence. Reactivation Due uses the same durable email history and workspace setting concepts as Lifecycle; no state is invented.

## Leads UX

Normal customers receive the paginated customer projection at `/dashboard/leads`: status counts and filters, search across business/email/location/category, customer status, last contact, reply indicator, and a safe lead detail drawer. The zero-lead state explains that leads will appear when targeting/discovery is activated later and provides no execution control.

Platform admins retain the existing operational Leads table. Lifecycle remains at `/dashboard/lifecycle` and its page/API continue to require platform-admin access.

The customer detail shows business/contact information, customer status, outreach/reply summary, formatted customer activity, notes, and outcome actions. It does not return raw activity metadata, DM queue data, provider IDs, delivery internals, locks, workflow JSON, or diagnostics.

## Mutations and permissions

`PATCH /api/customer-leads/[id]` uses a strict DTO containing only `outcome` and `notes`. Extra keys, raw statuses, workspace IDs, and operational fields are rejected.

- Owner/admin: edit notes; mark Interested or Not Interested; clear an explicit outcome.
- Member: edit collaborative notes only; cannot change outcomes.
- Platform admin: retains internal tooling and can use customer-safe actions.

These mutations only update `customer_outcome`, `notes`, and `updated_at`, then add a safe activity record. They do not send, research, generate, schedule, reactivate, claim, or run pipeline work. Legacy raw lead GET/PATCH endpoints are platform-admin-only; delete remains governed by its existing workspace-admin policy.

## Workspace isolation

The API resolves membership and workspace server-side, creates a workspace-scoped service client, and ignores no browser workspace because none is accepted. Lead lookup and mutation are structurally scoped before the lead ID predicate. The customer list RPC receives only the already-resolved workspace ID and is executable only by `service_role`, preventing direct authenticated callers from spoofing another workspace. This also keeps the Aussie Venture workspace inaccessible to unrelated customers while preserving platform-admin selection behavior.

## Dashboard and activity

Customers see Total Leads, Contacted, Replies, Interested, emails sent, leads needing attention, a customer status summary, safe recent activity, and seven-day outreach activity. Platform admins retain the operational dashboard. Only allowlisted events appear in customer activity; descriptions are generated from event type and business name, never from technical descriptions or payloads.

## Migration

Migration `00000000000021_customer_dashboard_leads.sql` adds nullable, constrained `leads.customer_outcome`, a scoped partial index, and the paginated `get_customer_leads_page` projection. It does not change raw statuses or execution. Apply migration 21 to V2 before deploying this application code. Do not alter migrations 15 or 20.

## Deferred performance work

The list remains server-paginated (25 rows, maximum 50), calculates counts in one RPC, bounds recent activity to 20, and avoids N+1 queries. Broader dashboard/RPC benchmarking, materialized summaries, index tuning based on hosted query plans, and dedicated performance changes remain deferred to the later performance phase.
