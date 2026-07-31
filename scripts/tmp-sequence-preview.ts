/**
 * scripts/tmp-sequence-preview.ts  (TEMPORARY — manual review harness)
 *
 * Generates the COMPLETE five-email sequence for one category using the real
 * production code paths:
 *   1. writeOutreachEmail        (src/ai/workflows.ts)
 *   2/3/4. generateFollowUpEmail (src/lib/followup-generation.ts) with real thread history
 *   5. writeReactivationEmail    (src/ai/workflows.ts)
 *
 * Content type is resolved from the live categories row + city, exactly as the
 * sender does. Run: npx tsx scripts/tmp-sequence-preview.ts "Halal Restaurants"
 */
import * as dotenv from 'dotenv'
import { resolve } from 'path'
dotenv.config({ path: resolve(__dirname, '../.env.local') })

import { createClient } from '@supabase/supabase-js'
import type { FollowUpThreadEmail } from '@/lib/followup-generation'

// Loaded dynamically below: static imports are hoisted above dotenv.config(),
// and the configured AI provider is initialized at module load time.
type AIWorkflows = typeof import('@/ai/workflows')
type FollowUpMod = typeof import('@/lib/followup-generation')
type ContentTypeMod = typeof import('@/lib/content-type')
type CategoryCopyMod = typeof import('@/lib/category-copy')

type Sample = {
  business_name: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
}

