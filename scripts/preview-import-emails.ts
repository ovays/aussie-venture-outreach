/**
 * scripts/preview-import-emails.ts
 *
 * Live before/after preview of the emails createLead() generates for a batch
 * of about-to-be-imported leads, WITHOUT inserting anything into the DB.
 *
 * "Before" = description/services left blank (the old behaviour).
 * "After"  = description/services populated via enrichFromWebsite()
 *            (src/lib/create-lead.ts) — the same fetchRawHtml() +
 *            extractWebsiteData() call createLead() now runs for every new
 *            lead with a website.
 *
 * Uses the exact same pieces createLead() uses:
 *  - real `categories` row lookup (same query createLead runs) + resolveContentType()
 *  - enrichFromWebsite() (src/lib/create-lead.ts) — live website fetch + Claude extraction
 *  - writeOutreachEmail() (src/lib/claude.ts) — live Claude call, same prompt
 *  - generateFollowUpEmail('follow_up_1', ...) (src/lib/followup-generation.ts)
 *    with the real initial email folded into `history`, same as create-lead.ts does
 *
 * Run: npx tsx scripts/preview-import-emails.ts
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { createClient } from '@supabase/supabase-js'
import { resolveContentType } from '@/lib/content-type'
import type { FollowUpThreadEmail } from '@/lib/followup-generation'

const LEADS = [
  { business_name: 'Head Office Sydney', email: 'kaline@headofficesydney.com', website: 'https://headofficesydney.com', city: 'Sydney', category_name: 'Go Karting' },
  { business_name: 'Eastern Creek Karting', email: 'info@easterncreekkarts.com.au', website: 'https://easterncreekkarts.com.au', city: 'Sydney', category_name: 'Go Karting' },
  { business_name: 'Extreme Go Karting Sydney', email: 'info@extremegokartingsydney.com.au', website: 'https://extremegokartingsydney.com.au', city: 'Sydney', category_name: 'Go Karting' },
  { business_name: 'Luddenham Raceway', email: 'info@luddenhamraceway.com', website: 'https://luddenhamraceway.com', city: 'Sydney', category_name: 'Go Karting' },
]

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase env vars')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } })

  // Dynamic import: claude.ts constructs `new Anthropic({apiKey: ...})` at
  // module-load time, and static imports are hoisted above dotenv.config()
  // above, so it must be loaded only after env vars are populated.
  const { writeOutreachEmail } = await import('@/lib/claude')
  const { generateFollowUpEmail } = await import('@/lib/followup-generation')
  const { enrichFromWebsite } = await import('@/lib/create-lead')

  // Same category lookup createLead() runs (by name here since we don't have IDs for a dry run)
  const { data: category, error: catErr } = await supabase
    .from('categories')
    .select('name, content_type, city_content_types')
    .eq('name', 'Go Karting')
    .maybeSingle()

  if (catErr) {
    console.error('Category lookup failed:', catErr.message)
    process.exit(1)
  }

  console.log('═'.repeat(70))
  console.log('categories row for "Go Karting":', JSON.stringify(category))
  const contentType = resolveContentType(category, 'Sydney')
  console.log('resolveContentType(category, "Sydney") =>', contentType)
  console.log('═'.repeat(70))

  // One representative imported lead — same shape createLead() would enrich.
  const lead = LEADS[1]

  console.log(`\n\n################  ${lead.business_name}  ################\n`)

  const enrichment = await enrichFromWebsite(lead.website, lead.business_name)
  console.log('enrichFromWebsite() result:', JSON.stringify(enrichment, null, 2))

  for (const variant of ['BEFORE (blank description/services)', 'AFTER (enrichFromWebsite)'] as const) {
    const isAfter = variant.startsWith('AFTER')
    const description = isAfter ? enrichment.description : ''
    const services = isAfter ? enrichment.services : ''

    console.log('\n' + '─'.repeat(70))
    console.log(variant)
    console.log('─'.repeat(70))

    const initial = await writeOutreachEmail({
      business_name: lead.business_name,
      category: lead.category_name,
      suburb: '',
      city: lead.city,
      website: lead.website,
      description,
      services,
      content_type: contentType,
    })

    console.log('--- INITIAL OUTREACH ---')
    console.log('Subject:', initial.subject)
    console.log('\n' + initial.body)

    const history: FollowUpThreadEmail[] = [{ type: 'initial_pitch', subject: initial.subject, body: initial.body }]

    const fu1 = await generateFollowUpEmail(
      'follow_up_1',
      {
        businessName: lead.business_name,
        category: lead.category_name,
        suburb: '',
        city: lead.city,
        website: lead.website,
        description,
        services,
        notes: '',
        contentType,
      },
      initial.subject,
      history
    )

    console.log('\n--- FOLLOW-UP 1 --- (source:', fu1.source, ')')
    console.log('Subject:', fu1.subject)
    console.log('\n' + fu1.body)
  }

  console.log('\n\n' + '═'.repeat(70))
  console.log('DONE')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
