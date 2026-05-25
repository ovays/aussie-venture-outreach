# ReachAgent Architecture Reference

ReachAgent is a private AI-powered outreach automation system. It discovers business leads, enriches contact and context data, generates outreach content, sends email, manages follow-ups, and exposes CRM workflows through a secured dashboard.

This document is the technical reference for the current architecture as of May 2026.

## System Overview

ReachAgent is built around a database-coordinated multi-agent pipeline:

```text
Finder -> Researcher -> Writer -> Sender -> Follow-up
```

Each agent owns one stage of work. Agents coordinate by reading and updating Supabase records rather than calling one another directly. Trigger.dev schedules the long-running jobs, while the Next.js application provides authentication, settings, manual controls, dashboards, and CRM views.

## Current Lead Discovery Flow

Finder is the only stage that creates new leads. Its current discovery behavior is:

1. Read runtime limits from `settings`, including lead, email, DM, and provider spend limits.
2. Load active cities from `settings.active_cities`.
3. Load active suburbs from `city_suburbs`, ordered by `last_used_at ASC NULLS FIRST`.
4. Load active categories from `categories` where `status = 'active'`.
5. Expand each active category's `search_keywords` using `{suburb}` and `{city}` placeholders.
6. Skip duplicate queries already seen in the current run.
7. Skip cached exhausted queries from `exhausted_queries`.
8. Route the search through the selected provider:
   - Google Maps API when configured as primary and within budget.
   - Outscraper when configured as primary, or as fallback.
9. Cache provider results in `search_cache` where applicable.
10. Insert deduplicated leads with `status = 'new'`.
11. Mark searched suburbs with `city_suburbs.last_used_at = NOW()`.
12. Mark low-yield queries as exhausted to avoid repeated waste.

Disabled categories never enter Finder selection. Category controls in the admin UI update the `categories.status` field; Finder uses only `active` rows.

## Lead Discovery Providers

ReachAgent supports two provider integrations for lead discovery.

| Provider | Use case | Selection behavior |
|----------|----------|--------------------|
| Google Maps API | Preferred direct search provider | Used when `primary_search_api = google_maps`, `GOOGLE_MAPS_API_KEY` is set, monthly spend is under limit, and the request is eligible. |
| Outscraper | Fallback and alternative provider | Used when `primary_search_api = outscraper`, when Google Maps is unavailable, or when Google Maps search fails. |

Provider routing is handled below Finder through the search abstraction. Finder remains responsible for query generation, quotas, dedupe, exhaustion, suburb rotation, category filtering, and lead insertion.

## Pipeline Stages

### Finder

Responsibility: discover candidate leads.

Inputs:

- `settings`
- `categories`
- `city_suburbs`
- `exhausted_queries`
- `search_cache`

Outputs:

- `leads` with `status = 'new'`
- `exhausted_queries`
- `city_suburbs.last_used_at`
- activity logs

Key controls:

- Dynamic DB-loaded categories
- Category enable/disable
- Suburb rotation
- Active city filtering
- Search provider selection
- Provider fallback
- Query dedupe
- Exhausted query caching
- Daily quota and spend limits

### Researcher

Responsibility: enrich new leads with website context, email addresses, social handles, descriptions, and services.

Researcher uses Claude Haiku for structured extraction and short reasoning loops over fetched web pages. It updates lead records to `status = 'researched'` when enrichment is complete or when the lead has enough information for downstream processing.

### Writer

Responsibility: generate outreach content for researched leads.

Writer reads leads with `status = 'researched'`, generates email or DM content using Claude Sonnet, inserts pending email or DM queue records, and advances lead status.

Writer currently logs category status diagnostics so operators can distinguish between newly discovered active-category leads and older researched leads that were already in the database before a category was disabled.

### Sender

Responsibility: send pending outbound emails.

Sender reads pending email rows, sends through Resend, updates email status, and transitions leads to contacted states. Resend webhooks update delivery, bounce, and reply state.

### Follow-up

Responsibility: manage timed follow-up cadence.

The follow-up job reads contacted leads, checks configured timing and quota settings, sends eligible follow-up messages, and marks leads dead when configured no-reply windows expire.

## Scheduled Orchestration

Trigger.dev runs scheduled jobs outside normal request timeouts.

| Job | Purpose |
|-----|---------|
| `daily-pipeline` | Runs the main pipeline sequence. |
| `followup-job` | Runs follow-up cadence checks and sends eligible follow-ups. |
| `digest-job` | Sends operational summaries. |

The Next.js dashboard can also trigger pipeline work manually through internal API routes, subject to authentication and system settings.

## Authentication and RBAC

