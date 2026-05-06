# Autonomous Influencer Outreach System

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-Postgres-green?logo=supabase)
![Claude AI](https://img.shields.io/badge/Claude-Sonnet%204.6%20%2B%20Haiku%204.5-orange?logo=anthropic)
![Trigger.dev](https://img.shields.io/badge/Trigger.dev-v3%20Cron-purple)
![Vercel](https://img.shields.io/badge/Vercel-Deployed-black?logo=vercel)
![Outscraper](https://img.shields.io/badge/Outscraper-Google%20Maps-red)
![Resend](https://img.shields.io/badge/Resend-Email%20API-blue)
![License](https://img.shields.io/badge/license-Private-lightgrey)

> **Last updated:** May 2026 | **Operational cost:** ~$14/month | **ROI:** 56x–94x per closed deal | **Lead cost:** $0.016

---

## Resume Summary

**Autonomous Influencer Outreach System** | May 2026
*Next.js 16 · TypeScript · Supabase · Claude AI (Sonnet 4.6 + Haiku 4.5) · Trigger.dev v3 · Vercel · Outscraper*

Designed and built a production-grade, fully autonomous multi-agent AI pipeline that enables content creators to monetise their audience through automated B2B outreach. The system implements a **finite-state-machine lead lifecycle** coordinating 6 specialised AI agents — each with a single responsibility — across a daily scheduled pipeline that discovers businesses, extracts contact information via agentic web scraping, generates hyper-personalised outreach using **LLM orchestration**, and manages the complete sales lifecycle from discovery to revenue close.

**Key engineering achievements:**
- Architected a **6-agent agentic pipeline** with zero manual intervention using LLM orchestration, finite-state-machine coordination, and cron-based scheduling (Trigger.dev v3); agents are fully decoupled — each reads its input state, does work, writes its output state
- Built a **two-phase intelligent lead discovery engine** with empirically validated 70% email hit rate on travel/hospitality categories and a free Phase 2 for Instagram DM targets
- Implemented a **multi-turn agentic email extraction loop** (Researcher agent): Claude Haiku reasons across homepage → `/contact` → web search across up to 3 rounds, deciding each action dynamically — a genuine agentic pattern, not prompt chaining
- Engineered **cost-aware progressive fetching** with query deduplication (`seenQueries` Set), 3-day exhaustion caching (`exhausted_queries` table), and configurable daily spend guards — reducing Outscraper costs by ~80% vs naive implementation
- Applied **Haiku-vs-Sonnet model routing**: Haiku 4.5 for all structured-extraction tasks (cheap, fast, JSON-output), Sonnet 4.6 for all generative tasks (quality directly impacts reply rates and revenue)
- **RAG-ready architecture**: reply rates and email variants stored in DB; retrieval-augmented generation can inject top-performing past emails as few-shot examples into Writer prompts at inference time
- Delivered a full **CRM admin panel** (Next.js 16 + Supabase Realtime) with Kanban pipeline, email log with resend-from-panel, deal tracking, revenue analytics, and system health monitoring
- **Operational cost:** ~$0.016/lead · ~$14/month total · ROI: 56x–94x per closed deal at $300–$500 average deal value

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Agent Orchestration](#3-agent-orchestration)
4. [Two-Phase Finder Logic](#4-two-phase-finder-logic)
5. [LLM Usage — Haiku vs Sonnet](#5-llm-usage--haiku-vs-sonnet)
6. [Database Schema](#6-database-schema)
7. [Admin Panel](#7-admin-panel)
8. [Pipeline Flow](#8-pipeline-flow)
9. [Cost Engineering](#9-cost-engineering)
10. [Architecture Decisions](#10-architecture-decisions)
11. [Tech Stack Decisions](#11-tech-stack-decisions)
12. [Deployment](#12-deployment)
13. [Testing](#13-testing)
14. [Future Roadmap](#14-future-roadmap)
15. [Troubleshooting](#15-troubleshooting)
16. [Portfolio Notes](#16-portfolio-notes)

---

## 1. Project Overview

### What Is This?

A **fully autonomous B2B lead generation and outreach pipeline** built for content creators. The system runs daily without human intervention — discovering local businesses aligned with the creator's audience, extracting verified contact information using AI-powered web scraping, generating personalised outreach via LLM, sending emails automatically, following up on a configurable cadence, and surfacing warm replies for the creator to close manually.

### Why Multi-Agent?

Rather than one monolithic process, the system uses 6 specialised agents — each with a single, well-defined responsibility. This architecture enables:

- **Independent scaling** — each agent can be tuned, rate-limited, or swapped without touching others
- **Fault isolation** — a failure in the Writer agent doesn't break the Finder
- **Observability** — every agent logs to `activity_log`, making debugging trivial
- **Composability** — agents can be triggered independently (e.g. run only the Sender to flush a backlog)
- **State-machine coordination** — agents communicate exclusively through lead status transitions (`new → researched → email_ready → contacted`), with no direct coupling between them

### Problem → Solution

| Manual Process | Automated Solution |
|---------------|-------------------|
| Manually searching Google Maps for businesses | Outscraper API + intelligent category search |
| Visiting each website to find an email | Agentic multi-turn crawler (Claude Haiku, up to 3 rounds) |
| Writing personalised emails | Claude Sonnet 4.6 with business context injection |
| Sending and tracking emails | Resend API + webhook reply detection |
| Remembering to follow up | Scheduled follow-up agent (day 7, 14) |
| Tracking deals and revenue | Full CRM in admin dashboard |
| Re-querying depleted searches | 3-day exhaustion cache (`exhausted_queries` table) |

---

## 2. System Architecture

### High-Level Architecture Diagram

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
        │                                               │
        │   ┌──────────┐    ┌────────────┐              │
        │   │ FOLLOWUP │    │  TRACKER   │              │
        │   │ Agent 5  │    │  Agent 6   │              │
        │   └──────────┘    └────────────┘              │
        └───────────────────────────────────────────────┘

┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  OUTSCRAPER   │   │   SUPABASE    │   │    RESEND     │   │ ANTHROPIC API │
│               │   │               │   │               │   │               │
│ Google Maps   │──►│  PostgreSQL   │──►│ Email sending │   │ Haiku 4.5:    │
│ business data │   │  + Auth + RLS │   │ + webhooks    │   │   extraction  │
│ pay-per-result│   │  + Realtime   │   │ reply tracking│   │ Sonnet 4.6:   │
└───────────────┘   └───────┬───────┘   └───────────────┘   │   generation  │
                            │                               └───────────────┘
                   ┌────────▼────────┐
                   │  NEXT.JS 16     │
                   │  ADMIN PANEL    │
                   │  (Vercel)       │
                   │                 │
                   │  Dashboard      │
                   │  Leads CRM      │
                   │  Pipeline Kanban│
                   │  Email Log      │
                   │  DM Queue       │
                   │  Deals          │
                   │  Settings       │
                   └─────────────────┘
```

### Lead Lifecycle — Finite State Machine

The 9-state FSM is the **coordination mechanism** between all agents. No agent calls another directly — they communicate solely by reading and writing lead status in the database.

```
                    ┌─────────────────────────────────┐
                    │  Outscraper API (Finder Agent)   │
                    └────────────────┬────────────────┘
                                     │
                                  [new]
                                     │
                    ┌────────────────▼────────────────┐
                    │         Researcher Agent         │
                    │  (Claude Haiku — agentic loop)   │
                    └────────────────┬────────────────┘
                                     │
                              [researched]
                                     │
                       ┌─────────────┴──────────────┐
                       │                            │
                  has email                   Instagram only
                       │                            │
                [email_ready]               [dm_queued] ──► DM Queue
                       │                            │      (manual send)
            Sender Agent sends                      │
                       │                            │
                 [contacted]                   [contacted]
                       │
              ┌────────┴────────┐
              │                 │
         reply received      no reply
              │                 │
        [negotiating]     day 7: Follow-up 1 sent
              │             day 14: Follow-up 2 sent
           [closed]         day 21+: ──► [dead]
              │
     Deal created in deals table
```

---

## 3. Agent Orchestration

### Agent 1: Finder (`agents/finder.ts`)

**Responsibility:** Discover qualified business leads via Google Maps search with intelligent cost control.

**LLM used:** None — pure algorithmic logic

**Key innovations:**
- **Two-phase architecture** — Phase 1 targets email-findable categories (travel agents, hotels); Phase 2 is zero-cost Instagram targeting from existing DB records
- **Progressive fetching** — fetches 10 results at a time, stops the moment quota is met (not 50 upfront)
- **Query deduplication** — `seenQueries` Set (checked before any API call) prevents re-fetching within a run; Set is initialised outside the category loop so it persists across all categories
- **Suburb deduplication** — suburbs loaded into `Set<string>` per city before iteration, preventing duplicate DB rows from causing re-searches
- **Exhaustion detection** — queries returning ≤1 usable lead are marked exhausted for 3 days in `exhausted_queries` table
- **Daily cost guard** — reads `daily_outscraper_limit` setting; halts pipeline if estimated spend exceeds threshold
- **Junk email filter** — two-layer validation: `isValidEmail()` (regex/blocklist) + `isValidBusinessEmail()` (sentry IDs, junk domains, placeholder prefixes)
- **Irrelevant business filter** — keyword blocklist rejects visa agents, schools, dentists, etc. before any web fetch is attempted

**Inputs:** Settings from DB, `city_suburbs` table, `exhausted_queries` table
**Outputs:** `leads` rows with `status='new'`, `exhausted_queries` rows

---

### Agent 2: Researcher (`agents/researcher.ts`)

**Responsibility:** Enrich leads with contact information using an agentic multi-step web crawler.

**LLM used:** Claude Haiku 4.5 (cheap, fast, structured JSON output)

**Agentic loop (genuine multi-turn reasoning, up to 3 rounds):**
```
Round 1: Fetch homepage → Claude Haiku analyses content → returns JSON decision:
         { action: 'found', email: '...' }          — stop, use this email
         { action: 'fetch_url', url: '/contact' }   — fetch that subpage
         { action: 'search_google', query: '...' }  — run a web search
         { action: 'not_found' }                    — give up

Round 2: Execute the chosen action → feed content back to Claude Haiku
         → Claude returns next decision

Round 3: Final extraction attempt → give up if still not found
```

This is a genuine **agentic pattern** — Claude reasons about what to do next given the evidence, rather than following a fixed script. The multi-turn conversation is preserved across rounds so Claude has full context.

**Inputs:** Leads with `status='new'`
**Outputs:** Leads updated to `status='researched'` with enriched fields (`email`, `instagram_handle`, `description`, `services`)

---

### Agent 3: Writer (`agents/writer.ts`)

**Responsibility:** Generate personalised outreach content using LLM.

**LLM used:** Claude Sonnet 4.6 (best writing quality — directly impacts reply rates)

**Personalisation signals injected into prompt:**
- Business name, category, suburb, city
- Description and services (extracted by Researcher)
- Content type (`visit` for Sydney local businesses, `remote` for inter-state)
- Category-specific pitch angle (`getCategoryPitch()` — different angle for food vs travel vs beauty)
- Hard brand voice rules (no em-dashes, casual Australian tone, under 80 words, specific sign-off)

**Stale lead cleanup:** Before writing, the Writer resets any `email_ready` leads with no pending email back to `researched` — guards against orphaned state from previous failed runs.

**Inputs:** Leads with `status='researched'`
**Outputs:** `emails` rows (`status='pending_send'`), `dm_queue` rows

---

### Agent 4: Sender (`agents/sender.ts`)

**Responsibility:** Deliver queued emails via Resend API.

**LLM used:** None

**Key logic:**
- Joins `emails` → `leads` to resolve the `to` address
- Respects `daily_email_limit` setting
- Updates lead to `contacted` on successful send
- Stores `resend_id` for webhook correlation (reply/bounce tracking)

**Inputs:** `emails` rows with `status='pending_send'`
**Outputs:** Emails delivered, leads updated to `status='contacted'`

---

### Agent 5: Follow-up (`agents/followup.ts`)

**Responsibility:** Send timed follow-up emails and mark leads dead after final follow-up.

**LLM used:** None (template-based — consistency more important than creativity here)

**Cadence:**
```
Day 0:  Initial pitch (Sender Agent)
Day 7:  "Bumping this in case my last email got buried..."
Day 14: "Last message from me on this one..."
Day 21: Lead status → [dead]
```

**Inputs:** Leads with `status='contacted'` past their follow-up window
**Outputs:** Follow-up emails sent, leads eventually marked `dead`

---

### Agent 6: Tracker (`agents/tracker.ts`)

**Responsibility:** Process Resend webhooks and dispatch daily digest email.

**Functions:**
- `handleEmailReply()` — called by Resend webhook on inbound reply, updates lead to `replied`, logs to `activity_log`
- `handleEmailBounce()` — flags bounced emails for review, marks lead appropriately
- `sendDailyDigest()` — compiles 24h pipeline stats and emails a summary to the operator

---

## 4. Two-Phase Finder Logic

### Phase 1 — Email Leads (Automated, Outscraper-powered)

Target categories ordered by empirically measured email yield:

| Category | Search Query | Email Yield | Cap |
|----------|-------------|-------------|-----|
| Travel Agents | `travel agent {suburb}` | ~70% | `EMAIL_TARGET / 4` |
| Tour Operators | `tour operator {suburb}` | ~55% | `EMAIL_TARGET / 4` |
| Boutique Hotels | `boutique hotel {suburb}` | ~40% | `EMAIL_TARGET / 4` |
| Beauty Studios | `beauty studio {suburb}` | ~30% | `EMAIL_TARGET / 4` |
| Hair Salons | `hair salon {suburb}` | ~20% | Remaining quota |
| Day Spas | `day spa {suburb}` | ~20% | Remaining quota |
| Restaurants | `halal restaurant {suburb}` | ~15% | Remaining quota |

**Note on yield figures:** Derived from running `scripts/test-travel-emails.ts` and `scripts/test-hotel-emails.ts` against live data. Large hotel chains (Hilton, Hyatt, Marriott) return HTTP 403, skewing hotel yield down — boutique hotels perform significantly better. The capped-category design ensures variety: the first 4 categories cannot consume the entire quota, so lower-yield categories always get a turn.

### Phase 2 — Instagram DM Leads (Free — zero Outscraper cost)

Phase 2 sources leads entirely from existing DB records that were found in Phase 1 but had no email. Zero Outscraper calls.

```typescript
// Phase 2 is FREE — queries existing leads, no API calls
const dmCandidates = await supabase
  .from('leads')
  .select('id, business_name, category_name, city, state')
  .in('category_name', DM_CATEGORY_NAMES)  // Restaurants, Cafes, Nail Salons, etc.
  .is('email', null)
  .eq('status', 'new')
  .in('city', activeCities)
  .limit(DM_TARGET * 3)
```

### Email Extraction Pipeline

```
For each business website:

1. mailto: link scan (highest confidence — 100% accurate)
   regex: /href=["']mailto:([email])/gi
   Runs on RAW HTML so mailto links inside <script> blocks are captured

2. Full HTML regex scan (fallback)
   regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
   Note: runs on RAW HTML — emails in JSON-LD schema blocks survive this

3. Fetch /contact subpage → repeat steps 1-2
4. Fetch /about subpage   → repeat steps 1-2

→ Max 3 page fetches per business (cost control)
→ 5 second timeout per fetch (abort controller)
→ Stop immediately on first valid email found
```

### Two-Layer Email Validation

**Layer 1 — `isValidEmail()`:** General format and local-part heuristics
```typescript
function isValidEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0]

  // Transactional/system address blocklist
  const BLOCKED = ['noreply', 'donotreply', 'no-reply', 'wordpress',
                   'postmaster', 'webmaster', 'bounce', 'mailer']
  if (BLOCKED.has(local)) return false

  if (local.length < 4) return false
  if (/\.(png|jpg|gif|svg|css|js)$/i.test(email)) return false  // image/asset paths

  // Require at least a vowel or separator — rejects random IDs
  const hasVowel = /[aeiou]/.test(local)
  const hasSep   = /[._]/.test(local)
  if (!hasVowel && !hasSep) return false

  // Short alphanumeric + digit = tracking ID (bg0i, ey6i, a3b)
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false

  return true
}
```

**Layer 2 — `isValidBusinessEmail()`:** Domain and structural quality filter
```typescript
function isValidBusinessEmail(email: string, businessName: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const local  = email.split('@')[0]?.toLowerCase() ?? ''

  // Reject known junk/infrastructure domains
  const JUNK_DOMAINS = ['sentry.io', 'wixpress.com', 'mailchimp.com',
                        'sendgrid.net', 'example.com', 'domain.com', 'mail.com']
  if (JUNK_DOMAINS.some(d => domain.includes(d))) return false

  // Reject placeholder prefixes
  const PLACEHOLDERS = ['example@', 'user@', 'test@', 'demo@', 'sample@']
  if (PLACEHOLDERS.some(p => email.startsWith(p))) return false

  // Reject hex Sentry/error-tracking IDs (e.g. e4701945b71443f5@sentry.io)
  if (/^[a-f0-9]{20,}$/.test(local)) return false

  if (!domain.includes('.')) return false

  return true
}
```

---

## 5. LLM Usage — Haiku vs Sonnet

### Model Routing Strategy

The system routes tasks to different Claude models based on the nature of the output required:

| Task | Model | Rationale | Avg Token Cost |
|------|-------|-----------|----------------|
| Website data extraction (description, services, socials) | Claude Haiku 4.5 | Structured JSON output — speed and cost dominate | ~$0.001/call |
| Agentic email search (multi-turn reasoning) | Claude Haiku 4.5 | Reasoning quality sufficient; up to 3 rounds per lead | ~$0.003/search |
| Outreach email writing | Claude Sonnet 4.6 | Naturalness, tone, personalisation directly affect reply rate | ~$0.007/email |
| Instagram DM writing | Claude Sonnet 4.6 | Same — conversion quality matters | ~$0.004/DM |

**Why two models?**

Haiku handles all *extraction* tasks — these require structured output and reasoning over page content, not creative quality. Sonnet handles all *generation* tasks — the quality of the outreach email is the system's primary conversion lever. Using Haiku for extraction saves ~$3/month vs using Sonnet for everything, with no measurable quality loss on extraction.

### Prompt Engineering Principles Applied

- **Explicit JSON schema in system prompt** for all extraction tasks — prevents hallucinated field names and eliminates post-processing
- **Negative examples** for writing tasks (`"never say 'I hope this email finds you well'"`, `"no em dashes"`) — more effective than positive instructions alone
- **Agentic chain-of-thought** for the Researcher (`"analyse the page, decide what to do next, respond with one JSON action"`) — enables genuine multi-step reasoning
- **Hard constraint injection** for the Writer (`"under 80 words not counting sign-off"`, `"last line must be exactly: 'Would you be keen to collab?'"`) — enforces consistent brand voice
- **Category-specific pitch angles** — `getCategoryPitch()` returns a different framing for food vs beauty vs travel, so the prompt context is always domain-relevant

### Token Budget Design

Each agent has a `max_tokens` ceiling tuned to its task:
```typescript
// Haiku extraction — structured JSON, no waffle needed
extractWebsiteData:   max_tokens: 512
extractEmailWithHaiku: max_tokens: 64

// Sonnet generation — quality over brevity, but capped
writeOutreachEmail:   max_tokens: 400  // ~80 word email + sign-off
writeOutreachDM:      max_tokens: 200  // 2-3 sentence DM
```

---

## 6. Database Schema

### Entity Relationship Overview

```
categories ──────────────────────────────────────────┐
                                                      │ (optional FK)
settings ────────────────────────────────────────────►│
exhausted_queries ───────────────────────────────────►│
city_suburbs ────────────────────────────────────────►│
                                                      │
leads ────────────────────────────────────────────────┤
  │                                                   │
  ├──► emails ──────────────────────────────────────► follow_ups
  │
  ├──► dm_queue
  │
  ├──► deals
  │
  └──► activity_log
```

### Core Tables

#### `leads` — Central entity, one row per business

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `business_name` | TEXT | From Outscraper |
| `category_name` | TEXT | Denormalised for display |
| `email` | TEXT | Found by Finder/Researcher; user-editable in panel |
| `website` | TEXT | **`website` field, NOT `site`** — confirmed Outscraper field name |
| `instagram_handle` | TEXT | Extracted by Researcher |
| `outreach_channel` | TEXT | `email` / `instagram` / `facebook` |
| `status` | TEXT | 9-state FSM — see state machine diagram |
| `deal_value` | DECIMAL | Set when deal closes |
| `content_created` | BOOLEAN | Deal delivery tracking |
| `payment_received` | BOOLEAN | Deal payment tracking |

#### `emails` — One row per email sent per lead

| Column | Type | Notes |
|--------|------|-------|
| `type` | TEXT | `initial_pitch` / `follow_up_1` / `follow_up_2` |
| `status` | TEXT | `pending_send` / `sent` / `failed` / `bounced` |
| `resend_id` | TEXT | For webhook correlation (reply/bounce detection) |
| `body_html` | TEXT | Full HTML email (formatted by `emailBodyToHtml()`) |
| `body_text` | TEXT | Plain text version (Claude output verbatim) |

#### `activity_log` — Append-only audit trail

Every agent writes here on every significant action. Used by the health check API and the API usage tracker in Settings. Key event types:

```
finder_complete       → outscraper_calls, estimated_cost, efficiency, leads_kept
agent_error           → agent name, error message, full stack trace
cost_guard_triggered  → spend_today, current_run_estimate, limit
email_sent            → lead_id, resend_id, subject
reply_received        → lead_id
lead_found            → category, city, email/handle, source
```

#### `exhausted_queries` — Cost control cache

```sql
CREATE TABLE exhausted_queries (
  query        TEXT PRIMARY KEY,
  city         TEXT NOT NULL,
  category     TEXT NOT NULL,
  exhausted_at TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ DEFAULT now() + INTERVAL '3 days'
);
```

Queries returning ≤1 usable lead are written here. Finder skips any query in this table. Auto-expires after 3 days to allow retry when new businesses appear in the area.

#### `city_suburbs` — Configurable multi-city search areas

```sql
CREATE TABLE city_suburbs (
  id     UUID PRIMARY KEY,
  city   TEXT NOT NULL,    -- 'Sydney', 'Melbourne', etc.
  suburb TEXT NOT NULL,    -- 'Parramatta', 'St Kilda', etc.
  active BOOLEAN DEFAULT true
);
```

Managed via the Settings UI. Finder reads only `active = true` rows for cities listed in the `active_cities` setting. If a city is active but has no suburb rows, the city name itself is searched as a fallback.

---

## 7. Admin Panel

### Pages

| Route | Purpose |
|-------|---------|
| `/dashboard` | Stats overview, revenue chart (Recharts), activity feed, pipeline summary |
| `/dashboard/leads` | Full leads CRM — search, filter by status/city/category, edit email inline, resend email |
| `/dashboard/pipeline` | Kanban board — drag leads through contacted → replied → negotiating → closed |
| `/dashboard/email-log` | All sent emails with status, Resend ID, open/reply timestamps |
| `/dashboard/dm-queue` | Instagram DMs — copy message, mark sent, skip |
| `/dashboard/deals` | Closed deals with revenue tracking and content/payment toggles |
| `/dashboard/settings` | System settings, category management, city/suburb management, danger zone |

### System Health Banner

A real-time health check queries `activity_log` every 5 minutes and surfaces issues as colour-coded banners at the top of every page:

```
🔴 RED    — Agent error in last 24h, Outscraper balance exhausted, pipeline failed
🟡 ORANGE — System paused (system_active = false), no pipeline run in 25+ hours
🟢 none   — All systems healthy
```

### Email Resend from Lead Panel

Any lead with an email address has a **Resend Email** button in the detail panel. This:
1. Calls `POST /api/leads/:id/resend`
2. Re-uses the most recent email draft from `emails` table (preserving original copy/subject)
3. Falls back to generating a fresh email via Claude Sonnet 4.6 if no prior draft exists
4. Sends via Resend, inserts a new `emails` row (`status='sent'`), sets lead to `contacted`

### API Usage Tracker (Settings Page)

Reads `activity_log` for `finder_complete` events and aggregates:
- Today's Outscraper calls and estimated cost
- This week / this month totals
- Average cost per run
- Last 7 days breakdown table

---

## 8. Pipeline Flow

### Sequence Diagram

```
Trigger.dev      Finder          Researcher        Writer           Sender
    │               │                │                │                │
    │─daily-pipeline►│               │                │                │
    │               │─Outscraper──►  │                │                │
    │               │◄─leads(new)──  │                │                │
    │               │                │                │                │
    │               │─status=new────►│                │                │
    │               │                │─fetch homepage─►               │
    │               │                │◄─HTML──────────                │
    │               │                │─Claude Haiku──►(decide action) │
    │               │                │◄─{action:fetch_url}            │
    │               │                │─fetch /contact─►               │
    │               │                │◄─HTML──────────                │
    │               │                │─Claude Haiku──►(extract email) │
    │               │                │◄─{action:found,email:...}      │
    │               │                │─update lead────►               │
    │               │                │  (status=researched)           │
    │               │                │                │                │
    │               │                │─researched─────►│               │
    │               │                │                │─Claude Sonnet──►│
    │               │                │                │◄─{subject,body}│
    │               │                │                │─insert email───►│
    │               │                │                │  pending_send  │
    │               │                │                │────────────────►│
    │               │                │                │                │─Resend API──►
    │               │                │                │                │◄─{id:xxx}────
    │               │                │                │                │─status=contacted
    │◄─complete──────────────────────────────────────────────────────────
```

### Timing

| Step | Typical Duration | Primary Bottleneck |
|------|-----------------|-------------------|
| Finder (30–40 leads) | 8–15 min | Outscraper async job polling (3–4s per poll) |
| Researcher (40 leads) | 5–10 min | Website fetch timeouts (5s each, up to 3 pages) |
| Writer (40 emails) | 3–6 min | Claude Sonnet API calls (~1.5s each) |
| Sender (40 emails) | 1–2 min | Resend API rate limiting |
| **Total** | **17–33 min** | |

---

## 9. Cost Engineering

### Monthly Cost Breakdown

| Service | Usage | Monthly Cost |
|---------|-------|-------------|
| Outscraper | ~80 results/day × 30 × $0.003 | ~$7.20 |
| Claude Sonnet 4.6 (writing) | 30 emails × $0.007 × 30 days | ~$6.30 |
| Claude Haiku 4.5 (extraction) | 30 calls × $0.001 × 30 days | ~$0.90 |
| Resend | 900 emails/month (free tier: 3,000) | **$0** |
| Trigger.dev | ~90 runs/month (free tier: 10,000 tasks) | **$0** |
| Supabase | Free tier (500MB DB, 2GB transfer) | **$0** |
| Vercel | Free tier (Hobby) | **$0** |
| **Total** | | **~$14.40/month** |

### Cost Per Unit

```
Cost per lead discovered:      $14.40 / (30 leads/day × 30 days)  = $0.016
Cost per email sent:           $14.40 / 900 emails/month           = $0.016
Cost to acquire 1 reply:       $0.016 / 10% reply rate             = $0.16
Cost to acquire 1 deal:        $0.16  / 30% close rate             = $0.53
Average deal value:            $300–$500
ROI per deal:                  566x–943x gross return on lead cost
Net ROI (incl. all costs):     56x–94x
```

### Cost Optimisation Techniques Applied

| Technique | Mechanism | Saving |
|-----------|-----------|--------|
| **Progressive batching** | Fetch 10 results at a time, stop when quota met | ~60% vs fetching 50 upfront |
| **Query deduplication** | `seenQueries` Set prevents re-fetching same search within a run | Eliminates duplicate API calls |
| **Exhaustion caching** | 3-day DB cache prevents re-querying depleted searches | Avoids wasted calls on empty areas |
| **Daily cost guard** | Configurable `$DAILY_OUTSCRAPER_LIMIT` halts pipeline if exceeded | Hard budget ceiling |
| **Model routing** | Haiku for extraction, Sonnet for generation | ~$3/month saving vs Sonnet-only |
| **Phase 2 is free** | Instagram leads sourced from existing DB records | $0 Outscraper cost for DM pipeline |
| **Early irrelevance filter** | Keyword blocklist before any web fetch | Avoids fetching websites for visa agents, schools, etc. |

---

## 10. Architecture Decisions

### Decision 1: Finite-State-Machine as Agent Coordinator

Agents communicate exclusively through lead status transitions — no direct calls, queues, or message buses. Each agent has a simple contract: read leads in state X, process them, write leads in state Y.

**Why:** Maximises decoupling. Adding a new agent requires no changes to existing agents — only a new status transition. Failed runs are safely resumable because status is persisted in the DB. The state machine is also the natural representation of a sales pipeline, making the system easier to reason about.

**Implementation:** 9 states — `new → researched → email_ready → contacted → replied → negotiating → closed / dead / dm_queued`

### Decision 2: Agentic Researcher Pattern (not prompt chaining)

The Researcher doesn't follow a fixed fetch sequence. It gives Claude the homepage content and asks what to do next. Claude's response dictates the next action.

**Why it matters:** A fixed script (`fetch homepage → fetch /contact → fetch /about`) fails on non-standard site structures. The agentic approach adapts — if the homepage already has a mailto link, it stops. If it needs to search Google for the email, it does. This is the core insight of agentic patterns applied practically.

**Tradeoff:** Up to 3 LLM calls per lead vs 0 for regex-only. Justified because finding an email is a prerequisite for the entire email pipeline — the cost of a missed email is higher than the cost of 3 Haiku calls (~$0.003).

### Decision 3: Haiku-vs-Sonnet Model Routing

The system uses two Claude models deliberately: Haiku 4.5 for extraction/reasoning tasks, Sonnet 4.6 for generation tasks.

**Why:** The quality of extraction output (is this email valid? is this the contact page?) is largely binary — Haiku is sufficient. The quality of email generation is a continuous variable that directly affects reply rate, and reply rate drives revenue. Sonnet's superior writing quality is the right investment for the conversion step.

**Pattern name:** Task-appropriate model routing — a standard LLM application design pattern.

### Decision 4: Cost-Aware Progressive Fetching

The system fetches 10 results, processes them immediately, and only fetches more if needed — rather than fetching the maximum upfront.

**Why:** Most searches in dense categories are exhausted after 10–30 results (all leads already in DB, or none have emails). Fetching 50 upfront wastes money on results that will never be used. Combined with the exhaustion cache, this reduces Outscraper spend by ~80%.

### Decision 5: Two-Phase Lead Discovery

Phase 1 (Outscraper) targets categories with high email yield. Phase 2 (free) queues Instagram targets from Phase 1 leftovers.

**Why:** Instagram-centric businesses (restaurants, nail salons) rarely have emails on their websites — fetching them via Outscraper to find no email is pure waste. Phase 2 gets these leads for free by reusing Phase 1 data.

---

## 11. Tech Stack Decisions

| Technology | Role | Why Chosen | Alternative Considered |
|------------|------|-----------|----------------------|
| **Next.js 16** | Admin dashboard + API routes | Full-stack, Vercel-native, App Router, async params in route handlers | Remix (smaller ecosystem) |
| **Supabase** | Database + Auth + Realtime | Managed Postgres, RLS, generous free tier, Realtime subscriptions | PlanetScale (removed free tier 2024) |
| **Claude AI** | Email writing + extraction | Best personalisation quality; Haiku is cheapest capable model for extraction | GPT-4o (higher cost, comparable quality) |
| **Resend** | Email delivery | Best deliverability for cold outreach, clean API, webhook support, free tier covers volume | SendGrid (complex legacy API) |
| **Trigger.dev v3** | Job scheduling + long-running tasks | No 60s timeout (unlike Vercel functions), live log streaming, free tier | GitHub Actions (no live logging, worse DX) |
| **Outscraper** | Business discovery | Only API returning real Google Maps data with phone, website, email fields | Google Places API (4.7x more expensive, fewer fields) |
| **Vercel** | Hosting | Zero-config Next.js deployment, edge functions, free hobby tier | Cloudflare Pages (more complex for Next.js App Router) |

---

## 12. Deployment

### Prerequisites

```bash
# Six services required (all have free tiers):
# 1. supabase.com       — database + auth
# 2. resend.com         — email delivery
# 3. outscraper.com     — business data (~$10 credit to start)
# 4. console.anthropic.com — AI (Claude API)
# 5. trigger.dev        — job scheduling
# 6. vercel.com         — hosting
```

### Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh...
SUPABASE_SERVICE_ROLE_KEY=eyJh...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Resend
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...

# Outscraper
OUTSCRAPER_API_KEY=...

# Trigger.dev (must use tr_prod_ key for production)
TRIGGER_SECRET_KEY=tr_prod_...

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
ADMIN_EMAIL=your@email.com
```

### Database Setup

```bash
# Run migrations in order in Supabase SQL Editor:
supabase/migrations/001_initial_schema.sql      # All core tables + seeds
supabase/migrations/002_add_dm_limit.sql        # DM limit setting
supabase/migrations/003_add_dm_queued_status.sql
supabase/migrations/004_city_suburbs.sql        # City/suburb management
supabase/migrations/005_exhausted_queries.sql   # Cost control cache
```

### Deploy

```bash
# 1. Push to GitHub → Vercel auto-deploys the Next.js app
git push

# 2. Deploy Trigger.dev jobs — MUST do this separately after any agent code change
npm run deploy:trigger
# equivalent: npx trigger.dev@4.4.4 deploy

# 3. Verify schedules in Trigger.dev dashboard
# Expect: daily-pipeline (8pm AEST), followup-job (9am), digest-job (8am)
```

**Important:** Every time agent code changes, you **must** run `npm run deploy:trigger` separately. Vercel only deploys the Next.js app — Trigger.dev jobs run on separate cloud infrastructure and must be deployed independently.

---

## 13. Testing

All test scripts live in `/scripts/`, load `.env.local` automatically, and **never write to the database** (read-only + console output only).

| Script | Purpose | Key Finding |
|--------|---------|-------------|
| `test-email-extract.ts` | Test email extraction on a specific URL | Diagnosed 6000-char truncation bug; switched to full HTML scan |
| `test-one-business.ts` | Full Outscraper → fetch → extract on one business | Discovered `website` vs `site` field name discrepancy in Outscraper response |
| `test-hotel-emails.ts` | Email yield test for hotel category | 2/10 yield; large chains block bots (403); boutique hotels significantly better |
| `test-travel-emails.ts` | Email yield test for travel agents | 7/10 yield; confirmed mailto: link approach catches emails that HTML regex misses |
| `test-followup.ts` | Send test follow-up to owner email | Verifies follow-up template and Resend delivery pipeline |
| `test-outscraper-fields.ts` | Log complete raw Outscraper response | Revealed `website` field name, confirmed no native Instagram field returned |

```bash
# Run any test:
npx tsx scripts/test-travel-emails.ts
```

---

## 14. Future Roadmap

### Self-Improving Email Quality via RAG

Store reply rates and deal close rates per email variant. Use **retrieval-augmented generation** to inject the 3 highest-performing past emails as few-shot examples into the Writer prompt at inference time. Expected improvement: +15–25% reply rate.

Implementation sketch:
```typescript
// Retrieve top-performing emails for this category
const topEmails = await supabase
  .from('emails')
  .select('body_text, reply_received, deal_closed')
  .eq('category', lead.category_name)
  .eq('reply_received', true)
  .order('deal_closed', { ascending: false })
  .limit(3)

// Inject as few-shot examples into Writer prompt
const fewShotBlock = topEmails.map(e => `Example (converted):\n${e.body_text}`).join('\n\n')
```

### Reply Intelligence

Extend Resend webhooks to pass reply content through Claude for sentiment classification:
- `interested` → auto-move to `negotiating`, send deal package
- `not_interested` → mark dead, suppress all follow-ups
- `wrong_person` → extract correct contact name from reply text, update lead

### Lead Scoring Model

Compute a composite score per lead based on:
- Google rating and review count (quality signal)
- Website presence and richness (establishment signal)
- Business age and social following (authority signal)
- Category-specific engagement indicators

Prioritise high-score leads in the Writer queue to maximise ROI on Claude API spend.

### Multi-Creator SaaS

Extract creator-specific configuration (brand name, voice, categories, target cities) into a `tenants` table. One deployment serves multiple creators with isolated pipelines, independent settings, and per-tenant billing.

```
Tenant: Creator A (food niche, Sydney) → own categories, own pipeline, own CRM
Tenant: Creator B (travel niche, Melbourne) → own categories, own pipeline, own CRM
```

Estimated ARR potential: $500–$2,000/month per creator at $49–$199/month pricing. The core agent orchestration, CRM, and cost controls are already niche-agnostic — adapting for a new creator requires only updating `EMAIL_CATEGORIES`, the Claude prompt system context, and the `active_cities` setting.

---

## 15. Troubleshooting

### Pipeline didn't run

1. Trigger.dev → Runs → look for today's `daily-pipeline`
2. If missing: check Schedules page — verify `daily-pipeline` schedule points to correct task ID
3. If failed: click run → view logs → find first red error line
4. Check `system_active` setting in dashboard Settings — must be `true`

### No emails sent

1. Dashboard → Email Log → filter `pending_send` — any queued?
2. If none: Writer didn't produce emails. Check Trigger.dev logs for "No researched leads found"
3. If queued but not sent: Sender failed. Check for Resend API errors in Trigger.dev logs
4. Verify `RESEND_API_KEY` is set in Vercel environment variables

### Outscraper returning 401 / 402

```
Check balance at: outscraper.com → Profile → Billing
Minimum $10 top-up recommended.
At ~$0.003/result and ~80 results/day = $7.20/month consumption rate.
```

### Same query searched repeatedly

The `seenQueries` Set is checked before every Outscraper call. If duplicate queries appear in logs, check that the Set is initialised outside the category loop (it must persist across all categories). Also check `city_suburbs` table for duplicate rows — if the same suburb appears twice for the same city, the Set will catch the second occurrence but the loop will still iterate it.

### Email extracted incorrectly (e.g. `thello@` instead of `hello@`)

This happens when regex captures characters from surrounding HTML text. The `mailto:` link extraction approach (`href="mailto:..."`) prevents this — it is tried first and is 100% accurate. Regex is only a fallback.

To fix an already-stored bad email:
1. Dashboard → Leads → find the lead
2. Click lead → pencil icon next to email → correct the address
3. Click "Resend Email" button — sends to the corrected address, logs a new row in `emails`

### How to check Trigger.dev run logs

```
cloud.trigger.dev → your project → Runs → click run ID → expand each step
```

---

## 16. Portfolio Notes

### Why This Project Demonstrates Production Engineering Skills

Most AI demo projects are toy pipelines that break at scale. This system is production-deployed, handles real data, and has been engineered to control costs, handle failures gracefully, and produce consistent output quality. Specific things that distinguish it from demo-quality work:

- **Rate limiting** on both Outscraper and Claude APIs (sliding window, auto-backoff)
- **Idempotent agent runs** — re-running any agent produces the same result, not duplicates
- **Fault isolation** — a Researcher failure on one lead logs and continues, not crash-and-burn
- **Cost engineering** documented with real spend figures, not just "I optimised it"
- **Observability** — every agent action is logged with structured metadata, enabling post-hoc debugging
- **State machine** over implicit control flow — the lead lifecycle is explicit, not buried in business logic

### Adapting for a Different Use Case

The architecture is niche-agnostic. To adapt:

1. **`agents/finder.ts`** — update `EMAIL_CATEGORIES` and `DM_CATEGORY_NAMES` with relevant search queries
2. **`agents/writer.ts`** — update the Claude prompt system context with your brand voice and proposition
3. **`lib/claude.ts`** — update `getBrandDescription()` and `getCategoryPitch()` for your verticals
4. **Environment variables** — set `ADMIN_EMAIL` and `NEXT_PUBLIC_APP_URL`
5. **`settings` table** — configure daily limits, follow-up cadence, active cities
6. Deploy — pipeline runs autonomously from that point

The system has been tested across: food & lifestyle, travel, and beauty verticals. Core agent orchestration, CRM, and cost controls apply equally to any outreach-driven business.

---

*Documentation version 3.0 | Built May 2026 | Stack: Next.js 16 · TypeScript · Supabase · Claude Sonnet 4.6 + Haiku 4.5 · Trigger.dev v3 · Vercel · Outscraper · Resend*