const SAMPLES: Record<string, Sample> = {
  'Halal Restaurants': {
    business_name: 'Nour Lebanese Kitchen', suburb: 'Lakemba', city: 'Sydney',
    website: 'https://nourlebanese.com.au',
    description: 'A family-run Lebanese charcoal grill restaurant serving mixed plates and mezze.',
    services: 'Dine-in, takeaway, catering for functions',
  },
  'Halal Cafes': {
    business_name: 'Zeytoun Coffee House', suburb: 'Bankstown', city: 'Sydney',
    website: 'https://zeytouncoffee.com.au',
    description: 'A halal cafe open until midnight, roasting its own beans on site.',
    services: 'Breakfast and all-day brunch, specialty coffee, late-night desserts',
  },
  'Halal Bakeries / Dessert Shops': {
    business_name: 'Kova Patisserie', suburb: 'Auburn', city: 'Sydney',
    website: 'https://kovapatisserie.com.au',
    description: 'A dessert shop making Japanese-style cakes and pastries on site each morning.',
    services: 'Cakes, pastries, custom celebration cakes',
  },
  'Nail Salons': {
    business_name: 'Luxe Nail Bar', suburb: 'Melbourne CBD', city: 'Melbourne',
    website: 'https://luxenailbar.com.au',
    description: 'A nail salon offering manicures, pedicures and gel extensions.',
    services: 'Manicures, pedicures, gel and acrylic extensions, nail art',
  },
  'Hair Salons': {
    business_name: 'Edwards and Co Hair', suburb: 'Paddington', city: 'Sydney',
    website: 'https://edwardsandco.com.au',
    description: 'A hair salon specialising in blonde colour work and extensions.',
    services: 'Cutting, colour, balayage, hair extensions',
  },
  'Beauty / Lash Studios': {
    business_name: 'Lash Lounge Bondi', suburb: 'Bondi Junction', city: 'Sydney',
    website: 'https://lashloungebondi.com.au',
    description: 'A lash and brow studio offering extensions, lifts and tinting.',
    services: 'Lash extensions, lash lifts, brow lamination, tinting',
  },
  'Spas / Massage Studios': {
    business_name: 'Endota Day Spa Chatswood', suburb: 'Chatswood', city: 'Sydney',
    website: 'https://endotaspa.com.au',
    description: 'A day spa offering massage, facials and full-day spa packages.',
    services: 'Remedial and relaxation massage, facials, body treatments',
  },
  'Travel Agents': {
    business_name: 'Wanderlust Travel Co', suburb: 'Parramatta', city: 'Sydney',
    website: 'https://wanderlusttravel.com.au',
    description: 'A travel agency booking domestic and overseas trips for families and groups.',
    services: 'Domestic holidays, overseas packages, group bookings, cruises',
  },
  'Tour Operators': {
    business_name: 'Blue Mountains Guided Tours', suburb: 'Katoomba', city: 'Sydney',
    website: 'https://bmguidedtours.com.au',
    description: 'A small-group day tour operator running Blue Mountains and Jenolan Caves trips.',
    services: 'Day tours, small-group bushwalks, private charters',
  },
  'Hotels / Resorts': {
    business_name: 'Ovolo Woolloomooloo', suburb: 'Woolloomooloo', city: 'Sydney',
    website: 'https://ovolohotels.com',
    description: 'A boutique hotel on the finger wharf at Woolloomooloo with harbour-facing rooms.',
    services: 'Accommodation, on-site restaurant and bar, function spaces',
  },
  'Escape Rooms': {
    business_name: 'Escape Hunt Sydney', suburb: 'Surry Hills', city: 'Sydney',
    website: 'https://escapehunt.com.au',
    description: 'An escape room venue running four themed rooms at once.',
    services: 'Escape room bookings for groups of 2-8, corporate team events',
  },
  'VR Experiences': {
    business_name: 'Zero Latency Darling Harbour', suburb: 'Darling Harbour', city: 'Sydney',
    website: 'https://zerolatencyvr.com',
    description: 'A free-roam virtual reality venue running multiplayer missions.',
    services: 'Free-roam VR sessions, group and corporate bookings',
  },
  'Quiz Rooms': {
    business_name: 'The Quiz Room Alexandria', suburb: 'Alexandria', city: 'Sydney',
    website: 'https://thequizroom.com.au',
    description: 'A live quiz venue where teams compete in private buzzer rooms.',
    services: 'Private team quiz sessions, birthday and corporate bookings',
  },
  'Go Karting': {
    business_name: 'Sydney Motorsport Karting', suburb: 'Eastern Creek', city: 'Sydney',
    website: 'https://sydneykarting.com.au',
    description: 'An outdoor go kart track running arrive-and-drive sessions.',
    services: 'Arrive-and-drive races, endurance events, corporate days',
  },
  'Bowling & Entertainment': {
    business_name: 'Kingpin Macquarie Park', suburb: 'Macquarie Park', city: 'Sydney',
    website: 'https://kingpinbowling.com.au',
    description: 'A bowling venue with laser tag, karaoke rooms and arcade games on site.',
    services: 'Ten-pin bowling, laser tag, karaoke, arcade, function packages',
  },
  'Mini Golf': {
    business_name: 'Holey Moley Newtown', suburb: 'Newtown', city: 'Sydney',
    website: 'https://holeymoley.com.au',
    description: 'An indoor mini golf course with a cocktail bar alongside the holes.',
    services: 'Mini golf bookings, cocktail bar, group and party packages',
  },
  'Arcades': {
    business_name: 'Timezone Bondi', suburb: 'Bondi Junction', city: 'Sydney',
    website: 'https://timezonegames.com',
    description: 'An arcade with racing simulators, claw machines and prize redemption.',
    services: 'Arcade games, prize redemption, birthday party packages',
  },
  'Laser Tag': {
    business_name: 'Laserzone Penrith', suburb: 'Penrith', city: 'Sydney',
    website: 'https://laserzone.com.au',
    description: 'A multi-level indoor laser tag arena with a fog and lighting setup.',
    services: 'Laser tag games, birthday parties, corporate team events',
  },
  'Indoor Rock Climbing': {
    business_name: 'BlocHaus Marrickville', suburb: 'Marrickville', city: 'Sydney',
    website: 'https://blochaus.com.au',
    description: 'A bouldering gym with routes reset weekly and a beginner area.',
    services: 'Bouldering, intro classes, memberships, group bookings',
  },
  'Trampoline Parks': {
    business_name: 'Flip Out Prestons', suburb: 'Prestons', city: 'Sydney',
    website: 'https://flipout.com.au',
    description: 'A trampoline park with a ninja course and weekday toddler sessions.',
    services: 'Open jump, ninja course, toddler sessions, birthday parties',
  },
  'Theme Parks': {
    business_name: 'Luna Park Sydney', suburb: 'Milsons Point', city: 'Sydney',
    website: 'https://lunaparksydney.com',
    description: 'A harbourside amusement park with rides and a midway.',
    services: 'Ride passes, group tickets, event hire',
  },
  'Wildlife Parks': {
    business_name: 'Featherdale Wildlife Park', suburb: 'Doonside', city: 'Sydney',
    website: 'https://featherdale.com.au',
    description: 'A wildlife park with daily koala and kangaroo keeper talks.',
    services: 'Park entry, animal encounters, school and group bookings',
  },
  'Aquariums': {
    business_name: 'Irukandji Shark and Ray Encounters', suburb: 'Bobs Farm', city: 'NSW Regional',
    website: 'https://irukandjisharks.com',
    description: 'An aquarium where visitors can snorkel in the shark and ray lagoon.',
    services: 'General entry, snorkel encounters, feeding sessions',
  },
  'Cruises': {
    business_name: 'Captain Cook Cruises', suburb: 'Circular Quay', city: 'Sydney',
    website: 'https://captaincook.com.au',
    description: 'A harbour cruise operator running lunch and dinner sailings as well as sightseeing.',
    services: 'Lunch and dinner cruises, sightseeing, private charters',
  },
  'Kayaking': {
    business_name: 'Sydney Harbour Kayaks', suburb: 'Mosman', city: 'Sydney',
    website: 'https://sydneyharbourkayaks.com.au',
    description: 'A kayak hire and guided paddle operator based on Middle Harbour.',
    services: 'Kayak and paddleboard hire, guided harbour paddles, lessons',
  },
}

