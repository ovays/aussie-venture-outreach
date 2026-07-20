/**
 * scripts/test-migration-030-lead-source-backfill.ts
 *
 * Verifies the production-readiness-audit fix for
 * supabase/migrations/021_add_lead_source.sql: that file contains only a
 * comment ("Track how a lead entered the system...") and never actually
 * runs `ALTER TABLE leads ADD COLUMN source`. Production works today only
 * because the column was very likely added out-of-band (e.g. via the
 * Supabase SQL editor) — but any environment rebuilt by replaying the
 * migration files from scratch (a fresh staging DB, disaster recovery,
 * `supabase db reset`) would be missing `leads.source`, which
 * src/app/api/leads/route.ts (manual lead creation) and agents/sender.ts
 * (`.neq('leads.source', 'manual')` filter on the initial-outreach send
 * stage) both depend on.
 *
 * Migration 030 adds the column with `IF NOT EXISTS`, so it is a no-op
 * against production (column already present) while fixing every
 * environment rebuilt from these files.
 *
 * Run: npx tsx scripts/test-migration-030-lead-source-backfill.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const SEP = '═'.repeat(60)
let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

async function main() {
  console.log(SEP)
  console.log('  TEST:MIGRATION-030-LEAD-SOURCE-BACKFILL')
  console.log(SEP)

  console.log('\n  1. Migration 021 is confirmed to contain no DDL (documents the gap this fix closes)')
  {
    const src021 = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/021_add_lead_source.sql'), 'utf8')
    const hasAlterTable = /ALTER TABLE/i.test(src021)
    assert(!hasAlterTable, '021_add_lead_source.sql still contains no ALTER TABLE — confirms migration 030 is the one actually creating the column', hasAlterTable ? 'unexpected ALTER TABLE found — is migration 030 now redundant?' : undefined)
  }

  console.log('\n  2. Migration 030 adds leads.source idempotently')
  {
    const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations')
    const files = fs.readdirSync(migrationsDir)
    const file030 = files.find((f) => f.startsWith('030_'))
    assert(!!file030, 'A migration numbered 030 exists in supabase/migrations/')

    if (file030) {
      const src = fs.readFileSync(path.join(migrationsDir, file030), 'utf8')
      assert(/ALTER TABLE\s+leads/i.test(src), '030 alters the leads table')
      assert(/ADD COLUMN IF NOT EXISTS\s+source/i.test(src), '030 adds the source column using IF NOT EXISTS (safe no-op if already present in production)')
    }
  }

  console.log('\n  3. Every dependent code path referencing leads.source still exists (fix targets a real, live dependency)')
  {
    const senderSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/sender.ts'), 'utf8')
    const leadsRouteSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/route.ts'), 'utf8')

    assert(/leads\.source/.test(senderSrc), "agents/sender.ts still filters on leads.source (would break if the column were ever actually missing)")
    assert(/source:\s*'manual'/.test(leadsRouteSrc), "src/app/api/leads/route.ts still inserts source: 'manual' on manual lead creation")
  }

  console.log('\n' + SEP)
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
  console.log(SEP)

  if (failed > 0) {
    console.error('\n  ✗ Some tests failed — review output above.')
    process.exit(1)
  } else {
    console.log('\n  ✓ All tests passed.')
  }
}

main()
