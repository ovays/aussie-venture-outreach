import assert from 'node:assert/strict'
import { createServerClient } from '@supabase/ssr'
import { assertV2SupabaseTarget } from '../src/lib/v2-runtime-safety'

async function main() {
  assertV2SupabaseTarget()
  const email = process.env.V2_BOOTSTRAP_ADMIN_EMAIL
  const password = process.env.V2_BOOTSTRAP_ADMIN_PASSWORD
  assert(email && password, 'Disposable V2 admin credentials are required')

  const cookieJar = new Map<string, string>()
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => cookies.forEach(({ name, value }) => cookieJar.set(name, value)),
      },
    },
  )
  const { error } = await auth.auth.signInWithPassword({ email, password })
  assert.ifError(error)
  const cookieHeader = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ')
  assert(cookieHeader)

  const paths = [
    '/dashboard',
    '/dashboard/leads',
    '/dashboard/lifecycle',
    '/dashboard/pipeline',
    '/dashboard/email-log',
    '/dashboard/email-report',
    '/dashboard/settings',
    '/dashboard/settings/ai',
    '/dashboard/admin/data-quality',
    '/dashboard/admin',
  ]
  const baseUrl = process.env.V2_APP_BASE_URL ?? 'http://127.0.0.1:3005'
  const results: Record<string, number> = {}
  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { cookie: cookieHeader },
      redirect: 'manual',
    })
    results[path] = response.status
    assert.equal(response.status, 200, `${path} returned ${response.status}`)
    const body = await response.text()
    assert(!body.includes('Application error'), `${path} rendered an application error`)
  }

  console.log(JSON.stringify({ result: 'V2_MAIN_PAGE_HTTP_SMOKE_PASS', routes: results }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
