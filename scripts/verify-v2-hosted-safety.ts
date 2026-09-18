import { createHash } from 'node:crypto'

async function main(): Promise<void> {
  const deploymentUrl = process.env.V2_DEPLOYMENT_URL?.trim()
  const sessionCookie = process.env.V2_SMOKE_ADMIN_COOKIE?.trim()
  const expectedSupabaseRef = process.env.V2_EXPECTED_SUPABASE_PROJECT_REF?.trim().toLowerCase()
  const expectedTriggerRef = process.env.V2_EXPECTED_TRIGGER_PROJECT_REF?.trim().toLowerCase()
  const expectedVercelProject = process.env.V2_EXPECTED_VERCEL_PROJECT_NAME?.trim()
  if (!deploymentUrl || !sessionCookie || !expectedSupabaseRef || !expectedTriggerRef || !expectedVercelProject) {
    throw new Error('Set the V2 URL, admin cookie, and expected Supabase/Trigger/Vercel identifiers for hosted safety verification.')
  }
  const url = new URL('/api/admin/deployment-diagnostics', deploymentUrl)
  if (url.protocol !== 'https:') throw new Error('Hosted V2 safety verification requires HTTPS.')

  const response = await fetch(url, { headers: { Cookie: sessionCookie }, redirect: 'error' })
  if (!response.ok) throw new Error(`Hosted V2 diagnostics returned HTTP ${response.status}.`)
  const body = await response.json() as { appEnvironment?: string, runtimeIntent?: string, deploymentBranch?: string, vercelProjectName?: string, supabaseProjectRefHash?: string, triggerProjectRefHash?: string, gates?: Record<string, boolean> }
  if (!['v2_staging', 'v2_canary'].includes(body.appEnvironment ?? '')) throw new Error('Hosted diagnostics do not identify a V2 deployment environment.')
  if (body.runtimeIntent !== 'v2' || body.deploymentBranch !== 'reachagent-v2-application') throw new Error('Hosted diagnostics report incorrect V2 runtime/branch intent.')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
  if (body.supabaseProjectRefHash !== hash(expectedSupabaseRef)) throw new Error('Hosted diagnostics report the wrong V2 Supabase project.')
  if (body.triggerProjectRefHash !== hash(expectedTriggerRef)) throw new Error('Hosted diagnostics report the wrong V2 Trigger.dev project.')
  if (body.vercelProjectName !== expectedVercelProject) throw new Error('Hosted diagnostics report the wrong V2 Vercel project.')
  for (const [name, enabled] of Object.entries(body.gates ?? {})) {
    if (enabled) throw new Error(`Hosted diagnostics report unsafe enabled gate ${name}.`)
  }
  if (Object.keys(body.gates ?? {}).length !== 8) throw new Error('Hosted diagnostics did not report every required safety gate.')
  console.log('REACHAGENT_V2_HOSTED_SAFETY_PASS')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
