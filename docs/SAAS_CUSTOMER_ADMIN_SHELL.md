# ReachAgent V2 customer/admin shell

This document describes the V2 presentation and authorization boundary introduced by Prompt 2. It does not change V1, database schema, job schedules, sending, providers, or billing.

## Customer routes

All customer pages require an authenticated user with an active workspace membership resolved on the server.

| Route | Customer label | Prompt 2 state |
| --- | --- | --- |
| `/dashboard` | Dashboard | Existing page |
| `/dashboard/leads` | Leads | Existing page |
| `/dashboard/outreach` | Outreach | Safe read-only placeholder |
| `/dashboard/inbox` | Inbox | Safe read-only placeholder |
| `/dashboard/analytics` | Analytics | Safe read-only placeholder |
| `/dashboard/settings` | Settings | Customer-safe sections only |

An authenticated customer account without an active workspace is redirected to `/no-workspace`. It does not receive a default or browser-supplied workspace. Each customer page enforces this membership boundary server-side rather than relying only on the shared shell.

## Internal routes

These routes require a server-verified platform-admin profile and are also covered by the proxy as defense in depth:

- `/dashboard/lifecycle`
- `/dashboard/pipeline`
- `/dashboard/dm-queue`
- `/dashboard/email-log`
- `/dashboard/email-report`
- `/dashboard/delivery-failures`
- `/dashboard/deals`
- `/dashboard/settings/ai`
- `/dashboard/settings/ai/analytics`
- `/dashboard/admin`
- `/dashboard/admin/workspaces`
- `/dashboard/admin/usage`
- `/dashboard/admin/audit`
- `/dashboard/admin/data-quality`

Direct navigation by a normal customer is rejected before page data is loaded. The central page helpers are `requireWorkspacePage`, `requireWorkspaceAdminPage`, and `requireInternalPage` in `src/lib/page-access.ts`.

The shared dashboard shell no longer requires a workspace before rendering a platform-admin route. A live platform admin can therefore access global internal administration pages without membership in a customer workspace. Customer pages still require an active membership, and workspace-scoped internal data continues to require an independently resolved server-side workspace context. Prompt 2.1 does not add workspace impersonation or switching.

## Role policy

| Capability | Member | Workspace admin | Owner | Platform admin |
| --- | ---: | ---: | ---: | ---: |
| View customer pages and workspace data | Yes | Yes | Yes | Yes |
| Edit existing lead outcome/status and notes | Yes | Yes | Yes | Yes |
| Add/import/delete leads | No | Yes | Yes | Yes |
| Research, generate/regenerate, manually mark sent, or send | No | Yes | Yes | Yes |
| Configure business, mailbox, categories, or outreach | No | Yes | Yes | Yes |
| Invite/remove ordinary workspace members | No | Yes | Yes | Yes |
| Workspace lifecycle/ownership | No | No | Yes | Yes |
| Internal operational pages and global APIs | No | No | No | Yes |

Authorization is derived from live profile and workspace-membership records. Browser-supplied role or workspace values are not accepted as authority. Workspace-scoped service clients remain the structural data boundary; RLS is defense in depth.

## Navigation behavior

Every authenticated workspace customer sees only Dashboard, Leads, Outreach, Inbox, Analytics, and Settings. Platform admins see the same customer navigation plus an `Internal / Admin` section containing Lifecycle, Pipeline, DM Queue, Email Log, Email Report, Delivery Failures, Deals, AI Settings, AI Analytics, Data Quality, Workspaces, Users, Usage / Admin, and Audit.

Global health diagnostics and their polling banner render only for platform admins. The customer shell does not request `/api/health`.

## API classification

`CUSTOMER_SAFE` means authenticated and explicitly workspace-scoped. `WORKSPACE_ADMIN` admits workspace owner/admin and platform admin. `PLATFORM_ADMIN` admits only a live global admin profile. Webhooks and job code retain their existing non-browser trust boundaries.

| Classification | Routes |
| --- | --- |
| `CUSTOMER_SAFE` | `GET /api/leads`, `PATCH /api/leads`, `GET /api/leads/[id]`, `POST /api/leads/[id]/note`, `GET /api/emails/[id]`, `GET /api/delivery-failures`, `GET /api/delivery-failures/lead-selection`, `GET /api/categories`, `GET /api/cities`, `GET /api/mailboxes`, `GET /api/usage`, `GET /api/billing`, `GET /api/auth/me` |
| `WORKSPACE_ADMIN` | `POST /api/leads`, `POST /api/leads/import`, `POST /api/leads/bulk`, `DELETE /api/leads/bulk-delete`, `DELETE /api/leads/delete-by-date`, `DELETE /api/leads/[id]`, `PATCH /api/emails/[id]`, all lead research/generate/regenerate/resend/mark-sent routes, category writes, mailbox connect/configure/disconnect routes, workspace profile/onboarding writes, workspace member writes, `/api/test-email`, and `/api/reset` |
| `PLATFORM_ADMIN` | `/api/admin/**`, `/api/data-quality/**`, `/api/ai-settings`, `/api/ai-settings/test`, `/api/audit`, `/api/lifecycle`, `/api/pipeline`, `/api/pipeline/run`, `/api/dm-queue`, `/api/deals`, `/api/email-log`, `/api/email-report`, `/api/health`, and raw `/api/settings` reads/writes |
| `SIGNED_WEBHOOK` | `/api/webhooks/resend`, `/api/webhooks/hostinger`, `/api/stripe/webhook` (billing remains deferred) |
| `INTERNAL_SERVICE` | Trigger.dev task entry points and agent/orchestrator code outside browser route handlers |

The Email Log, Email Report, and Delivery Failures pages remain advanced internal pages. Raw `GET /api/email-log` and `GET /api/email-report` are platform-admin-only and workspace-scoped; anonymous callers receive `401`, and authenticated non-platform-admin callers receive `403`. A later customer Inbox must use a separate customer-safe aggregation API and DTO rather than exposing either raw internal response.

## Settings boundary

Customer Settings contains Business, Mailbox, Personalisation, Team, Usage, and Outreach sections. Personalisation, Team, and Outreach are neutral placeholders for later phases. Billing is deferred: it is absent from customer navigation and customer Settings, and Checkout/Portal are not presented as normal SaaS features. Existing Stripe code remains installed unchanged; any existing billing administration remains platform-admin-only. Pipeline triggers, global provider status/costs, dead-letter diagnostics, global reset controls, and raw provider/model settings are available only through the platform-admin presentation.

## Deferred permission work

- Prompt 2 deliberately retains member edits to existing lead status/outcome and notes.
- The existing broad lead PATCH schemas should be narrowed to explicit customer-safe outcome and note fields when the Leads product view model is implemented.
- Workspace-owner-only lifecycle operations and ownership transfer need a dedicated policy before self-service workspace administration.
- Billing routes still exist behind workspace authorization, but Billing remains deferred and has no customer navigation or customer-facing Checkout/Portal entry point.
- Category, onboarding, workspace-profile, and mailbox handlers enforce the correct role today; a later cleanup can replace their local equivalent checks with the central helper without changing behavior.

## Prompt 3

Prompt 2.1 closes the remaining shell and raw Email Log/Report authorization gaps. Prompt 3 can proceed with customer signup and isolated workspace provisioning, provided it retains the server-side customer/admin boundaries documented here and uses a new customer-safe Inbox aggregation API rather than either raw internal email API.
