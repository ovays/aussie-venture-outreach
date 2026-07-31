/**
 * test-reactivation-email.ts
 *
 * Dry-run generator for reactivation email copy review.
 * Calls writeReactivationEmail() with fake businesses and prints results.
 *
 * Does NOT send emails.
 * Does NOT read or write the database.
 * Does NOT run any pipeline logic.
 *
 * Run: npm run test:reactivation-email
 */

import { writeReactivationEmail } from '../src/ai/workflows'

const TEST_BUSINESSES = [
  {
    business_name: 'Al Aseel',
    category: 'Halal Restaurants',
    suburb: 'Lakemba',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    business_name: 'Kova Patisserie',
    category: 'Halal Bakeries / Dessert Shops',
    suburb: 'Surry Hills',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    business_name: 'Zeytoun',
    category: 'Halal Cafes',
    suburb: 'Newtown',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    business_name: 'Luxe Lash Studio',
    category: 'Beauty / Lash Studios',
    suburb: 'Bondi Junction',
    city: 'Sydney',
    content_type: 'visit',
  },
  {
    business_name: 'Adventure Out',
    category: 'Tour Operators',
    suburb: 'CBD',
    city: 'Sydney',
    content_type: 'remote',
  },
]

const SEP = '═'.repeat(62)
const DIV = '─'.repeat(62)

async function main() {
  console.log(SEP)
  console.log('  TEST-REACTIVATION-EMAIL  —  DRY RUN')
  console.log('  No DB reads/writes. No emails sent.')
  console.log(`  Generating ${TEST_BUSINESSES.length} deterministic sample emails`)
  console.log(SEP)
  console.log()

  let i = 0
  for (const biz of TEST_BUSINESSES) {
    i++
    console.log(SEP)
    console.log(`[${i}/${TEST_BUSINESSES.length}] ${biz.business_name}`)
    console.log(`  Category : ${biz.category}`)
    console.log(`  Location : ${biz.suburb}, ${biz.city}`)
    console.log(DIV)
    process.stdout.write('  Generating...')

    const result = await writeReactivationEmail(biz)

    process.stdout.write(' done\n\n')
    console.log(`  SUBJECT : ${result.subject}`)
    console.log()
    console.log('  BODY:')
    result.body.split('\n').forEach((line) => console.log(`  ${line}`))
    console.log()
  }

  console.log(SEP)
  console.log(`  Done. ${TEST_BUSINESSES.length} emails generated.`)
  console.log('  Review tone, wording, and naturalness above.')
  console.log(SEP)
  console.log()
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
