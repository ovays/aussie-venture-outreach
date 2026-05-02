# Aussie Venture Outreach System — Full Documentation

> Last updated: May 2026  
> Built by: Owais Ahmed (ovays)  
> Stack: Next.js 16, Supabase, Claude AI, Resend, Trigger.dev, Outscraper

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [The 6 Agents](#3-the-6-agents)
4. [Two-Phase Finder Logic](#4-two-phase-finder-logic)
5. [Database Schema](#5-database-schema)
6. [Admin Panel Pages](#6-admin-panel-pages)
7. [Pipeline Flow](#7-pipeline-flow)
8. [Settings Explained](#8-settings-explained)
9. [Tech Stack](#9-tech-stack)
10. [Deployment](#10-deployment)
11. [Testing](#11-testing)
12. [Costs](#12-costs)
13. [Future Improvements](#13-future-improvements)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Project Overview

### What Is Aussie Venture Outreach?

Aussie Venture is a content/media brand (Instagram/YouTube) that creates travel, food, and lifestyle content targeting the Australian Muslim community. The outreach system is a **fully automated B2B lead generation and email outreach pipeline** that finds local Sydney businesses, contacts them with a personalised collab pitch, and tracks responses through to closed deals.

### What Problem Does It Solve?

Manually finding businesses to collab with, researching their contact details, writing personalised emails, following up, and tracking responses is extremely time-consuming. This system does all of that autonomously every day at 8am with zero manual input required.

### How It Makes Money for Owais

The pipeline finds businesses in categories that align with the Aussie Venture audience (halal restaurants, travel agents, hotels, beauty studios, etc.) and pitches one of three deal types:

| Deal Type | Description | Typical Value |
|-----------|-------------|---------------|
| `visit_content` | Owais visits the business in-person, creates content (reel/photo), posts to Aussie Venture audience | $200–$800 |
| `remote_sponsored` | Business pays for a sponsored mention/story without requiring a visit | $150–$500 |
| `remote_content` | Owais creates content remotely using their assets/information | $100–$400 |

The system targets ~30 email leads per day. At a ~10% reply rate and ~30% close rate from replies, that's roughly **1 deal closed per day** from the pipeline alone.

---

## 2. System Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRIGGER.DEV CRON JOBS                        │
│                                                                     │
│  8:00 AM  ─── digest-job ──────────► sendDailyDigest()             │
│  9:00 AM  ─── followup-job ────────► runFollowUpAgent()            │
│  8:00 PM  ─── daily-pipeline ─────► Finder→Researcher→Writer→Sender│
└─────────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   DAILY PIPELINE      │
                    │                       │
                    │  1. runFinderAgent()  │
                    │         │             │
                    │         ▼             │
                    │  2. runResearcherAgent│
                    │         │             │
                    │         ▼             │
                    │  3. runWriterAgent()  │
                    │         │             │
                    │         ▼             │
                    │  4. runSenderAgent()  │
                    └───────────────────────┘

┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│   OUTSCRAPER   │     │   SUPABASE     │     │   RESEND       │
│ Google Maps    │────►│ Postgres DB    │────►│ Email sending  │
│ Business data  │     │ + Storage      │     │ + webhooks     │
└────────────────┘     └────────────────┘     └────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   CLAUDE (Anthropic) │
                    │ Haiku: extraction   │
                    │ Sonnet: writing     │
                    └─────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   NEXT.JS DASHBOARD │
                    │ Vercel-hosted admin │
                    │ panel for Owais     │
                    └─────────────────────┘
```

### Lead Lifecycle (Status Flow)

```
Outscraper API
      │
      ▼
   [new]  ──────────────────────────────────────────────► [dead]
      │                                                  (no email/IG found)
      ▼
[researched]  ──────────────────────────────────────────► [dead]
      │                                               (no contact at all)
      ├──► (has email) ──► [email_ready] ──► [contacted]
      │                                           │
      │                                           ├──► [replied]
      │                                           │        │
      │                                           │        ▼
      │                                           │  [negotiating]
      │                                           │        │
      │                                           │        ▼
      │                                           │   [closed] ──► Deal created
      │                                           │
      │                                           └──► [dead] (21 days no reply)
      │
      └──► (has instagram only) ──► [dm_queued]
```

### Tech Stack and Why

| Technology | Role | Why Chosen |
|------------|------|-----------|
| Next.js 16 | Admin dashboard + API routes | Full-stack React framework, Vercel native |
| Supabase | Database + Auth | Postgres with RLS, instant REST API, free tier generous |
| Claude AI | Email writing + data extraction | Best-in-class personalization, Haiku is cheap for extraction |
| Resend | Email delivery | Best deliverability for cold outreach, webhook support, $0 at low volume |
| Trigger.dev | Cron job scheduling | Long-running task support (up to 1 hour), no serverless timeout limits |
| Outscraper | Business discovery | Google Maps scraping with contact details, $0.002/result |
| Vercel | Hosting | Zero-config Next.js deployment, automatic HTTPS |

---

## 3. The 6 Agents

### Agent 1: Finder (`agents/finder.ts`)

**What it does:** Discovers new business leads using the Outscraper Google Maps API.

**When it runs:** Daily at 8:00 PM Sydney time (step 1 of daily pipeline).

**Inputs:** Settings from database (`daily_email_limit`, `daily_dm_limit`, `daily_lead_limit`).

**Outputs:** New rows in the `leads` table with `status = 'new'`. Returns total leads found as integer.

**Two-phase operation:**

- **Phase 1** — Searches 7 categories to find email leads. First 4 categories are capped at `floor(EMAIL_TARGET / 4)` each to ensure variety. Remaining 3 fill leftover quota.
- **Phase 2** — Searches 4 halal/nail categories specifically for Instagram handles.

**Key logic:**
- Decodes percent-encoded URLs (`decodeURIComponent`) before fetching
- Checks `mailto:` links in HTML before falling back to regex (higher confidence)
- Runs regex on **full raw HTML** — not stripped text — because emails often live in `<script>` JSON-LD blocks
- Fetches up to 3 pages per business: homepage → `/contact` → `/contact-us` → `/about` → `/about-us` (stops after finding email or after 3 fetches)
- Filters irrelevant businesses by name (visa agents, schools, medical clinics, etc.)
- Filters junk emails (tracking IDs like `bg0i@`, system addresses, locals < 4 chars)
- Deduplicates against DB by `(business_name + city)` OR `phone`

**Important code decisions:**
- Categories are hardcoded (not from DB) because the DB categories table uses `{suburb}` template patterns from the old suburb-rotation system, while finder now searches by city only
- `phase1Names` Set tracks Phase 1 saves to skip in Phase 2 without a DB query

---

### Agent 2: Researcher (`agents/researcher.ts`)

**What it does:** Enriches `new` leads with website data using Claude Haiku and an agentic multi-page search strategy.

**When it runs:** Daily at 8:00 PM Sydney time (step 2 of daily pipeline, immediately after Finder).

**Inputs:** All leads with `status = 'new'` from the database.

**Outputs:** Leads updated to `status = 'researched'` with enriched fields: `description`, `services`, `instagram_handle`, `facebook_url`. May also update `email` if found.

**Key logic:**
1. Fetches raw HTML from the business website
2. Passes homepage content to `agenticEmailSearch()` — a multi-turn Claude Haiku agent that searches: homepage → `/contact` page → DuckDuckGo web search (up to 3 rounds)
3. Also calls `extractWebsiteData()` to extract description, services, and social handles
4. If no Instagram found, generates a best-guess handle from the business name (lowercase, alphanumeric only) as a fallback

**Note on pipeline interaction:** The Researcher is designed to handle leads that the Finder may have saved without an email (e.g., it found a website but timed out). However with the current Finder logic, leads are only saved if an email OR Instagram handle was already found, so the Researcher primarily serves as an enrichment/verification layer.

---

### Agent 3: Writer (`agents/writer.ts`)

**What it does:** Generates personalised outreach content for `researched` leads using Claude Sonnet.

**When it runs:** Daily at 8:00 PM Sydney time (step 3 of daily pipeline).

**Inputs:** All leads with `status = 'researched'`.

**Outputs:**
- For email leads: new row in `emails` table with `status = 'pending_send'`, lead updated to `email_ready`
- For Instagram-only leads: new row in `dm_queue` table with `status = 'pending'`, lead updated to `dm_queued`
- Leads with no email and no Instagram: updated to `status = 'dead'`

**Content type decision:**
```
Sydney business + VISIT_ELIGIBLE category → content_type = 'visit'
(Halal Restaurants, Cafes, Bakeries, Nail Salons, Hair Salons, Beauty Studios, Spas, Hotels)

Everything else → content_type = 'remote'
```

**Key logic:**
- Resets stale `email_ready` leads (those that have no `pending_send` email) back to `researched` at the start — prevents leads getting stuck
- Respects `daily_dm_limit` setting; stops queuing DMs once limit reached for the day
- Calls `writeOutreachEmail()` (Claude Sonnet) with business details, category, content type, description, services
- Calls `writeOutreachDM()` (Claude Sonnet) for Instagram-only leads

---

### Agent 4: Sender (`agents/sender.ts`)

**What it does:** Sends queued emails via Resend API.

**When it runs:** Daily at 8:00 PM Sydney time (step 4 of daily pipeline, last step).

**Inputs:** All `emails` rows with `status = 'pending_send'`, up to `daily_email_limit`.

**Outputs:**
- Successfully sent: email row updated to `status = 'sent'` with `resend_id` and `sent_at`, lead updated to `status = 'contacted'`
- Failed: email row updated to `status = 'failed'`

**Key logic:**
- Logs 4 diagnostic counts at startup: pending_send emails, email_ready leads, email_ready with real email
- Joins `emails` with `leads` to get the `to` address — doesn't store email on the email row itself
- Skips sending and marks failed if lead has no email address
- From address: `Owais | Aussie Venture <hello@aussieventure.com>`

---

### Agent 5: Follow-up (`agents/followup.ts`)

**What it does:** Sends timed follow-up emails to `contacted` leads and marks stale leads as dead.

**When it runs:** Daily at 9:00 AM Sydney time (separate cron, `followup-job`).

**Inputs:** All leads with `status = 'contacted'`, timing settings from DB.

**Outputs:**
- Follow-up 1 sent (day 7): new `emails` row, new `follow_ups` row, lead stays `contacted`
- Follow-up 2 sent (day 14): same as above with type `follow_up_2`
- Marked dead (day 21): lead updated to `status = 'dead'`

**Follow-up timing:**
```
Day 0:  Initial pitch sent            (status = 'contacted')
Day 7:  Follow-up 1 sent              "Bumping this in case my last email got buried..."
Day 14: Follow-up 2 sent              "Last message from me on this one..."
Day 21: Lead marked dead              No further outreach
```

**Key logic:**
- Calculates `daysSince` from `initial_pitch.sent_at` timestamp
- Checks `hasFollowUp1` and `hasFollowUp2` flags on the emails list to prevent duplicate follow-ups
- Processes dead-lead check before follow-up check (priority order: dead → FU2 → FU1)
- Follow-up subject is always `Re: {original subject}` for threading

---

### Agent 6: Tracker (`agents/tracker.ts`)

**What it does:** Three separate functions — handles email events and sends a daily digest.

**Functions:**

#### `handleEmailReply(leadId)`
- Called from Resend webhook at `/api/webhooks/resend` when a reply is detected
- Updates lead to `status = 'replied'`
- Updates `replied_at` on the initial pitch email row
- Logs `reply_received` activity event

#### `handleEmailBounce(leadId, emailId)`
- Called from Resend webhook when an email bounces
- Updates email row to `status = 'bounced'`
- Logs `email_bounced` event

#### `sendDailyDigest()`
- Runs daily at 8:00 AM Sydney time (separate `digest-job` cron)
- Compiles stats from last 24 hours: initial emails sent, follow-ups sent, new replies, deals closed this week
- Sends a formatted HTML + plain-text summary email to `digest_email` setting (default: `hello@aussieventure.com`)
- Uses `leadId: 'digest'` to skip the Resend lead tracking tag

---

## 4. Two-Phase Finder Logic

### Phase 1 — Email Leads

**Categories searched (in order):**

| Priority | Category | Query | Cap |
|----------|----------|-------|-----|
| 1 | Travel Agents | `travel agent Sydney` | `EMAIL_TARGET / 4` |
| 2 | Tour Operators | `tour operator Sydney` | `EMAIL_TARGET / 4` |
| 3 | Boutique Hotels | `boutique hotel Sydney` | `EMAIL_TARGET / 4` |
| 4 | Beauty / Lash Studios | `beauty studio Sydney` | `EMAIL_TARGET / 4` |
| 5 | Hair Salons | `hair salon Sydney` | Remaining quota |
| 6 | Spas / Massage Studios | `day spa Sydney` | Remaining quota |
| 7 | Halal Restaurants | `halal restaurant Sydney` | Remaining quota |

**Per-business processing flow:**

```
For each Outscraper result:
  1. isIrrelevant(name)?  → skip
  2. isAlreadyInDB()?     → skip
  3. website is Instagram URL? → note for Phase 2, skip
  4. result.email valid?  → use it (source: outscraper)
  5. else, findEmailForBusiness(website):
       a. Fetch homepage  (fetch 1) → check mailto: links, then regex
       b. Fetch /contact  (fetch 2) → same checks
       c. Fetch /contact-us (fetch 3, if /contact failed)
       d. Fetch /about    (fetch 3 or 4) — max 3 fetches total
       e. Fetch /about-us — max 3 fetches total
  6. email found + valid? → save lead (status=new, channel=email)
  7. no email found?      → skip
```

**Quota distribution with `EMAIL_TARGET = 40`:**
- Travel Agents: max 10
- Tour Operators: max 10
- Boutique Hotels: max 10
- Beauty Studios: max 10
- Hair Salons: max remaining (up to 0 if first 4 filled)
- etc.

This ensures daily variety — you never get 40 travel agents in a row.

### Phase 2 — Instagram Leads

Only runs after Phase 1 completes.

**Categories searched:**
1. `halal restaurant Sydney`
2. `halal cafe Sydney`
3. `halal bakery Sydney`
4. `nail salon Sydney`

**Per-business processing flow:**
```
For each Outscraper result:
  1. phase1Names.has(name)? → skip (already saved this run)
  2. isAlreadyInDB()?       → skip
  3. Check Outscraper fields: instagram, instagram_handle, social_media
  4. Check if website field is an instagram.com URL → extract handle
  5. Handle found? → save lead (status=new, channel=instagram)
  6. No handle?    → skip
```

### Duplicate Prevention

```typescript
// Supabase .or() query:
conditions = ['and(business_name.eq.{name},city.eq.Sydney)']
if (phone) conditions.push('phone.eq.{phone}')
// → Rejects if: (name matches in same city) OR (phone matches anywhere)
```

### Email Extraction Strategy

**Priority order:**
1. `mailto:` links — highest confidence, extracted with: `href=["']mailto:({email})`
2. Full HTML regex scan — `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`

**Why full HTML (not stripped):**  
Many businesses embed their email in `<script type="application/ld+json">` structured data blocks. Stripping HTML tags before running regex removes the tag wrappers but keeps the JSON content — however a `slice(0, 6000)` limit on stripped text was cutting off content. Running on full raw HTML removes this risk entirely.

### Junk Email Filter

```typescript
function isValidEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0]

  // Blocked system addresses
  const BLOCKED = ['noreply','donotreply','no-reply','wordpress',
                   'postmaster','webmaster','bounce','mailer']
  if (BLOCKED.has(local)) return false

  // Too short
  if (local.length < 4) return false

  // Image/asset false positives
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false
  if (email.includes('@2x')) return false

  // No vowels + no separators = tracking ID (bg0i, ey6i, da7i)
  const hasVowel = /[aeiou]/.test(local)
  const hasSeparator = /[._]/.test(local)
  if (!hasVowel && !hasSeparator) return false

  // Short alphanumeric + digit = generated tracking ID (bg0i has 'i' vowel but digit '0')
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false

  return true
}
```

**Why the digit + short pattern rule:**  
Flight Centre embeds tracking IDs like `bg0i@flightcentre.com`, `ey6i@flightcentre.com` in their HTML. These pass the vowel check (`i` is a vowel) but are clearly not real addresses. Adding a check for "short alphanumeric AND contains a digit" catches these while keeping `info@`, `admin@`, `sales1team@` etc.

---

## 5. Database Schema

### Table: `leads`

The central table. One row per business.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `business_name` | TEXT | Google Maps business name |
| `category_id` | UUID | FK to categories (nullable — finder uses category_name directly) |
| `category_name` | TEXT | Denormalized category name for easy display |
| `halal` | BOOLEAN | Whether business is halal |
| `address` | TEXT | Full street address from Outscraper |
| `suburb` | TEXT | Suburb (from old suburb-rotation system, often null) |
| `city` | TEXT | City (always 'Sydney' currently) |
| `state` | TEXT | State (always 'NSW' currently) |
| `phone` | TEXT | Phone number (used for dedup) |
| `email` | TEXT | Contact email found by Finder/Researcher |
| `website` | TEXT | Business website URL |
| `instagram_handle` | TEXT | Instagram handle (e.g. `@business`) |
| `facebook_url` | TEXT | Facebook page URL |
| `google_rating` | DECIMAL | Google Maps star rating |
| `google_reviews_count` | INTEGER | Number of Google reviews |
| `description` | TEXT | Business description (extracted by Researcher) |
| `services` | TEXT | Services list (extracted by Researcher) |
| `outreach_channel` | TEXT | `email` / `instagram` / `facebook` |
| `status` | TEXT | See status flow above |
| `deal_value` | DECIMAL | Value of closed deal |
| `deal_type` | TEXT | `visit_content` / `remote_sponsored` / `remote_content` |
| `content_created` | BOOLEAN | Whether content has been created for deal |
| `payment_received` | BOOLEAN | Whether payment has been received |
| `notes` | TEXT | Manual notes |
| `created_at` | TIMESTAMPTZ | When lead was found |
| `updated_at` | TIMESTAMPTZ | Auto-updated by trigger |

**Status values and meaning:**
```
new          → Just found by Finder, not yet enriched
researched   → Enriched by Researcher, awaiting email write
email_ready  → Email written and queued in emails table
contacted    → Initial pitch email sent
replied      → Business replied to email
negotiating  → In conversation, deal not yet closed
closed       → Deal agreed and recorded in deals table
dead         → No response after 21 days, or no contact info found
dm_queued    → Instagram/Facebook DM written and queued
```

### Table: `emails`

One row per email sent or queued per lead.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `lead_id` | UUID | FK to leads (CASCADE delete) |
| `type` | TEXT | `initial_pitch` / `follow_up_1` / `follow_up_2` |
| `subject` | TEXT | Email subject line |
| `body_html` | TEXT | HTML version of email body |
| `body_text` | TEXT | Plain text version |
| `resend_id` | TEXT | Resend message ID (for tracking) |
| `status` | TEXT | `pending_send` / `sent` / `failed` / `bounced` |
| `sent_at` | TIMESTAMPTZ | When Resend confirmed delivery |
| `opened_at` | TIMESTAMPTZ | When recipient opened (from Resend webhook) |
| `replied_at` | TIMESTAMPTZ | When recipient replied (from Resend webhook) |

### Table: `dm_queue`

Manual DM outreach queue — Owais sends these manually via Instagram/Facebook.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `lead_id` | UUID | FK to leads |
| `platform` | TEXT | `instagram` / `facebook` |
| `handle` | TEXT | The @handle or URL to DM |
| `profile_url` | TEXT | Facebook profile URL if applicable |
| `message_text` | TEXT | Generated DM message text |
| `status` | TEXT | `pending` / `sent` / `skipped` |
| `sent_at` | TIMESTAMPTZ | When Owais marks as sent |

### Table: `follow_ups`

Tracks follow-up email history.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `lead_id` | UUID | FK to leads |
| `follow_up_number` | INTEGER | 1 or 2 |
| `scheduled_at` | TIMESTAMPTZ | When it was scheduled |
| `sent_at` | TIMESTAMPTZ | When it was actually sent |
| `email_id` | UUID | FK to the emails row created |
| `status` | TEXT | `scheduled` / `sent` / `cancelled` |

### Table: `deals`

Closed deals for revenue tracking.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `lead_id` | UUID | FK to leads |
| `deal_value` | DECIMAL | AUD value of the deal |
| `deal_type` | TEXT | `visit_content` / `remote_sponsored` / `remote_content` |
| `content_created` | BOOLEAN | Content delivery status |
| `payment_received` | BOOLEAN | Payment received status |
| `notes` | TEXT | Deal notes |
| `closed_at` | TIMESTAMPTZ | When deal was recorded |

### Table: `activity_log`

Append-only audit log of all system events.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `event_type` | TEXT | Event identifier (see below) |
| `lead_id` | UUID | Associated lead (nullable) |
| `description` | TEXT | Human-readable event description |
| `metadata` | JSONB | Structured event data |
| `created_at` | TIMESTAMPTZ | Event timestamp |

**Event types used:**
`lead_found`, `lead_researched`, `outreach_written`, `email_sent`, `email_failed`, `sender_error`, `sender_complete`, `reply_received`, `email_bounced`, `follow_up_1_sent`, `follow_up_2_sent`, `lead_marked_dead`, `followup_complete`, `finder_complete`, `researcher_complete`, `writer_complete`, `digest_sent`, `lead_dead`

### Table: `settings`

Key-value configuration store.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `key` | TEXT | Setting name (unique) |
| `value` | TEXT | Setting value (always string) |
| `description` | TEXT | Human-readable description |
| `updated_at` | TIMESTAMPTZ | Last modified |

### Table: `categories`

Business category definitions (legacy from suburb-rotation system; Finder now uses hardcoded categories).

| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT | Category display name |
| `halal_filter` | BOOLEAN | Whether to filter for halal businesses |
| `cities` | TEXT | `sydney_only` / `all` / `custom` |
| `content_type` | TEXT | `visit` / `remote` / `both` |
| `search_keywords` | TEXT[] | Search query templates (use `{suburb}` and `{city}`) |
| `status` | TEXT | `active` / `paused` |

### Table Relationships

```
categories ──┐
             │ (optional FK)
leads ───────┤──────────────────────────────┐
             │                              │
             ├──► emails                   │
             │       └──► follow_ups ──────┘
             │
             ├──► dm_queue
             │
             ├──► deals
             │
             └──► activity_log
```

---

## 6. Admin Panel Pages

### `/dashboard` — Main Overview

**Stat cards (top row):**
- Total Leads Found (all time count from leads table)
- Emails Sent This Week (sent emails in last 7 days)
- Reply Rate (replied leads / contacted leads, as %)
- Total Revenue (sum of all closed deal values)

**Pipeline summary:** Count of leads at each status (new, researched, email_ready, contacted, replied, negotiating, closed, dead, dm_queued)

**Weekly revenue chart:** Recharts bar chart showing deal revenue for each of the last 12 weeks

**Recent activity feed:** Latest 20 entries from activity_log with timestamps

**Quick stats row:**
- Emails sent today
- Pending follow-ups (contacted leads with no follow-up yet, older than 7 days)
- DMs in queue
- Deals closed this month

---

### `/dashboard/leads` — Leads Table

Full table of all leads with:
- Filter by status (dropdown)
- Filter by category, city, or text search
- Columns: Business Name, Category, City, Email, Status, Channel, Rating, Created date
- Click a row to view full lead details and notes
- Pagination (server-side)

---

### `/dashboard/pipeline` — Kanban Board

Visual kanban view showing leads grouped by status columns:
- Columns: contacted, replied, negotiating, closed
- (new/researched/email_ready excluded — they're pre-pipeline)
- Drag-and-drop to move leads between statuses
- Each card shows business name, category, email

---

### `/dashboard/settings` — Settings & Categories

**System settings panel:**
- System Active toggle (master on/off)
- Daily Lead Limit (number input)
- Daily Email Limit (number input)
- Daily DM Limit (number input)
- Follow-up 1 Days (default: 7)
- Follow-up 2 Days (default: 14)
- Dead Lead Days (default: 21)
- Digest Email address

**Categories table:**
- List of all category rows from DB
- Name, status (active/paused), content type, cities filter
- Toggle active/paused per category

---

### `/dashboard/email-log` — Email History

Table showing all sent emails:
- Columns: Business Name, Subject, Type (initial/FU1/FU2), Status, Sent At, Opened At, Replied At
- Filter by type or status
- Shows Resend ID for debugging

---

### `/dashboard/dm-queue` — DM Queue

Table of all pending/sent/skipped DMs:
- Columns: Business Name, Platform, Handle, Message preview, Status, Created, Sent At
- Filter by platform (Instagram/Facebook) or status
- Owais manually sends each DM, then marks as sent in this table
- Shows the generated message text in full

---

### `/dashboard/deals` — Deals

Table of all closed deals:
- Columns: Business Name, Deal Type, Value, Content Created, Payment Received, Closed At, Notes
- Revenue summary at top
- Toggle content_created and payment_received checkboxes inline

---

## 7. Pipeline Flow

### Daily Pipeline (8:00 PM Sydney time)

```
8:00 PM   Trigger.dev fires daily-pipeline-schedule
          → triggers daily-pipeline task (maxDuration: 3600s)

Step 1: runFinderAgent()
  ├── Read settings: EMAIL_TARGET, DM_TARGET, TOTAL_TARGET
  ├── Calculate cappedLimit = floor(EMAIL_TARGET / 4)
  ├── PHASE 1: Loop 7 email categories
  │   ├── Outscraper search (limit=50) → ~$0.10 per call
  │   ├── For each result:
  │   │   ├── Check irrelevant keywords
  │   │   ├── Check DB dedup (name+city OR phone)
  │   │   ├── Check Outscraper email field
  │   │   ├── If website: decode URL, fetch up to 3 pages
  │   │   └── Save if email found (status=new, channel=email)
  │   └── Break when categoryEmailCount >= cappedLimit
  └── PHASE 2: Loop 4 DM categories
      ├── Outscraper search (limit=50)
      ├── For each result:
      │   ├── Skip if in phase1Names
      │   ├── Check DB dedup
      │   ├── Check Instagram fields + website URL
      │   └── Save if handle found (status=new, channel=instagram)
      └── Break when dmCount >= DM_TARGET

Step 2: runResearcherAgent()
  ├── Find all leads with status=new
  ├── For each lead with a website:
  │   ├── Fetch raw HTML
  │   ├── agenticEmailSearch() [Claude Haiku, up to 3 rounds]
  │   └── extractWebsiteData() [Claude Haiku]
  └── Update all to status=researched

Step 3: runWriterAgent()
  ├── Reset stale email_ready leads → researched
  ├── Find all leads with status=researched
  ├── For email leads:
  │   ├── writeOutreachEmail() [Claude Sonnet]
  │   ├── Insert into emails (status=pending_send)
  │   └── Update lead to email_ready
  └── For Instagram leads:
      ├── writeOutreachDM() [Claude Sonnet]
      ├── Insert into dm_queue (status=pending)
      └── Update lead to dm_queued

Step 4: runSenderAgent()
  ├── Read daily_email_limit
  ├── Fetch emails with status=pending_send (up to limit)
  ├── For each email:
  │   ├── sendEmail() via Resend API
  │   ├── Update email: status=sent, resend_id, sent_at
  │   └── Update lead: status=contacted
  └── Log summary

Total pipeline duration: ~30–90 minutes depending on quota size
```

### Follow-up Sequence (9:00 AM daily)

```
9:00 AM   Trigger.dev fires followup-job

runFollowUpAgent():
  ├── Read: follow_up_1_days (7), follow_up_2_days (14), dead_lead_days (21)
  ├── Find all leads with status=contacted
  └── For each lead:
      ├── Find initial_pitch email → get sent_at
      ├── Calculate daysSince = (now - sent_at) / 86400000
      │
      ├── daysSince >= 21 AND no response → status=dead
      │
      ├── daysSince >= 14 AND hasFollowUp1 AND NOT hasFollowUp2
      │   → Send follow-up 2: "Last message from me on this one..."
      │   → Insert emails row (follow_up_2), follow_ups row
      │
      └── daysSince >= 7 AND NOT hasFollowUp1
          → Send follow-up 1: "Bumping this in case my last email got buried..."
          → Insert emails row (follow_up_1), follow_ups row
```

### Daily Digest (8:00 AM daily)

```
8:00 AM   Trigger.dev fires digest-job

sendDailyDigest():
  ├── Count emails sent in last 24h (initial + follow-ups)
  ├── Count new replies in last 24h
  ├── Count deals closed this week + total value
  └── Send formatted HTML email to digest_email setting
```

---

## 8. Settings Explained

| Key | Default | Description | Production Recommendation |
|-----|---------|-------------|--------------------------|
| `system_active` | `true` | Master on/off switch. Set to `false` to pause all agents immediately. | `true` during normal operation, `false` when debugging |
| `daily_lead_limit` | `50` | Maximum total new leads (email + DM) per day | `40` (balanced) or `60` (aggressive) |
| `daily_email_limit` | `50` | Maximum emails sent per day by Sender. Also used by Finder as `EMAIL_TARGET`. | `30` (conservative for deliverability) |
| `daily_dm_limit` | `10` | Maximum DMs queued per day by Writer | `10` (Instagram limits DMs per day) |
| `follow_up_1_days` | `7` | Days after initial pitch to send follow-up 1 | `7` (standard cadence) |
| `follow_up_2_days` | `14` | Days after initial pitch to send follow-up 2 | `14` (two weeks total) |
| `dead_lead_days` | `21` | Days after initial pitch to mark lead as dead | `21` (three weeks) |
| `digest_email` | `hello@aussieventure.com` | Where to send the daily summary email | Your personal email |
| `active_cities` | `Sydney` | Comma-separated cities (legacy — Finder ignores this now) | `Sydney` |
| `app_url` | `http://localhost:3000` | Dashboard URL included in digest email | Your Vercel deployment URL |

---

## 9. Tech Stack

### Outscraper
- **What:** Google Maps business data API (name, address, phone, website, email, rating, reviews)
- **Why:** Only service that returns real Google Maps data with email fields; direct Google API is rate-limited and restricted
- **Cost:** ~$0.002 per result. 50 results per search call = $0.10/call. With 11 search calls per day = ~$1.10/day = ~$33/month
- **Get API key:** [outscraper.com](https://outscraper.com) → Sign up → API Keys section

### Supabase
- **What:** Postgres database + Auth + REST API + Row Level Security
- **Why:** Managed Postgres with built-in auth, RLS policies for multi-role access (service role for agents, anon for dashboard), generous free tier
- **Cost:** Free tier covers this project comfortably (500MB storage, 2GB transfer/month). Pro plan is $25/month if needed.
- **Get started:** [supabase.com](https://supabase.com) → New project → copy `SUPABASE_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` from Settings → API

### Anthropic (Claude)
- **What:** AI API for email writing (Sonnet) and data extraction (Haiku)
- **Why:** Best personalisation quality for outreach emails; Haiku is extremely cheap for extraction tasks
- **Models used:**
  - `claude-haiku-4-5` — extraction tasks (cheap, fast)
  - `claude-sonnet-4-6` — email/DM writing (quality output)
- **Cost:** ~$0.003–0.01 per email written (Sonnet). ~$0.001 per extraction (Haiku). With 30 emails/day = ~$0.30/day = ~$9/month
- **Get API key:** [console.anthropic.com](https://console.anthropic.com) → API Keys

### Resend
- **What:** Transactional email API with delivery tracking and webhooks
- **Why:** Best cold email deliverability, clean API, webhook support for reply/bounce tracking, free tier covers 3,000 emails/month
- **Cost:** Free up to 3,000 emails/month. $20/month for 50,000 emails. At 30/day = 900/month = **free**
- **Get API key:** [resend.com](https://resend.com) → API Keys. Must verify the sending domain (`aussieventure.com`)

### Trigger.dev
- **What:** Background job scheduler for long-running tasks (up to 1 hour)
- **Why:** Vercel serverless functions timeout at 60s, not nearly enough for a pipeline that takes 30–90 minutes. Trigger.dev runs jobs on dedicated workers with no timeout limit.
- **Cost:** Free tier covers 10,000 task runs/month. With 3 cron jobs × 30 days = 90 runs/month = **free**
- **Get started:** [trigger.dev](https://trigger.dev) → New project → copy `TRIGGER_SECRET_KEY`

### Vercel
- **What:** Next.js hosting
- **Why:** Zero-config deployment for Next.js, automatic HTTPS, free tier
- **Cost:** Free (Hobby plan)
- **Deploy:** Connect GitHub repo → Vercel auto-deploys on push to `master`

---

## 10. Deployment

### Environment Variables

Create these in Vercel Dashboard → Settings → Environment Variables, AND in your local `.env.local`:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJh...
SUPABASE_SERVICE_ROLE_KEY=eyJh...

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Resend
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...

# Outscraper
OUTSCRAPER_API_KEY=...

# Trigger.dev
TRIGGER_SECRET_KEY=tr_dev_...

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
ADMIN_EMAIL=hello@aussieventure.com
```

### Supabase Setup

1. Create new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor
3. Run `supabase/migrations/001_initial_schema.sql` (creates all tables + seeds default settings + categories)
4. Run `supabase/migrations/002_add_dm_limit.sql`
5. Run `supabase/migrations/003_add_dm_queued_status.sql`
6. Go to Authentication → Providers → Email → ensure email auth is enabled
7. Create your admin user: Authentication → Users → Add User (use your email)
8. Copy URL, anon key, service role key from Settings → API

### Vercel Deployment

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Or connect GitHub: vercel.com → Import Project → GitHub repo
```

Add all environment variables in Vercel Dashboard.

### Trigger.dev Deployment

```bash
# Deploy background jobs
npm run deploy:trigger
# Equivalent to: npx trigger.dev@4.4.4 deploy
```

This bundles and deploys all tasks in the `trigger/` folder to Trigger.dev cloud. The three scheduled tasks (`daily-pipeline-schedule`, `followup-job`, `digest-job`) will start running on their cron schedules immediately.

To deploy updates after code changes:
```bash
npm run build          # Verify TypeScript compiles
npm run deploy:trigger # Deploy to Trigger.dev
git add . && git commit -m "..." && git push  # Deploy to Vercel
```

### Resend Domain Setup

1. Go to Resend → Domains → Add Domain → enter `aussieventure.com`
2. Add the DNS records shown (MX, TXT, DKIM) to your domain registrar
3. Wait for verification (usually 5–30 minutes)
4. Set up webhook: Resend → Webhooks → Add Endpoint
   - URL: `https://your-app.vercel.app/api/webhooks/resend`
   - Events: `email.replied`, `email.bounced`
   - Copy the webhook secret to `RESEND_WEBHOOK_SECRET`

---

## 11. Testing

All test scripts are in `/scripts/` and run locally with `npx tsx scripts/<file>.ts`. They load `.env.local` automatically. **None of them write to the database.**

### `scripts/test-email-extract.ts`
**What:** Tests email extraction on a specific website (Summer Travel).
```bash
npx tsx scripts/test-email-extract.ts
```
Fetches homepage and `/contact` page, runs regex, logs all matches. Used to debug why a known email wasn't being found (diagnosed the 6000-char truncation issue).

---

### `scripts/test-one-business.ts`
**What:** Runs a live Outscraper search (`tour operator Sydney`, limit=10), picks the first result with a website, logs the full raw Outscraper object, fetches the website, and runs email extraction.
```bash
npx tsx scripts/test-one-business.ts
```
Use this to verify:
- What fields Outscraper actually returns (vs what the TypeScript type declares)
- Whether email extraction works on a given site
- What the raw HTML looks like

---

### `scripts/test-hotel-emails.ts`
**What:** Searches `hotel Sydney` limit=10, attempts email extraction on every result, logs per-business results and a final summary.
```bash
npx tsx scripts/test-hotel-emails.ts
```
Shows: `X/10 hotels had findable emails`. Useful for evaluating a category's email yield before adding it to the Finder.

---

### `scripts/test-travel-emails.ts`
**What:** Same as hotel test but for `travel agent Sydney`. Includes URL decoding (`decodeURIComponent`) and tries homepage, `/contact`, `/contact-us`, `/about`, `/about-us` pages.
```bash
npx tsx scripts/test-travel-emails.ts
```
Key finding: travel agents yield ~6-7/10 emails, much better than generic hotels (2/10).

---

### `scripts/test-finder-logic.ts`
**What:** Legacy test script from earlier finder development. Tests the old suburb-rotation finder logic.
```bash
npx tsx scripts/test-finder-logic.ts
```
Largely superseded by the category-specific test scripts above.

---

### `scripts/test-followup.ts`
**What:** Finds one `contacted` lead in the database, bypasses the 7-day check, generates a follow-up 1 email, and sends it to `hello@aussieventure.com` (not the real business).
```bash
npx tsx scripts/test-followup.ts
```
Use this to verify the follow-up email template and Resend delivery before relying on the automated follow-up agent.

---

## 12. Costs

### Monthly Cost Breakdown

| Service | Usage | Cost/Month |
|---------|-------|-----------|
| Outscraper | 11 searches/day × 30 days × $0.10/search | ~$33 |
| Anthropic (Sonnet) | 30 emails/day × $0.007/email × 30 days | ~$6 |
| Anthropic (Haiku) | 30 extractions/day × $0.001 × 30 days | ~$1 |
| Resend | 900 emails/month (free tier) | $0 |
| Trigger.dev | 90 runs/month (free tier) | $0 |
| Supabase | Free tier | $0 |
| Vercel | Free tier | $0 |
| **Total** | | **~$40/month** |

### Cost Per Lead

```
$40/month ÷ (30 leads/day × 30 days) = $0.044 per lead
```

### Cost Per Email Sent

```
$40/month ÷ 900 emails/month = $0.044 per email sent
```

### ROI Calculation

```
At $0.044/email and a 10% reply rate, 3% close rate:
→ 1 closed deal per ~333 emails
→ Cost to acquire 1 deal: $14.67
→ Average deal value: $300–$500
→ ROI: 20x–34x
```

---

## 13. Future Improvements

### Self-Improving Email Quality
Store open rates, reply rates, and close rates per email template variant. After 100+ sends, use Claude to analyse which subject lines and pitches get the best response rates, then automatically rewrite underperforming templates.

### RAG (Retrieval-Augmented Generation) for Email Writing
Build a vector database of successful deals with their email content. When writing new outreach for a similar business category, retrieve the 3 most similar successful emails and use them as style examples for Claude.

### City Expansion Strategy
Currently hardcoded to Sydney. To expand to Melbourne, Brisbane, Perth:
1. Add city to `active_cities` setting
2. Update `EMAIL_CATEGORIES` in `finder.ts` to accept a city parameter
3. Modify dedup check to use `city` field from the Outscraper result (currently hardcoded to 'Sydney')
4. Add per-city quotas to prevent one city dominating the daily run

### Instagram Reply Automation
Currently DMs are sent manually by Owais. Future improvement: integrate with Instagram Graph API (requires Meta Business verification) or a third-party tool like ManyChat to automate initial DM sending and track reply status back to the database.

### Webhook-Based Reply Tracking
Resend webhooks currently handle `email.replied` and `email.bounced`. Could be extended to:
- Detect reply sentiment (interested/not interested/wrong person) using Claude
- Auto-move leads to `negotiating` when reply indicates interest
- Auto-respond to replies requesting info with a Claude-generated response

### Lead Scoring
Add a score to each lead based on:
- Google rating (4.5+ = higher score)
- Review count (social proof)
- Business age (website age from WHOIS)
- Instagram following (scraped from their profile)
Prioritise high-score leads in the Writer queue.

### Competitor Tracking
Monitor which businesses post collab content with competitors. If a business posted a collab reel with a similar account, they're more likely to respond to an outreach pitch.

---

## 14. Troubleshooting

### Pipeline didn't run today

1. Check Trigger.dev dashboard → your project → Runs → look for today's `daily-pipeline` run
2. If no run appears: check that `daily-pipeline-schedule` task is deployed (it should be listed in Tasks)
3. If run exists but failed: click it → view logs → look for the first error
4. Common cause: `system_active` setting is `false` → go to dashboard Settings → toggle on

### Emails not being sent

1. Dashboard → Email Log → filter by `pending_send` — are there queued emails?
2. If no pending emails: Writer isn't producing them. Check Trigger.dev logs for `runWriterAgent` — look for "No researched leads found"
3. If emails exist but status stays `pending_send`: Sender failed. Check Trigger.dev logs for `runSenderAgent` → look for Resend errors
4. Check Resend dashboard → Emails → look for recent sends or errors
5. Verify `RESEND_API_KEY` is set correctly in Vercel environment variables

### Emails bouncing

1. Resend → Emails → filter by Bounced status
2. Check if the email domain is valid (typos, old domains)
3. Verify Resend domain verification is still passing → Resend → Domains → should show green status

### Outscraper returning 401

The API key is invalid or exhausted. Check:
1. Outscraper dashboard → API Keys → verify key is active
2. Outscraper dashboard → Usage → check remaining credits
3. If running test scripts locally, ensure `.env.local` exists and has the correct key

### Outscraper returning empty results

Some searches return fewer results than expected. Common causes:
- Query too specific for the area (e.g., "boutique hotel Sydney" may return only 6 results)
- Outscraper rate limiting: 10 calls/minute, built-in to `src/lib/outscraper.ts`
- If consistently empty for a category, verify the query by pasting it into Google Maps

### Leads found but no emails extracted

Run the test script for that category:
```bash
npx tsx scripts/test-hotel-emails.ts   # for hotels
npx tsx scripts/test-travel-emails.ts  # for travel agents
```

Common reasons:
- Business uses a contact form with no email in HTML (e.g., Shopify stores)
- Large corporate chain blocks bot User-Agent with 403
- Email is behind a JavaScript wall (not in initial HTML)
- URL encoding issue — check if the website URL has `%3F` in it (should be decoded to `?`)

### Follow-ups not sending

1. Check `follow_up_1_days` setting in dashboard — ensure it's `7`, not `70`
2. Check Trigger.dev → `followup-job` run logs
3. Verify there are `contacted` leads with `initial_pitch` emails that have a `sent_at` timestamp
4. If `sent_at` is null on the initial pitch email, the follow-up agent will skip that lead

### How to check Trigger.dev logs

1. Go to [cloud.trigger.dev](https://cloud.trigger.dev)
2. Select your project
3. Click "Runs" in the left sidebar
4. Find the run you want to inspect (filter by task name and date)
5. Click the run → expand each step → view `console.log` output

### How to verify emails in Resend

1. Go to [resend.com](https://resend.com) → Emails
2. Filter by date, status, or recipient
3. Click an email to see delivery details, open events, bounce info
4. For debugging a specific send: find the `resend_id` in the `emails` table in Supabase, then search for it in Resend

### How to manually trigger the pipeline

Option 1 — Dashboard:
```
Dashboard → Pipeline → "Run Pipeline Now" button
```
This calls `POST /api/pipeline/run` which triggers the Trigger.dev task.

Option 2 — Trigger.dev dashboard:
```
cloud.trigger.dev → your project → Tasks → daily-pipeline → "Test" button → Run
```

Option 3 — API call:
```bash
curl -X POST https://your-app.vercel.app/api/pipeline/run \
  -H "Content-Type: application/json"
```
