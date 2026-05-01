# Aussie Venture Outreach System

Fully autonomous outreach pipeline — finds businesses across Australia, writes personalised pitch emails with Claude AI, sends them automatically, follows up, and tracks everything in an admin panel.

## How It Works

Every day at 8:00am Sydney time (AEST/AEDT):

1. **Finder Agent** — searches Google Maps via Outscraper, finds 50 new businesses, checks for duplicates
2. **Researcher Agent** — visits each business website, extracts Instagram handle and description
3. **Writer Agent** — uses Claude Sonnet to write a personalised email and DM for each lead
4. **Sender Agent** — sends emails via Resend from hello@aussieventure.com
5. **DM Queue** — Instagram DMs are saved for Owais to send manually
6. **Follow-up Agent** — sends follow-up emails at 7 and 14 days; marks dead at 21 days
7. **Daily Digest** — sends a summary email at 8am with stats

## Setup

### 1. Clone and install

```bash
npm install
```

### 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Run `supabase/migrations/001_initial_schema.sql` in the SQL editor
3. Create user `hello@aussieventure.com` in Supabase Auth > Users
4. Copy your project URL and keys

### 3. Configure environment variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

Required keys:
- `NEXT_PUBLIC_SUPABASE_URL` — from Supabase project settings
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from Supabase project settings
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase project settings
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
- `RESEND_API_KEY` — from [resend.com](https://resend.com)
- `RESEND_WEBHOOK_SECRET` — from Resend webhook settings
- `OUTSCRAPER_API_KEY` — from [outscraper.com](https://outscraper.com)
- `TRIGGER_SECRET_KEY` — from [trigger.dev](https://trigger.dev)

### 4. Set up Resend

1. Verify domain `aussieventure.com` in Resend
2. Create an API key
3. Set up a webhook pointing to `{APP_URL}/api/webhooks/resend` for reply/bounce events

### 5. Set up Trigger.dev

```bash
npx trigger.dev deploy
```

This deploys all 3 scheduled jobs:
- **daily-pipeline** — 8:00am AEST (Finder → Researcher → Writer → Sender)
- **followup-job** — 9:00am AEST (Follow-up emails)
- **digest-job** — 8:00am AEST (Daily summary email)

### 6. Run locally

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) — you'll be redirected to `/login`.

Sign in with the Supabase Auth user you created (`hello@aussieventure.com`).

### 7. Deploy to Vercel

1. Push to GitHub
2. Import the repo in Vercel
3. Add all environment variables from `.env.local` in Vercel dashboard
4. Deploy

Update `NEXT_PUBLIC_APP_URL` to your Vercel deployment URL.

## Admin Panel Pages

| Page | URL | Description |
|------|-----|-------------|
| Dashboard | `/dashboard` | Stats, pipeline summary, revenue chart, activity feed |
| Leads | `/dashboard/leads` | All leads with filters, search, and detail panel |
| DM Queue | `/dashboard/dm-queue` | Instagram/Facebook DMs to send manually |
| Pipeline | `/dashboard/pipeline` | Kanban board — drag cards between stages |
| Email Log | `/dashboard/email-log` | All emails sent with preview |
| Deals | `/dashboard/deals` | Closed deals, revenue tracking |
| Settings | `/dashboard/settings` | System config, categories management |

## Tech Stack

- **Framework** — Next.js 14 (App Router) + TypeScript
- **Database** — Supabase (PostgreSQL + Auth)
- **Email** — Resend
- **AI** — Claude Sonnet 4.6 (emails/DMs) + Claude Haiku 4.5 (research)
- **Lead Scraping** — Outscraper (Google Maps)
- **Job Scheduling** — Trigger.dev
- **Styling** — Tailwind CSS
- **Charts** — Recharts
- **Hosting** — Vercel

## Target Business Categories

| Category | Halal | Cities | Type |
|----------|-------|--------|------|
| Halal Restaurants | Yes | Sydney | Visit + Content |
| Halal Cafes | Yes | Sydney | Visit + Content |
| Halal Bakeries | Yes | Sydney | Visit + Content |
| Nail Salons | No | All | Remote Sponsored |
| Hair Salons | No | All | Remote Sponsored |
| Beauty / Lash Studios | No | All | Remote Sponsored |
| Spas / Massage Studios | No | All | Remote Sponsored |
| Travel Agents | No | All | Remote Sponsored |
| Tour Operators | No | All | Remote Sponsored |
| Hotels / Resorts | No | All | Remote Sponsored |
