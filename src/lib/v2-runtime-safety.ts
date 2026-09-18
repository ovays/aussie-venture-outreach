import { parseCanaryLeadIds } from './v2-canary-safety'

export const V2_RUNTIME = 'v2'
export const V2_DEPLOYMENT_BRANCH = 'reachagent-v2-application'
export const KNOWN_V1_SUPABASE_PROJECT_REF = 'obppfnujusqiwjhwzosv'
export const KNOWN_V1_TRIGGER_PROJECT_REF = 'proj_pkyxowcjibwfokooeqaw'

const LOCAL_SUPABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const V2_ENVIRONMENTS = new Set(['local_v2', 'v2_staging', 'v2_canary'])
const REMOTE_V2_ENVIRONMENTS = new Set(['v2_staging', 'v2_canary'])

export const V2_IRREVERSIBLE_GATES = [
  'ORCHESTRATOR_ENABLED',
  'ORCHESTRATOR_SHADOW',
  'OUTREACH_SEND_ENABLED',
  'TRIGGER_JOBS_ENABLED',
  'FINDER_SCHEDULE_ENABLED',
  'HOSTINGER_MUTATIONS_ENABLED',
  'SHADOW_OBSERVABILITY_WRITE_ENABLED',
  'V2_SHADOW_ALLOW_PRODUCTION_READS',
] as const

export const V2_FORBIDDEN_PRODUCTION_ALIASES = [
  'TRIGGER_SECRET_KEY_PROD',
  'TRIGGER_PROJECT_ID',
  'SUPABASE_URL_PROD',
  'NEXT_PUBLIC_SUPABASE_URL_PROD',
  'SUPABASE_SERVICE_ROLE_KEY_PROD',
  'V1_SUPABASE_URL',
  'V1_SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_EMAIL',
  'ENABLE_SENDER',
  'ENABLE_FOLLOWUP',
  'TRIGGER_ACCESS_TOKEN',
  'RESEND_API_KEY_Gmail',
] as const

type Environment = Record<string, string | undefined>

function nonEmpty(environment: Environment, name: string): string | null {
  return environment[name]?.trim() || null
}

export function supabaseProjectRef(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname)
  return match?.[1]?.toLowerCase() ?? null
}

