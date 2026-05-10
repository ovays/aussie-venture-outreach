# Autonomous Influencer Outreach System

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Postgres-green?logo=supabase)
![Claude AI](https://img.shields.io/badge/Claude-Sonnet%204.6%20%2B%20Haiku%204.5-orange?logo=anthropic)
![Trigger.dev](https://img.shields.io/badge/Trigger.dev-v3%20Cron-purple)
![Vercel](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel)
![Outscraper](https://img.shields.io/badge/Outscraper-Google%20Maps-red)
![Resend](https://img.shields.io/badge/Resend-Email%20API-blue)

---

## Overview

> Secure internal multi-user AI operations platform with Supabase Auth, admin-created accounts, persistent email/password sessions, protected route handlers, RBAC, and a dedicated Admin dashboard for team user management.

A production-deployed, fully autonomous multi-agent AI pipeline built with Next.js 16, TypeScript, and Supabase. Six specialised agents — Finder, Researcher, Writer, Sender, Follow-up, and Tracker — are orchestrated via a finite-state-machine lead lifecycle, with each agent reading its input state from the database, doing work, and writing its output state back. No agent calls another directly. Scheduling runs on Trigger.dev v3 (bypassing Vercel's function timeout ceiling); Claude Haiku 4.5 handles all structured-extraction tasks and Claude Sonnet 4.6 handles all generation tasks. A full CRM admin panel built in Next.js 16 with Supabase Realtime provides end-to-end pipeline visibility.

---

## Key Engineering Achievements

- **6-agent autonomous pipeline** — fully decoupled agents coordinated exclusively through a 9-state finite-state-machine (`new → researched → email_ready → contacted → replied → negotiating → closed / dead / dm_queued`); no direct inter-agent calls, no message queues
- **Agentic multi-turn email extraction** — Researcher agent runs a genuine agentic loop (up to 3 rounds): Claude Haiku analyses page content, decides the next action (`fetch_url` / `search_google` / `found` / `not_found`), executes it, then loops — not prompt chaining
- **Two-phase lead discovery** — Phase 1 runs Outscraper searches against email-yielding categories (empirically validated 70% hit rate on travel/hospitality); Phase 2 sources DM targets from existing DB records at zero API cost
- **Cost-aware progressive fetching** — fetches 10 results at a time, stops when quota is met; combines a `seenQueries` Set (checked before every API call) with a 3-day exhaustion cache in `exhausted_queries` table to eliminate redundant searches
- **Full CRM admin panel** — Kanban pipeline board, lead detail panel with inline email edit and resend, email log, DM queue, deal tracker, revenue chart, and a real-time health banner that surfaces agent errors and stale runs
- **Haiku-vs-Sonnet model routing** — extraction tasks routed to Haiku 4.5 (speed, cost, structured JSON output); generation tasks routed to Sonnet 4.6 (writing quality directly affects reply rate)

---

## Architecture

### Authentication and RBAC

Aussie Venture Outreach is private internal tooling. There is no public registration page, no OAuth, no magic links, and no self-service signup. Team access is controlled through Supabase Auth using email/password accounts created by an administrator.

- `profiles` extends `auth.users` with `email`, `full_name`, `role`, `is_active`, and `created_at`
- Roles are constrained to `admin` and `member`
- `admin` users can manage users, settings, categories, limits, system toggles, and all outreach workflows
- `member` users can operate the outreach system, manage leads, campaigns, pipeline, email logs, DM queues, and deals
- Next.js 16 `proxy.ts` performs request-time session checks for dashboard and internal API routes
- Server-side auth helpers validate active profiles and enforce admin-only access near route handlers and server-rendered pages
- Supabase RLS remains enabled, with service-role access reserved for controlled server operations and admin account management

The Admin area is a separate sidebar destination from Settings. Settings remains focused on app configuration, city/category controls, system limits, and pipeline toggles; Admin owns team identity and access management.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TRIGGER.DEV CLOUD (v3)                          │
│                                                                         │
│   08:00 AEST ──► digest-job ──────────────► sendDailyDigest()          │
│   09:00 AEST ──► followup-job ────────────► runFollowUpAgent()         │
│   20:00 AEST ──► daily-pipeline ──────────► [6-agent pipeline]         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────▼───────────────────────┐
        │           DAILY PIPELINE (sequential)          │
        │                                               │
        │   ┌──────────┐    ┌────────────┐              │
        │   │  FINDER  │───►│ RESEARCHER │              │
        │   │ Agent 1  │    │  Agent 2   │              │
        │   └──────────┘    └─────┬──────┘              │
        │                         │                     │
        │   ┌──────────┐    ┌─────▼──────┐              │
        │   │  SENDER  │◄───│   WRITER   │              │
        │   │ Agent 4  │    │  Agent 3   │              │
        │   └──────────┘    └────────────┘              │
        └───────────────────────────────────────────────┘

┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  OUTSCRAPER   │   │   SUPABASE    │   │    RESEND     │   │ ANTHROPIC API │
│ Google Maps   │──►│  PostgreSQL   │──►│ Email sending │   │ Haiku 4.5:    │
│ business data │   │  + Auth + RLS │   │ + webhooks    │   │   extraction  │
└───────────────┘   └───────┬───────┘   └───────────────┘   │ Sonnet 4.6:   │
                            │                               │   generation  │
                   ┌────────▼────────┐                      └───────────────┘
                   │  NEXT.JS 16     │
                   │  ADMIN PANEL    │
                   │  (Vercel)       │
                   │                 │
                   │  Dashboard      │
                   │  Leads CRM      │
                   │  Pipeline Kanban│
                   │  Email Log      │
                   │  DM Queue       │
                   │  Deals / Revenue│
                   │  Settings       │
                   └─────────────────┘
```

### Lead Lifecycle — Finite State Machine

```
                         ┌──────────────────────────────────────────┐
                         │            Finder Agent                   │
                         └───────────────────┬──────────────────────┘
                                             │
                                          [new]
                                             │
                         ┌───────────────────▼──────────────────────┐
                         │          Researcher Agent                 │
                         │    Claude Haiku agentic loop (3 rounds)   │
                         └───────────────────┬──────────────────────┘
                                             │
                                      [researched]
                                             │
                            ┌────────────────┴───────────────┐
                            │                                │
                       has email                      Instagram only
                            │                                │
                     [email_ready]                    [dm_queued]
                            │                                │
                       Sender Agent                   Manual DM send
                            │
                      [contacted]
                            │
               ┌────────────┴────────────┐
               │                         │
          reply received              no reply
               │                         │
         [negotiating]             day 7: follow-up 1
               │                   day 14: follow-up 2
           [closed]                day 21: [dead]
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 16 (App Router), TypeScript |
| **Database** | Supabase — PostgreSQL, Row-Level Security, Realtime |
| **AI — Extraction** | Claude Haiku 4.5 (structured JSON, agentic reasoning) |
| **AI — Generation** | Claude Sonnet 4.6 (outreach email and DM writing) |
| **Job Scheduling** | Trigger.dev v3 (long-running cron, live log streaming) |
| **Email Delivery** | Resend (send + webhook reply/bounce tracking) |
| **Business Data** | Outscraper (Google Maps search with contact fields) |
| **Hosting** | Vercel |
| **UI** | React 19, Tailwind CSS v4, Recharts |

---

## Project Structure

```
.
├── agents/                     # Six autonomous agents
│   ├── finder.ts               # Lead discovery via Google Maps + cost control
│   ├── researcher.ts           # Agentic multi-turn contact enrichment
│   ├── writer.ts               # LLM outreach email + DM generation
│   ├── sender.ts               # Email delivery via Resend
│   ├── followup.ts             # Timed follow-up cadence + dead-lead cleanup
│   ├── tracker.ts              # Webhook processing + daily digest
│   └── enricher.ts             # Website data extraction helper
│
├── trigger/                    # Trigger.dev scheduled jobs
│   ├── daily-pipeline.ts       # 20:00 AEST — runs all 6 agents sequentially
│   ├── followup-job.ts         # 09:00 AEST — follow-up cadence
│   └── digest-job.ts           # 08:00 AEST — daily summary email
│
├── src/
│   ├── app/
│   │   ├── api/                # Next.js route handlers
│   │   │   ├── leads/          # CRUD + [id]/resend
│   │   │   ├── pipeline/run/   # Manual pipeline trigger
│   │   │   ├── health/         # System health check
│   │   │   ├── settings/       # Runtime config
│   │   │   └── webhooks/resend/ # Inbound reply/bounce handler
│   │   └── dashboard/          # CRM pages (leads, pipeline, email-log, deals, settings)
│   │
│   ├── components/
│   │   ├── leads/              # LeadsTable, LeadDetailPanel (edit email, resend)
│   │   ├── pipeline/           # KanbanBoard, KanbanCard
│   │   ├── dashboard/          # StatsCard, RevenueChart, ActivityFeed
│   │   ├── layout/             # Sidebar, HealthBanner, TopBar
│   │   └── ui/                 # Badge, Button, Card, Modal, Toggle, ...
│   │
│   └── lib/
│       ├── claude.ts           # Anthropic SDK — extraction + generation calls
│       ├── outscraper.ts       # Google Maps search + result deduplication
│       ├── resend.ts           # Email send wrapper
│       └── supabase/           # Client + server Supabase instances
│
├── scripts/                    # Read-only test scripts (never write to DB)
│   ├── test-travel-emails.ts
│   ├── test-hotel-emails.ts
│   ├── test-email-extract.ts
│   └── ...
│
└── supabase/migrations/        # Schema migrations (run in order)
    ├── 001_initial_schema.sql
    ├── 004_city_suburbs.sql
    └── 005_exhausted_queries.sql
```

---

## Setup

### Prerequisites

Six services required — all have free tiers:

| Service | Purpose |
|---------|---------|
| [Supabase](https://supabase.com) | Database + auth |
| [Anthropic](https://console.anthropic.com) | Claude API |
| [Resend](https://resend.com) | Email delivery |
| [Outscraper](https://outscraper.com) | Google Maps data |
| [Trigger.dev](https://trigger.dev) | Job scheduling |
| [Vercel](https://vercel.com) | Hosting |

### Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
OUTSCRAPER_API_KEY=
TRIGGER_SECRET_KEY=
NEXT_PUBLIC_APP_URL=
ADMIN_EMAIL=
```

### Install and Run

```bash
npm install
cp .env.example .env.local   # fill in API keys

# Run database migrations in Supabase SQL Editor
# supabase/migrations/001_initial_schema.sql → 005_exhausted_queries.sql

npm run dev                  # local dev server
npm run deploy:trigger       # deploy pipeline jobs to Trigger.dev
```

> **Note:** `npm run deploy:trigger` must be run separately after every agent code change. Vercel deploys the Next.js app; Trigger.dev jobs run on separate infrastructure.

---

## Full Technical Documentation

**[DOCUMENTATION.md](./DOCUMENTATION.md)** — complete technical reference including:

- Agent responsibilities and implementation details
- Agentic researcher pattern (multi-turn reasoning loop)
- LLM model routing rationale and token budget design
- Database schema and entity relationships
- Cost engineering techniques and optimisation decisions
- Architecture decision records
- Troubleshooting guide
- Roadmap (RAG-based email quality improvement, reply intelligence, multi-tenant SaaS)
