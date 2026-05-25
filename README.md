# ReachAgent

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Postgres-green?logo=supabase)
![Claude AI](https://img.shields.io/badge/Claude-Sonnet%204.6%20%2B%20Haiku%204.5-orange?logo=anthropic)
![Trigger.dev](https://img.shields.io/badge/Trigger.dev-Scheduled%20Jobs-purple)
![Resend](https://img.shields.io/badge/Resend-Email%20API-blue)

ReachAgent is a private, AI-powered outreach automation system for discovering leads, enriching contact data, generating personalized messages, sending outbound email, and tracking follow-up activity through a CRM dashboard.

The application is built with Next.js 16, TypeScript, Supabase, Trigger.dev, Anthropic Claude, Resend, Google Maps API, and Outscraper. It is designed as internal operations software with administrator-created accounts, role-based access control, configurable quotas, and database-driven category and location controls.

## Core Features

- Multi-agent pipeline: Finder -> Researcher -> Writer -> Sender -> Follow-up
- Google Maps API and Outscraper lead discovery providers
- Selectable primary search provider with fallback logic
- Dynamic category loading from the database
- Category enable/disable controls in Settings
- City and suburb management with suburb rotation using `last_used_at`
- Exhausted query caching to avoid repeatedly searching depleted queries
- Daily lead, email, DM, and provider spend limits
- CRM dashboard for leads, pipeline state, email log, DM queue, deals, and revenue
- Trigger.dev scheduled orchestration for long-running pipeline jobs
- Supabase Auth, profiles, RBAC, and protected dashboard/API routes

## Architecture

ReachAgent coordinates agents through database state transitions. Agents do not call each other directly; each stage reads eligible records, performs its responsibility, and writes the next state.

```text
Finder -> Researcher -> Writer -> Sender -> Follow-up
```

The operational flow is:

1. Finder loads active categories from Supabase, rotates through active suburbs, chooses the configured search provider, discovers candidate businesses, deduplicates queries and leads, and inserts new lead records.
2. Researcher enriches new leads by visiting websites and extracting contact details and business context.
3. Writer generates outreach content for researched leads and prepares email or DM queue records.
4. Sender sends pending email records through Resend and updates lead/email state.
5. Follow-up schedules and sends follow-up messages based on configured timing and quotas.

Trigger.dev runs the scheduled jobs, while the Next.js dashboard provides manual controls, observability, and CRM workflows.

## Lead Discovery Providers

ReachAgent supports two discovery providers:

| Provider | Role | Notes |
|----------|------|-------|
| Google Maps API | Primary provider | Used when `primary_search_api=google_maps`, `GOOGLE_MAPS_API_KEY` is configured, and Google Maps spend is within the configured monthly limit. |
| Outscraper | Fallback or alternative provider | Used when selected as primary, when Google Maps is unavailable, or when Google Maps fallback logic is triggered. |

Finder uses:

- `primary_search_api` setting to choose the preferred provider
- Google Maps monthly limit and cost-per-request settings for spend control
- Outscraper fallback when Google Maps is not available or fails
- `search_cache` to reuse recent provider results
- `exhausted_queries` to pause low-yield queries for a configured period

## Category and Location Controls

Categories are the source of truth for Finder selection. Finder only loads categories where `categories.status = 'active'`; paused categories are excluded from search selection.

Each active category supplies its own `search_keywords`, which can include `{suburb}` and `{city}` placeholders. Finder expands these keywords for active suburbs in active cities.

Suburbs are loaded from `city_suburbs` and ordered by `last_used_at ASC NULLS FIRST`, so never-used or oldest-used suburbs are searched first. After a suburb is used in a search, Finder updates `last_used_at`.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 App Router, React 19, TypeScript |
| Database/Auth | Supabase Postgres, Supabase Auth, RLS |
| Scheduling | Trigger.dev |
| AI | Anthropic Claude Haiku for extraction, Claude Sonnet for generation |
| Email | Resend |
| Lead Discovery | Google Maps API, Outscraper |
| UI | Tailwind CSS, Recharts, lucide-react |

## Environment Variables

Runtime secrets are stored in `.env.local` for local development and in the hosting/scheduler environments for deployed services.

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

Database-backed settings that affect discovery and quotas:

| Setting | Purpose |
|---------|---------|
| `primary_search_api` | Selects `google_maps` or `outscraper` as the preferred provider. |
| `daily_initial_outreach_limit` | Caps new cold outreach emails sent per day. Does not affect follow-up queues. |
| `daily_dm_limit` | Caps DM queue additions per day. |
| `daily_lead_limit` | Caps total lead volume for a pipeline run/day. |
| `daily_outscraper_limit` | Guards estimated Outscraper spend. |
| `google_maps_monthly_limit` | Caps Google Maps API monthly spend. |
| `active_cities` | Comma-separated city list used by Finder. |
| Category `status` | `active` categories are searched; `paused` categories are skipped. |
| Category `search_keywords` | Keyword templates used by Finder for each active category. |

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Apply Supabase migrations in order from `supabase/migrations/` for a new environment.

## Scheduled Jobs

Trigger.dev orchestrates scheduled work outside Vercel request timeouts:

- `daily-pipeline`: runs Finder, Researcher, Writer, and Sender in sequence
- `followup-job`: runs the follow-up cadence
- `digest-job`: sends operational summaries

Deploying scheduled jobs is separate from deploying the Next.js application:

```bash
npm run deploy:trigger
```

Do not run deployment commands from local debugging sessions unless you intentionally want to publish scheduler changes.

## Project Structure

```text
agents/                 Pipeline agents
scripts/                Local diagnostic and test scripts
src/app/                Next.js routes, pages, metadata, and API handlers
src/components/         Dashboard, settings, CRM, and layout components
src/lib/                Provider clients, AI helpers, auth, utilities
supabase/migrations/    Database schema and settings migrations
trigger/                Trigger.dev scheduled job definitions
```

## Documentation

See [DOCUMENTATION.md](./DOCUMENTATION.md) for the architecture reference, agent responsibilities, database model, provider behavior, deployment notes, and troubleshooting guidance.