export function isLocalSupabaseUrl(rawUrl: string): boolean {
  try {
    return LOCAL_SUPABASE_HOSTS.has(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

export function readV2GateState(environment: Environment = process.env): Record<(typeof V2_IRREVERSIBLE_GATES)[number], boolean> {
  return Object.fromEntries(V2_IRREVERSIBLE_GATES.map((name) => [name, environment[name]?.trim().toLowerCase() === 'true'])) as Record<(typeof V2_IRREVERSIBLE_GATES)[number], boolean>
}

export function assertV2SupabaseTarget(environment: Environment = process.env): void {
  if (environment.NEXT_PUBLIC_REACHAGENT_RUNTIME !== V2_RUNTIME) {
    throw new Error('ReachAgent V2 requires NEXT_PUBLIC_REACHAGENT_RUNTIME=v2.')
  }

  const rawUrl = nonEmpty(environment, 'NEXT_PUBLIC_SUPABASE_URL')
  if (!rawUrl) throw new Error('ReachAgent V2 requires NEXT_PUBLIC_SUPABASE_URL.')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('ReachAgent V2 NEXT_PUBLIC_SUPABASE_URL is invalid.')
  }

  const actualProjectRef = supabaseProjectRef(rawUrl)
  if (actualProjectRef === KNOWN_V1_SUPABASE_PROJECT_REF) {
    throw new Error('ReachAgent V2 refuses to use the known V1 production Supabase project.')
  }

  if (LOCAL_SUPABASE_HOSTS.has(url.hostname)) return

  const expectedProjectRef = nonEmpty(environment, 'NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF')?.toLowerCase()
  if (expectedProjectRef && !/^[a-z0-9]{20}$/.test(expectedProjectRef)) {
    throw new Error('Remote ReachAgent V2 Supabase project reference has an invalid shape.')
  }
  if (!expectedProjectRef || actualProjectRef !== expectedProjectRef) {
    throw new Error('Remote ReachAgent V2 Supabase requires an explicit matching V2 project reference.')
  }
}

export function assertV2TriggerDeploymentTarget(environment: Environment = process.env): void {
  if (environment.NEXT_PUBLIC_REACHAGENT_RUNTIME !== V2_RUNTIME) {
    throw new Error('ReachAgent V2 Trigger.dev deployment requires V2 runtime intent.')
  }
  const projectRef = nonEmpty(environment, 'TRIGGER_V2_PROJECT_REF')
  if (!projectRef) throw new Error('ReachAgent V2 Trigger.dev deployment requires an explicit V2 project reference.')
  if (!/^proj_[a-z0-9]+$/i.test(projectRef)) throw new Error('ReachAgent V2 Trigger.dev project reference has an invalid shape.')
  if (projectRef === KNOWN_V1_TRIGGER_PROJECT_REF) {
    throw new Error('ReachAgent V2 refuses to target the known V1 production Trigger.dev project.')
  }
  if (nonEmpty(environment, 'TRIGGER_SECRET_KEY_PROD')) {
    throw new Error('ReachAgent V2 refuses the production Trigger.dev secret alias.')
  }
}

function validateV2CanaryGateCombination(environment: Environment): void {
  if (environment.V2_CANARY_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new Error('REACHAGENT_ENV=v2_canary requires V2_CANARY_ENABLED=true.')
  }
  const leadIds = parseCanaryLeadIds(environment.V2_CANARY_LEAD_IDS)
  if (leadIds.length !== 1) {
    throw new Error('REACHAGENT_ENV=v2_canary requires exactly one V2_CANARY_LEAD_IDS UUID.')
  }

  const mustBeTrue = new Set(['ORCHESTRATOR_ENABLED', 'OUTREACH_SEND_ENABLED'])
  for (const name of V2_IRREVERSIBLE_GATES) {
    const value = environment[name]?.trim().toLowerCase()
    if (mustBeTrue.has(name)) {
      if (value !== 'true') throw new Error(`REACHAGENT_ENV=v2_canary requires ${name}=true.`)
    } else if (value === 'true') {
      throw new Error(`Unsafe ReachAgent V2 canary gate: ${name} must remain false.`)
    } else if (value !== 'false') {
      throw new Error(`Remote ReachAgent V2 canary requires explicit ${name}=false.`)
    }
  }
}

export function validateV2DeploymentEnvironment(environment: Environment = process.env): void {
  const reachAgentEnvironment = nonEmpty(environment, 'REACHAGENT_ENV')
  if (!reachAgentEnvironment || !V2_ENVIRONMENTS.has(reachAgentEnvironment)) {
    throw new Error('ReachAgent V2 requires REACHAGENT_ENV=local_v2, v2_staging, or v2_canary.')
  }

  assertV2SupabaseTarget(environment)

  if (reachAgentEnvironment === 'v2_canary') {
    validateV2CanaryGateCombination(environment)
  } else {
    for (const name of V2_IRREVERSIBLE_GATES) {
      const value = environment[name]?.trim().toLowerCase()
      if (value === 'true') throw new Error(`Unsafe ReachAgent V2 deployment gate: ${name} must remain false.`)
      if (REMOTE_V2_ENVIRONMENTS.has(reachAgentEnvironment) && value !== 'false') {
        throw new Error(`Remote ReachAgent V2 deployment requires explicit ${name}=false.`)
      }
    }
  }

  for (const name of V2_FORBIDDEN_PRODUCTION_ALIASES) {
    if (nonEmpty(environment, name)) throw new Error(`ReachAgent V2 forbids production credential alias ${name}.`)
  }

  if (['V2_SHADOW_SUPABASE_URL', 'V2_SHADOW_SUPABASE_READ_KEY', 'V2_SHADOW_SUPABASE_PUBLISHABLE_KEY',
    'V2_SHADOW_SUPABASE_ACCESS_TOKEN', 'V2_SHADOW_SUPABASE_SCHEMA'].some((name) => nonEmpty(environment, name))) {
    throw new Error('Initial ReachAgent V2 deployment forbids all production-shadow credentials.')
  }

  const major = Number.parseInt((environment.REACHAGENT_NODE_VERSION ?? process.versions.node).split('.')[0] ?? '', 10)
  if (major !== 24) throw new Error('ReachAgent V2 deployment requires Node.js 24.x.')

  if (nonEmpty(environment, 'TRIGGER_SECRET_KEY') || nonEmpty(environment, 'TRIGGER_V2_PROJECT_REF')) {
    assertV2TriggerDeploymentTarget(environment)
  }
  if (!REMOTE_V2_ENVIRONMENTS.has(reachAgentEnvironment)) return

  for (const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'TRIGGER_SECRET_KEY']) {
    if (!nonEmpty(environment, name)) throw new Error(`Remote ReachAgent V2 deployment requires ${name}.`)
  }
  assertV2TriggerDeploymentTarget(environment)

  if (nonEmpty(environment, 'V2_DEPLOYMENT_BRANCH') !== V2_DEPLOYMENT_BRANCH) {
    throw new Error(`Remote ReachAgent V2 deployment requires V2_DEPLOYMENT_BRANCH=${V2_DEPLOYMENT_BRANCH}.`)
  }
  const providerBranch = nonEmpty(environment, 'VERCEL_GIT_COMMIT_REF')
  if (providerBranch && providerBranch !== V2_DEPLOYMENT_BRANCH) {
    throw new Error('ReachAgent V2 refuses a Vercel build from a non-V2 branch.')
  }
  const vercelProjectName = nonEmpty(environment, 'V2_VERCEL_PROJECT_NAME')
  if (!vercelProjectName) {
    throw new Error('Remote ReachAgent V2 deployment requires an explicit V2_VERCEL_PROJECT_NAME.')
  }
  if (!vercelProjectName.toLowerCase().includes('v2')) {
    throw new Error('ReachAgent V2 Vercel project name must explicitly identify V2.')
  }

  const appUrl = nonEmpty(environment, 'NEXT_PUBLIC_APP_URL')
  if (!appUrl) throw new Error('Remote ReachAgent V2 deployment requires NEXT_PUBLIC_APP_URL.')
  try {
    const hostname = new URL(appUrl).hostname
    if (LOCAL_SUPABASE_HOSTS.has(hostname)) throw new Error('local')
  } catch {
    throw new Error('Remote ReachAgent V2 NEXT_PUBLIC_APP_URL must be a valid non-local URL.')
  }

  const genericSupabaseUrl = nonEmpty(environment, 'SUPABASE_URL')
  if (genericSupabaseUrl && genericSupabaseUrl !== nonEmpty(environment, 'NEXT_PUBLIC_SUPABASE_URL')) {
    throw new Error('ReachAgent V2 refuses an ambiguous SUPABASE_URL target.')
  }
}

export function isReachAgentV2(environment: Environment = process.env): boolean {
  return environment.NEXT_PUBLIC_REACHAGENT_RUNTIME === V2_RUNTIME
}
