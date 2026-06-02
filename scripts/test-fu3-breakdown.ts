/**
 * scripts/test-fu3-breakdown.ts
 *
 * Explains the three different FU3 counts:
 *
 *   Lifecycle FU3 Stage  = 406
 *   Lifecycle FU3 Due    = 176
 *   Sender FU3 Eligible  = 340
 *
 * Produces five verified counts from the live database (service-role key,
 * no RLS) and shows exactly which condition separates each number.
 *
 * Read-only. No emails sent. No DB mutations.
 * Run: npm run test:fu3-breakdown
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(70)
const DIV = '─'.repeat(70)

interface EmailRow {
  type: string
  sent_at: string | null
}

interface LeadRow {
  id: string
  business_name: string
  email: string | null
  reactivation_sent_at: string | null
  emails: EmailRow[]
}

async function main(): Promise<void> {
  console.log(SEP)
  console.log('  TEST:FU3-BREAKDOWN  —  read-only, no emails sent')
  console.log(SEP)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  const { data: settingsRows } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days'])

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const fu1Days = parseInt(sm['follow_up_1_days'] ?? '7',  10)
  const fu2Days = parseInt(sm['follow_up_2_days'] ?? '14', 10)
  const fu3Days = parseInt(sm['follow_up_3_days'] ?? '21', 10)

  console.log(`\n  Settings (from DB): fu1Days=${fu1Days}  fu2Days=${fu2Days}  fu3Days=${fu3Days}`)
  console.log(`  Client: service-role key (bypasses RLS)\n`)

  // ── Load all contacted leads (same join as both lifecycle and sender) ──────
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, email, reactivation_sent_at, emails(type, sent_at)')
    .eq('status', 'contacted')

  if (error) { console.error('✗', error.message); process.exit(1) }

  const all = (leads ?? []) as LeadRow[]
  console.log(`  Contacted leads fetched: ${all.length}\n`)

  // ── Query descriptions ────────────────────────────────────────────────────
  console.log(SEP)
  console.log('  EXACT QUERY LOGIC FOR EACH COUNT')
  console.log(SEP)

  console.log(`
  COUNT 1 — FU3 Stage (lifecycle pill, LifecycleTable.tsx:200)
  ─────────────────────────────────────────────────────────────
  Source:  leads.filter(l => l.filter_key === 'fu3')
  Compute: computeLifecycle() in src/app/api/lifecycle/route.ts
  Client:  createClient() — anon key, subject to RLS
  Query:   .from('leads')
             .select('id, business_name, email, status, reactivation_sent_at, emails(type, sent_at)')
             .eq('status', 'contacted')   ← also queries dead leads but they get filter_key='dead'

  filter_key='fu3' is assigned when ALL of:
    ✓ lead.status = 'contacted'
    ✓ lead.email IS NOT NULL
    ✗ lead.reactivation_sent_at IS NULL   (if set → returns filter_key='reactivation' early)
    ✓ initial_pitch email exists with sent_at IS NOT NULL
    ✓ follow_up_1 email exists with sent_at IS NOT NULL  (hasFu1Sent)
    ✓ follow_up_2 email exists with sent_at IS NOT NULL  (hasFu2Sent)
    ✗ follow_up_3 email with sent_at IS NULL / absent    (hasFu3Sent=false)
    ← is_overdue ignored — both overdue AND not-yet-due are included

  COUNT 2 — FU3 Due (lifecycle summary card, lifecycle/route.ts:224)
  ─────────────────────────────────────────────────────────────────────
  Source:  leads.filter(l => l.filter_key === 'fu3' && l.is_overdue).length
  Client:  createClient() — anon key, subject to RLS
  Same query as Count 1 PLUS:
    ✓ is_overdue = eligibility.isDue = (daysSince >= fu3Days)
    i.e. daysSince(initial_pitch.sent_at, now) >= ${fu3Days}

  COUNT 3 — Sender FU3 Eligible (agents/followup.ts, queues.follow_up_3)
  ─────────────────────────────────────────────────────────────────────────
  Client:  createServiceClient() — service-role key, bypasses RLS
  Query:   .from('leads')
             .select('*, emails(id, type, subject, sent_at, status)')
             .eq('status', 'contacted')

  A lead enters queues.follow_up_3 when ALL of:
    ✓ lead.email IS NOT NULL
    ✓ initial_pitch email exists with sent_at IS NOT NULL
    ✓ hasFu1Sent = true
    ✓ hasFu2Sent = true
    ✓ hasFu3Sent = false
    ✓ eligibility.isDue = (daysSince >= ${fu3Days})
    ← reactivation_sent_at is NEVER checked — no early-return here
`)

  // ── Compute five counts ───────────────────────────────────────────────────
  const now = new Date()

  interface Row { name: string; id: string; reactSentAt: string | null; daysSince: number }

  const fu3Stage:           Row[] = []   // Count 1: filter_key='fu3', any is_overdue
  const fu3Overdue:         Row[] = []   // Count 2: filter_key='fu3' && is_overdue
  const senderEligible:     Row[] = []   // Count 3: sender logic (includes reactivation leads)
  const senderWithReact:    Row[] = []   // Count 4: sender eligible + reactivation_sent_at IS NOT NULL
  const senderWithoutReact: Row[] = []   // Count 5: sender eligible + reactivation_sent_at IS NULL

  for (const lead of all) {
    if (!lead.email) continue

    const emails       = lead.emails ?? []
    const initialEmail = emails.find((e) => e.type === 'initial_pitch' && isFuEmailSent(e))
    if (!initialEmail?.sent_at) continue

    const hasFu1Sent = emails.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const hasFu2Sent = emails.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
    const hasFu3Sent = emails.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at,
      hasFu1Sent,
      hasFu2Sent,
      hasFu3Sent,
      { fu1Days, fu2Days, fu3Days },
      now
    )

    const row: Row = {
      name:        lead.business_name,
      id:          lead.id,
      reactSentAt: lead.reactivation_sent_at,
      daysSince:   eligibility.daysSince,
    }

    const isFu3Next = eligibility.nextFuType === 'follow_up_3'

    // ── Count 1: FU3 Stage (lifecycle logic — excludes reactivation_sent_at leads)
    if (isFu3Next && !lead.reactivation_sent_at) {
      fu3Stage.push(row)
    }

    // ── Count 2: FU3 Overdue (lifecycle logic — same exclusion + must be due)
    if (isFu3Next && !lead.reactivation_sent_at && eligibility.isDue) {
      fu3Overdue.push(row)
    }

    // ── Count 3: Sender eligible (no reactivation_sent_at gate + must be due)
    if (isFu3Next && eligibility.isDue) {
      senderEligible.push(row)

      if (lead.reactivation_sent_at) {
        senderWithReact.push(row)    // Count 4
      } else {
        senderWithoutReact.push(row) // Count 5
      }
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(SEP)
  console.log('  COUNTS')
  console.log(SEP)
  console.log(`
  Count 1  FU3 Stage leads               (lifecycle filter_key='fu3')           = ${fu3Stage.length}
  Count 2  FU3 Overdue leads             (filter_key='fu3' && is_overdue)        = ${fu3Overdue.length}
  Count 3  FU3 Sender-eligible leads     (sender logic, no react gate)           = ${senderEligible.length}
  Count 4  Sender-eligible, react IS NOT NULL                                    = ${senderWithReact.length}
  Count 5  Sender-eligible, react IS NULL                                        = ${senderWithoutReact.length}
`)

  // ── Verify the two transitions ────────────────────────────────────────────
  console.log(DIV)
  console.log('  406 → 176 explained (FU3 Stage → FU3 Due)')
  console.log(DIV)
  const notYetDue = fu3Stage.length - fu3Overdue.length
  console.log(`
  FU3 Stage (${fu3Stage.length}) = FU3 Overdue (${fu3Overdue.length}) + not-yet-due (${notYetDue})
  These ${notYetDue} leads have FU1+FU2 sent and FU3 pending, but daysSince < ${fu3Days}d.
  Lifecycle correctly shows them in the FU3 Stage pill but NOT in the FU3 Due card.
`)

  console.log(DIV)
  console.log('  176 → 340 explained (FU3 Due → Sender Eligible)')
  console.log(DIV)
  const reactGap = senderWithReact.length
  console.log(`
  Sender Eligible (${senderEligible.length}) = FU3 Overdue (${fu3Overdue.length}) + react_sent_at leads (${reactGap})
  These ${reactGap} leads have reactivation_sent_at IS NOT NULL.
  Lifecycle sees reactivation_sent_at → returns filter_key='reactivation' immediately,
    so they never reach computeFollowUpEligibility and never count in fu3_due.
  Sender has no reactivation_sent_at check → processes them through the FU loop,
    sees FU3 not sent + daysSince >= ${fu3Days}d → adds them to the FU3 queue.

  Count 5 = Count 2: ${senderWithoutReact.length === fu3Overdue.length ? '✓ MATCH' : `✗ MISMATCH (${senderWithoutReact.length} vs ${fu3Overdue.length})`}
  (when reactivation_sent_at IS NULL, lifecycle and sender see the same leads)
`)

  // ── Sample leads from each bucket ─────────────────────────────────────────
  function printSample(label: string, rows: Row[], max = 5): void {
    console.log(DIV)
    console.log(`  ${label} (${rows.length} total, showing up to ${max}):`)
    if (!rows.length) { console.log('  (none)'); return }
    for (const r of rows.slice(0, max)) {
      console.log(`  - ${r.name.slice(0, 45).padEnd(45)}  id=${r.id.slice(0, 8)}…  ${r.daysSince}d since initial  react=${r.reactSentAt ? r.reactSentAt.slice(0, 10) : 'null'}`)
    }
    if (rows.length > max) console.log(`    … and ${rows.length - max} more`)
  }

  console.log('\n' + SEP)
  console.log('  SAMPLES')
  console.log(SEP)

  printSample('FU3 Stage (not yet overdue)',
    fu3Stage.filter((r) => !fu3Overdue.includes(r)))

  printSample('FU3 Overdue (lifecycle fu3_due)',    fu3Overdue)
  printSample('Sender-eligible, react IS NULL',     senderWithoutReact)
  printSample('Sender-eligible, react IS NOT NULL', senderWithReact)

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP)
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
