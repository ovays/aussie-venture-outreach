import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

import { writeOutreachEmail } from '@/ai/workflows'
import { resolveContentType } from '@/lib/content-type'

const SAMPLES = [
  { business_name: 'Cedar & Coal', category: 'Halal Restaurants', suburb: 'Lakemba', city: 'Sydney', description: 'Lebanese charcoal cooking centred on a custom open-fire grill.', services: 'Dine-in and group bookings' },
  { business_name: 'Cornerstone Coffee Lab', category: 'Cafes', suburb: 'Marrickville', city: 'Sydney', description: 'Small-batch coffee roasted on site behind the cafe.', services: 'Breakfast and house-roasted coffee' },
  { business_name: 'Honeycomb Patisserie', category: 'Bakeries / Dessert Shops', suburb: 'Parramatta', city: 'Sydney', description: 'Pastries are finished in an open kitchen visible from the dining room.', services: 'Pastries, cakes and coffee' },
  { business_name: 'The Quay House', category: 'Hotels / Resorts', suburb: 'Woolloomooloo', city: 'Sydney', description: 'A waterfront hotel in a converted finger wharf.', services: 'Rooms and harbour-view suites' },
  { business_name: 'Paperbark Retreat', category: 'Hotels / Resorts', suburb: 'Jervis Bay', city: 'Shoalhaven', description: 'Tented accommodation set among paperbark trees.', services: 'Accommodation and breakfast' },
  { business_name: 'Cipher Rooms', category: 'Escape Rooms', suburb: 'Newtown', city: 'Sydney', description: 'Four story-led escape rooms run at the same time.', services: 'Private sessions for groups' },
  { business_name: 'Volt Raceway', category: 'Go Karting', suburb: 'Moore Park', city: 'Sydney', description: 'Electric karts race across a two-level indoor track.', services: 'Race sessions and group bookings' },
  { business_name: 'Tenpin Social', category: 'Bowling', suburb: 'Castle Hill', city: 'Sydney', description: 'A 20-lane bowling venue with late-night sessions.', services: 'Bowling and group bookings' },
  { business_name: 'Puttworks', category: 'Mini Golf', suburb: 'Alexandria', city: 'Sydney', description: 'An 18-hole indoor course themed around Sydney landmarks.', services: 'Mini golf sessions' },
  { business_name: 'Replay Arcade', category: 'Arcades', suburb: 'Chatswood', city: 'Sydney', description: 'The floor mixes restored 1980s cabinets with current rhythm games.', services: 'Arcade play cards' },
  { business_name: 'Summit Yard', category: 'Climbing Gyms', suburb: 'St Peters', city: 'Sydney', description: 'The gym has both bouldering areas and full-height rope walls.', services: 'Casual entry and classes' },
  { business_name: 'Free Roam VR', category: 'VR Experiences', suburb: 'Burwood', city: 'Sydney', description: 'Players move together through a warehouse-scale wireless VR arena.', services: 'Team VR sessions' },
  { business_name: 'Airborne', category: 'Trampoline Parks', suburb: 'Penrith', city: 'Sydney', description: 'A trampoline venue with a dedicated ninja course.', services: 'General sessions and parties' },
  { business_name: 'Harbour After Dark', category: 'Cruises', suburb: 'Circular Quay', city: 'Sydney', description: 'A small-group sunset cruise timed around the harbour lights.', services: 'Evening harbour cruises' },
  { business_name: 'Saltwater Stories', category: 'Tour Operators', suburb: 'La Perouse', city: 'Sydney', description: 'Guided coastal walks led by Aboriginal educators.', services: 'Small-group cultural walks' },
  { business_name: 'Still House Bathing', category: 'Spas / Massage Studios', suburb: 'Surry Hills', city: 'Sydney', description: 'A quiet bathhouse built around hot and cold communal bathing.', services: 'Bathing sessions and massage' },
  { business_name: 'Studio Gloss', category: 'Nail Salons', suburb: 'Melbourne CBD', city: 'Melbourne', description: 'The studio specialises in detailed hand-painted nail art.', services: 'Manicures and nail art' },
  { business_name: 'Curl Assembly', category: 'Hair Salons', suburb: 'Fortitude Valley', city: 'Brisbane', description: 'A salon focused on cutting and styling naturally curly hair.', services: 'Cuts, styling and consultations' },
  { business_name: 'The Dumpling Bench', category: 'Cooking Classes', suburb: 'Haymarket', city: 'Sydney', description: 'Small classes teach guests to fold dumplings by hand.', services: 'Public and private cooking classes' },
  { business_name: 'Northside Fun Centre', category: 'Family Entertainment', suburb: 'Brookvale', city: 'Sydney', description: '', services: '' },
] as const

function countWords(body: string): number {
  return body.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
}

async function main(): Promise<void> {
  console.log(`Generating ${SAMPLES.length} initial outreach samples with the production writer.\n`)

  for (const [index, sample] of SAMPLES.entries()) {
    const contentType = resolveContentType({ name: sample.category }, sample.city)
    const email = await writeOutreachEmail({
      ...sample,
      website: '',
      content_type: contentType,
    })

    const bodyBeforeSignOff = email.body.split('Cheers,')[0].trim()
    const words = countWords(email.body)
    const questions = (bodyBeforeSignOff.match(/\?/g) ?? []).length
    const bannedHits = [
      /you(?:rs)? came up/i,
      /came up because/i,
      /thought I(?:'|’)d (?:ask|reach out)/i,
      /which is why I(?:'|’)m emailing/i,
      /at the moment/i,
      /I haven(?:'|’)t covered much/i,
      /asking a few places directly/i,
      /I came across/i,
      /I stumbled on/i,
      /I(?:'|’)ve been (?:following|looking at)/i,
      /we(?:'|’)re always looking/i,
      /stood out to me/i,
      /translates (?:really )?well/i,
      /works (?:really )?well for us/i,
      /exactly the kind/i,
      /real potential/i,
      /natural fit/i,
      /worth showing people/i,
      /stops the scroll/i,
      /deserves a wider audience/i,
      /\b(genuinely|actually|really)\b/i,
      /our audience/i,
      /\b(account|channel|platform|brand)\b/i,
      /[—–]/,
    ].filter((pattern) => pattern.test(bodyBeforeSignOff))

    const greetingCorrect = bodyBeforeSignOff.startsWith(`Hey ${sample.business_name},`)
    const inRange = words >= 70 && words <= 120

    console.log(`${index + 1}. ${sample.business_name} | ${sample.category} | ${words} words (${inRange ? 'in range' : 'OUT OF RANGE'}) | ${questions} question | ${bannedHits.length} banned phrase hits | greeting ${greetingCorrect ? 'ok' : 'WRONG'}`)
    console.log(`Subject: ${email.subject}`)
    console.log(email.body)
    console.log('\n' + '-'.repeat(72) + '\n')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
