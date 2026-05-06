# Autonomous Influencer Outreach System

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Postgres-green?logo=supabase)
![Claude AI](https://img.shields.io/badge/Claude-Sonnet%204.6%20%2B%20Haiku%204.5-orange?logo=anthropic)
![Trigger.dev](https://img.shields.io/badge/Trigger.dev-v3%20Cron-purple)
![Vercel](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel)
![Outscraper](https://img.shields.io/badge/Outscraper-Google%20Maps-red)
![Resend](https://img.shields.io/badge/Resend-Email%20API-blue)

> **~$14/month operational cost · $0.016 per lead · 56x–94x ROI per closed deal**

---

## What Is This?

A production-deployed, fully autonomous multi-agent AI pipeline that enables content creators to monetise their audience through automated B2B outreach. The system runs daily without human intervention — discovering local businesses via Google Maps, extracting verified contact information using an agentic multi-turn web crawler (Claude Haiku), generating hyper-personalised outreach emails via LLM (Claude Sonnet 4.6), delivering them through Resend, and managing the complete sales lifecycle from lead discovery to revenue close. A full CRM admin panel (Next.js 16 + Supabase) provides real-time visibility across every stage of the pipeline.

---

## Key Engineering Achievements

- **6-agent agentic pipeline** with zero manual intervention — agents are fully decoupled, coordinated exclusively through a 9-state finite-state-machine lead lifecycle (no direct agent-to-agent calls)
- **Multi-turn agentic email extraction** — Researcher agent uses Claude Haiku in a genuine agentic loop (up to 3 rounds): reasons across homepage → `/contact` → web search, deciding each next action dynamically rather than following a fixed script
- **Two-phase lead discovery** — Phase 1 targets email-findable categories (empirically validated 70% hit rate on travel agents); Phase 2 sources Instagram DM targets from existing DB records at zero Outscraper cost
- **Cost-aware progressive fetching** — fetches 10 results at a time with query deduplication (`seenQueries` Set), 3-day exhaustion caching (`exhausted_queries` table), and a configurable daily spend guard; reduces Outscraper API costs by ~80% vs naive implementation
- **Haiku-vs-Sonnet model routing** — Claude Haiku 4.5 for all structured extraction tasks (speed + cost), Claude Sonnet 4.6 for all generative tasks (quality directly impacts reply rate and revenue)
- **RAG-ready architecture** — reply rates and email variants stored in DB; retrieval-augmented generation can inject top-performing past emails as few-shot examples into Writer prompts at inference time
- **Full CRM admin panel** — Kanban pipeline, email log with resend-from-panel, deal tracking, revenue analytics, system health monitoring (Next.js 16 + Supabase Realtime)

---

## Architecture

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
Outscraper → [new] → Researcher → [researched] → Writer ─┬─ [email_ready] → Sender → [contacted]
                                                          └─ [dm_queued] → manual Instagram DM

[contacted] ──► reply received → [negotiating] → [closed]
            └── no reply → day 7 follow-up → day 14 follow-up → day 21 → [dead]
```

---

## Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Framework** | Next.js 16, TypeScript | Admin panel + API routes |
| **Database** | Supabase (PostgreSQL + RLS + Realtime) | Lead store, settings, audit log |
| **AI — Extraction** | Claude Haiku 4.5 | Agentic email search, website data extraction |
| **AI — Generation** | Claude Sonnet 4.6 | Outreach email writing, DM writing |
| **Job Scheduling** | Trigger.dev v3 | Long-running cron pipeline (no 60s timeout) |
| **Email Delivery** | Resend | Send + webhook reply/bounce tracking |
| **Business Data** | Outscraper | Google Maps search with contact fields |
| **Hosting** | Vercel | Zero-config Next.js deployment |
| **UI** | React 19, Tailwind CSS v4, Recharts | Dashboard components + revenue charts |

---

## Cost Model

| Service | Monthly Usage | Cost |
|---------|--------------|------|
| Outscraper | ~80 results/day × 30 × $0.003 | ~$7.20 |
| Claude Sonnet 4.6 | 30 emails/day × $0.007 × 30 days | ~$6.30 |
| Claude Haiku 4.5 | 30 extractions/day × $0.001 × 30 days | ~$0.90 |
| Resend | 900 emails/month (free tier: 3,000) | **$0** |
| Trigger.dev | ~90 runs/month (free tier: 10,000) | **$0** |
| Supabase | Free tier | **$0** |
| Vercel | Free tier | **$0** |
| **Total** | | **~$14.40/month** |

```
Cost per lead:    $0.016   |   Average deal value: $300–$500
Cost per deal:    ~$0.53   |   ROI per deal:        56x–94x
```

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/ovays/aussie-venture-outreach
npm install

# 2. Set environment variables
cp .env.example .env.local
# Fill in: SUPABASE_*, ANTHROPIC_API_KEY, RESEND_API_KEY, OUTSCRAPER_API_KEY, TRIGGER_SECRET_KEY

# 3. Run database migrations (Supabase SQL Editor)
# supabase/migrations/001_initial_schema.sql → 005_exhausted_queries.sql

# 4. Start local dev
npm run dev

# 5. Deploy pipeline jobs to Trigger.dev (separate from Vercel deploy)
npm run deploy:trigger
```

**Required services** (all have free tiers): [Supabase](https://supabase.com) · [Resend](https://resend.com) · [Outscraper](https://outscraper.com) · [Anthropic](https://console.anthropic.com) · [Trigger.dev](https://trigger.dev) · [Vercel](https://vercel.com)

> **Note:** Every time agent code changes, run `npm run deploy:trigger` separately — Vercel only deploys the Next.js app; Trigger.dev jobs run on separate infrastructure.

---

## Documentation

See **[DOCUMENTATION.md](./DOCUMENTATION.md)** for complete technical documentation including:

- Full agent architecture and responsibilities
- Agentic researcher pattern explained
- LLM model routing rationale (Haiku vs Sonnet)
- Database schema and ERD
- Cost engineering techniques
- Architecture decision records
- Troubleshooting guide
- Multi-creator SaaS roadmap

---

*Built May 2026 · Next.js 16 · TypeScript · Supabase · Claude AI · Trigger.dev · Vercel*
