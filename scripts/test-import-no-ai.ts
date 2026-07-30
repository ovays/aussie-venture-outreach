/**
 * Verifies that manual Add Lead and CSV import never invoke website enrichment
 * while preserving staged email-history backfill.
 *
 * Run: npm run test:import-no-ai
 */

import * as fs from 'fs'
import * as path from 'path'

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    console.error(`  ✗ ${message}`)
    failures++
  }
}

const createLeadSource = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/create-lead.ts'), 'utf8')
const manualRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/route.ts'), 'utf8')
const csvRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/import/route.ts'), 'utf8')
const creationPathSource = [createLeadSource, manualRouteSource, csvRouteSource].join('\n')

assert(
  /createLead\(supabase,/.test(manualRouteSource) && /createLead\(supabase,/.test(csvRouteSource),
  'manual and CSV routes both use the shared createLead helper'
)

for (const forbidden of [
  'enrichFromWebsite',
  'fetchRawHtml',
  'extractWebsiteData',
  'extractEmailWithHaiku',
  'HAIKU_MODEL',
  'haiku',
  '@/lib/email-extraction',
  'anthropic',
]) {
  assert(!creationPathSource.includes(forbidden), `import creation path does not reference ${forbidden}`)
}

assert(/status:\s*'researched'/.test(createLeadSource), 'new leads are saved with researched status')
assert(/description:\s*null/.test(createLeadSource), 'description is saved as null')
assert(/services:\s*null/.test(createLeadSource), 'services are saved as null')
assert(/instagram_handle:\s*null/.test(createLeadSource), 'instagram_handle is saved as null')
assert(/facebook_url:\s*null/.test(createLeadSource), 'facebook_url is saved as null')
assert(/current_stage !== 'new'/.test(createLeadSource), 'staged imports remain enabled')
assert(/backfillLeadStageHistory/.test(createLeadSource), 'staged imports backfill email history')
assert(/\.from\(['"]emails['"]\)/.test(createLeadSource), 'staged imports create email history')
assert(/\.from\(['"]follow_ups['"]\)/.test(createLeadSource), 'staged imports create follow-up audit records')
assert(/\.from\(['"]activity_log['"]\)/.test(createLeadSource), 'staged imports log activity')
assert(/rollbackStagedLead/.test(createLeadSource), 'staged imports retain rollback handling')

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}

console.log('\nManual and CSV lead creation skip website enrichment and retain staged backfill.')