function hr(title: string) {
  console.log('\n' + '='.repeat(78))
  console.log(title)
  console.log('='.repeat(78))
}

function words(body: string): number {
  return body.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
}

async function main() {
  const { writeOutreachEmail, writeReactivationEmail }: AIWorkflows = await import('@/ai/workflows')
  const { generateFollowUpEmail }: FollowUpMod = await import('@/lib/followup-generation')
  const { resolveContentType }: ContentTypeMod = await import('@/lib/content-type')
  const { getReminderFamily, getCategoryReminderFocus, getContentFocus, getReactivationFocus }: CategoryCopyMod =
    await import('@/lib/category-copy')

  const categoryName = process.argv[2]
  const sample = SAMPLES[categoryName]
  if (!sample) {
    console.error(`No sample for "${categoryName}". Known: ${Object.keys(SAMPLES).join(' | ')}`)
    process.exit(1)
  }

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: cat, error } = await db
    .from('categories')
    .select('name, content_type, city_content_types')
    .eq('name', categoryName)
    .single()
  if (error || !cat) { console.error('Category not found in DB:', error); process.exit(1) }

  const contentType = resolveContentType(cat, sample.city)

  hr(`${categoryName} — ${sample.business_name}, ${sample.suburb} ${sample.city}`)
  console.log(`content_type resolved:  ${contentType}  (row default: ${cat.content_type}, city override: ${(cat.city_content_types as Record<string, string> | null)?.[sample.city] ?? 'none'})`)
  console.log(`reminder family:        ${getReminderFamily(categoryName)}`)
  console.log(`reminder focus noun:    ${getCategoryReminderFocus(categoryName)}`)
  console.log(`initial content focus:  ${getContentFocus(categoryName, contentType)}`)
  console.log(`reactivation focus:     ${getReactivationFocus(categoryName, contentType)}`)

  // 1 — Initial
  const initial = await writeOutreachEmail({ ...sample, category: categoryName, content_type: contentType })
  hr('1. INITIAL EMAIL')
  console.log(`SUBJECT: ${initial.subject}\n`)
  console.log(initial.body)
  console.log(`\n[words before sign-off: ${words(initial.body)}]`)

  const business = {
    businessName: sample.business_name,
    category: categoryName,
    suburb: sample.suburb,
    city: sample.city,
    website: sample.website,
    description: sample.description,
    services: sample.services,
    notes: '',
    contentType,
  }

  const history: FollowUpThreadEmail[] = [
    { type: 'initial_pitch', subject: initial.subject, body: initial.body },
  ]

  const stages = [
    { type: 'follow_up_1' as const, label: '2. FOLLOW-UP 1 (day 7)' },
    { type: 'follow_up_2' as const, label: '3. FOLLOW-UP 2 (day 14)' },
    { type: 'follow_up_3' as const, label: '4. FOLLOW-UP 3 (day 21)' },
  ]

  for (const stage of stages) {
    const fu = await generateFollowUpEmail(stage.type, business, initial.subject, [...history])
    hr(stage.label)
    console.log(`SUBJECT: ${fu.subject}\n`)
    console.log(fu.body)
    console.log(`\n[source: ${fu.source}] [words before sign-off: ${words(fu.body)}]`)
    history.push({ type: stage.type, subject: fu.subject, body: fu.body })
  }

  // 5 — Reactivation
  const reactivation = await writeReactivationEmail({
    business_name: sample.business_name,
    category: categoryName,
    suburb: sample.suburb,
    city: sample.city,
    content_type: contentType,
  })
  hr('5. REACTIVATION EMAIL (day 90+)')
  console.log(`SUBJECT: ${reactivation.subject}\n`)
  console.log(reactivation.body)
  console.log(`\n[words before sign-off: ${words(reactivation.body)}]`)
}

main().catch((e) => { console.error(e); process.exit(1) })
