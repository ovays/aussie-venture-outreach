/**
 * scripts/test-destructive-routes-require-admin.ts
 *
 * Verifies the production-readiness-audit fix for a critical authorization
 * gap: src/proxy.ts only requires the 'admin' role for paths under
 * /api/admin and /dashboard/admin. POST /api/reset (wipes emails, dm_queue,
 * follow_ups, activity_log, deals, and leads — the entire dataset) and
 * DELETE /api/leads/delete-by-date (mass-deletes every lead created on an
 * arbitrary date) are NOT under /api/admin, so before this fix any
 * authenticated 'member'-role user could call them directly — and the
 * buttons that trigger them live on the normal (non-admin-gated) Settings
 * page, so this was reachable through the UI, not just by crafting a
 * request by hand.
 *
 * Both routes use createServiceClient() (bypasses RLS) and the RLS policies
 * on these tables already grant full access to any authenticated user
 * (supabase/migrations/001_initial_schema.sql), so the route-level check
 * added here is the ONLY place this can be enforced.
 *
 * This is a static source check (consistent with this repo's existing
 * convention — see scripts/test-resend-duplicate-protection.ts — for
 * verifying a Next.js route handler's control flow without spinning up a
 * real request/cookie/session context).
 *
 * Run: npx tsx scripts/test-destructive-routes-require-admin.ts
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

function checkRouteRequiresAdmin(relPath: string, exportedFn: string) {
  const src = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')

  const importsGuard = /import\s*{[^}]*requireApiAdmin[^}]*}\s*from\s*'@\/lib\/auth'/.test(src)
  assert(importsGuard, `${relPath} imports requireApiAdmin from '@/lib/auth'`)

  const importsErrorCheck = /import\s*{[^}]*isAuthErrorResponse[^}]*}\s*from\s*'@\/lib\/auth'/.test(src)
  assert(importsErrorCheck, `${relPath} imports isAuthErrorResponse from '@/lib/auth'`)

  const fnIdx = src.indexOf(`export async function ${exportedFn}(`)
  assert(fnIdx !== -1, `${relPath} still exports ${exportedFn}()`)

  const guardIdx = src.indexOf('await requireApiAdmin()', fnIdx)
  const earlyReturnIdx = src.indexOf('if (isAuthErrorResponse(auth)) return auth', fnIdx)

  assert(guardIdx !== -1 && guardIdx > fnIdx, `${exportedFn}() in ${relPath} calls requireApiAdmin()`)
  assert(earlyReturnIdx !== -1 && earlyReturnIdx > guardIdx, `${exportedFn}() in ${relPath} returns immediately when the caller is not an admin`)

  // The guard must run before any destructive DB call in this handler.
  const firstDeleteIdx = src.indexOf('.delete()', earlyReturnIdx)
  if (firstDeleteIdx !== -1) {
    assert(earlyReturnIdx < firstDeleteIdx, `The admin check in ${exportedFn}() runs before any .delete() call`)
  }
}

async function main() {
  console.log(SEP)
  console.log('  TEST:DESTRUCTIVE-ROUTES-REQUIRE-ADMIN')
  console.log(SEP)

  console.log('\n  1. POST /api/reset requires admin')
  checkRouteRequiresAdmin('src/app/api/reset/route.ts', 'POST')

  console.log('\n  2. DELETE /api/leads/delete-by-date requires admin')
  checkRouteRequiresAdmin('src/app/api/leads/delete-by-date/route.ts', 'DELETE')

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