ReachAgent is private internal tooling. There is no public signup flow. Administrators create accounts through Supabase Auth-backed admin workflows.

Roles:

- `admin`: can manage users, settings, categories, cities, quotas, and operational controls.
- `member`: can operate CRM workflows and view pipeline data.

Route protection is enforced in Next.js proxy/auth helpers and server-side route handlers. Supabase service-role access is reserved for controlled server operations.

## Database Model

Core tables:

| Table | Purpose |
|-------|---------|
| `settings` | Runtime configuration, quotas, provider selection, active cities. |
| `categories` | Search category definitions, keyword templates, enable/disable state. |
| `city_suburbs` | Active city/suburb search areas and rotation timestamp. |
| `leads` | Lead lifecycle state and enriched business data. |
| `emails` | Generated and sent email records. |
| `dm_queue` | Manual or prepared DM outreach records. |
| `deals` | Revenue and deal tracking. |
| `activity_log` | Pipeline and UI observability events. |
| `exhausted_queries` | Temporary cache of low-yield searches. |
| `search_cache` | Recent provider search results. |
| `profiles` | Application user roles and active/inactive status. |

## Key Settings and Environment

Environment variables:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
GOOGLE_MAPS_API_KEY=
OUTSCRAPER_API_KEY=
TRIGGER_SECRET_KEY=
NEXT_PUBLIC_APP_URL=
ADMIN_EMAIL=
```

Database settings:

| Setting | Purpose |
|---------|---------|
| `primary_search_api` | Selects `google_maps` or `outscraper`. |
| `daily_lead_limit` | Caps total lead throughput. |
| `daily_initial_outreach_limit` | Caps new cold outreach emails per day. Does not affect follow-up queues. |
| `daily_dm_limit` | Caps DM queue volume. |
| `daily_outscraper_limit` | Guards estimated Outscraper spend. |
| `google_maps_monthly_limit` | Guards Google Maps spend. |
| `google_maps_cost_per_request` | Used for Google Maps spend accounting. |
| `active_cities` | Limits Finder to configured city areas. |
| `system_active` | Master operational switch. |

Category controls:

- `categories.status = 'active'`: category is eligible for Finder.
- `categories.status = 'paused'`: category is excluded from Finder.
- `categories.search_keywords`: source of query templates.
- `categories.cities` and `custom_cities`: category targeting metadata.

## Admin Dashboard

The dashboard includes:

- Overview metrics and activity feed
- Lead table and detail panel
- Pipeline Kanban
- Email log
- DM queue
- Deals and revenue reporting
- Settings for quotas, provider selection, cities, suburbs, categories, and test email previews
- Admin user management
- Health banner for recent pipeline failures and operational warnings

## Deployment Notes

ReachAgent has two deployable surfaces:

1. Next.js application, typically hosted on Vercel.
2. Trigger.dev scheduled jobs, deployed separately.

Local development:

```bash
npm install
npm run dev
```

Production build check:

```bash
npm run build
```

Trigger deployment:

```bash
npm run deploy:trigger
```

Run Trigger deployment only when intentionally publishing scheduler or agent changes.

## Local Diagnostics

Useful local checks:

```bash
npm run build
node_modules\.bin\tsx.cmd scripts\test-finder-categories.ts
```

The Finder category diagnostic script is read-only. It loads the same active DB category set used by Finder and prints disabled categories separately, allowing operators to confirm that paused categories do not enter discovery selection.

## Operational Safeguards

- System-wide pause via `system_active`.
- Quotas for leads, emails, and DMs.
- Provider cost guards.
- Query dedupe within each Finder run.
- Exhausted query caching across runs.
- Search result caching.
- Suburb rotation to spread discovery coverage.
- Category enable/disable controls.
- Health checks and activity logs.

## Troubleshooting

Disabled category still appears in new Finder searches:

- Confirm the category row has `status = 'paused'`.
- Run `scripts/test-finder-categories.ts`.
- Confirm it appears only under disabled categories.
- Check whether observed leads were created before the category was paused.

Provider selection does not match expectations:

- Check `primary_search_api`.
- Confirm `GOOGLE_MAPS_API_KEY` is available when using Google Maps.
- Check Google Maps monthly spend settings.
- Check Outscraper key and balance when using fallback.

Pipeline appears stuck:

- Check `activity_log`.
- Check Trigger.dev run logs.
- Check lead status distribution in the dashboard.
- Check Resend API/webhook health for email stages.

No new leads are found:

- Confirm active cities and active suburbs exist.
- Confirm at least one active category has search keywords.
- Check exhausted query cache.
- Check provider API keys and spend limits.
