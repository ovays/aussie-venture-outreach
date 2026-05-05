# Outreach Automation Platform

An autonomous, multi-channel B2B lead generation and outreach system for local businesses. Discovers leads via Google Maps, enriches them with contact data, generates AI-personalised outreach copy, and executes email and Instagram DM campaigns on a configurable daily schedule — with no manual intervention required.

---

## How It Works

A cron job triggers the full pipeline once per day:

1. **Finder Agent** — queries Google Maps via Outscraper for configurable business categories and location; extracts emails and Instagram handles; deduplicates against existing leads
2. **Emailer Agent** — Claude AI generates a personalised pitch email per lead; delivered via Resend with bounce and reply tracking
3. **DM Agent** — queues Instagram DMs with deduplication; processes the queue on a schedule
4. **Follow-up Agent** — sends follow-up emails at 7 and 14 days; marks leads as inactive at 21 days
5. **Digest** — sends a daily summary with pipeline stats

---

## Features

- **Progressive fetching** — fetches leads in batches of 10, stops as soon as daily quota is met (reduces Outscraper cost by ~70%)
- **Multi-channel** — email and Instagram DM from a single pipeline
- **AI copy generation** — Claude writes context-aware messages tailored to each business category
- **Bounce & reply handling** — Resend webhooks update lead status automatically
- **Dashboard** — real-time monitoring of pipeline, leads, email log, DM queue, deals, and settings
- **Configurable limits** — daily caps per channel, master on/off switch, all managed via database settings (no redeployment)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Actions), TypeScript |
| Database | Supabase (PostgreSQL + Auth) |
| Job scheduling | Trigger.dev v4 |
| Email delivery | Resend |
| AI copywriting | Anthropic Claude API (Sonnet + Haiku) |
| Lead sourcing | Outscraper (Google Maps) |
| UI | React 19, Tailwind CSS v4, Recharts |
| Hosting | Vercel |

---

## Architecture

```
Trigger.dev cron (daily)
        │
        ▼
  Finder Agent
  ├── Phase 1: Email leads
  │     └── Google Maps search → website scrape → email extract → DB insert
  └── Phase 2: Instagram leads
        └── Google Maps search → handle extract → DB insert
        │
        ▼
  Emailer Agent
  └── Claude generates copy → Resend delivers → status tracked via webhook
        │
        ▼
  DM Agent
  └── Processes dm_queue → dispatches Instagram DMs → status updated
```

---

## Dashboard Pages

| Page | Description |
|---|---|
| `/dashboard` | Stats, pipeline summary, revenue chart, activity feed |
| `/dashboard/leads` | All leads with filters, search, and detail panel |
| `/dashboard/dm-queue` | Instagram DMs with queue management |
| `/dashboard/pipeline` | Kanban board — drag leads between stages |
| `/dashboard/email-log` | Full email history with previews |
| `/dashboard/deals` | Closed deals and revenue tracking |
| `/dashboard/settings` | System config and category management |

---

## Configuration

All limits are controlled via the `settings` table — no redeployment needed:

| Key | Default | Description |
|---|---|---|
| `daily_email_limit` | 30 | Max email leads to find per day |
| `daily_dm_limit` | 10 | Max DM leads per day |
| `daily_lead_limit` | 40 | Hard cap across both channels |
| `system_active` | `true` | Master on/off switch |

---

## Target Categories (example defaults)

**Email outreach**
- Travel Agents, Tour Operators, Boutique Hotels
- Beauty Salons, Hair Salons, Spas & Wellness Studios, Restaurants

**Instagram DM outreach**
- Restaurants, Cafes, Bakeries, Nail Salons

Categories, queries, and target cities are fully configurable per deployment.

---

## Cost Model

Outscraper charges per result returned. Progressive fetching keeps costs proportional to actual leads kept:

| Batch size | Results/day (est.) | Est. cost/day |
|---|---|---|
| 10 (default) | ~80 | ~$0.24 |
| 20 | ~160 | ~$0.48 |
| 50 | ~400 | ~$1.20 |

Each run logs `results_fetched`, `leads_kept`, and `efficiency` to the activity log.

---

## Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
OUTSCRAPER_API_KEY=
TRIGGER_SECRET_KEY=
```

---

## Getting Started

```bash
npm install
cp .env.example .env.local   # add your API keys
npm run dev                  # start local dev server
npm run deploy:trigger       # deploy scheduled pipeline jobs
```
