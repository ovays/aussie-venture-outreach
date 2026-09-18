export const V2_CANARY_ENV = 'v2_canary'
export const V2_CANARY_WORKFLOW_TYPE = 'v2_initial_send_canary'
export const V2_CANARY_PHASE = 'initial_pitch'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CanaryEnvironment = Record<string, string | undefined>

function flag(value: string | undefined, name: string): boolean | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

export function isV2CanaryEnabled(env: CanaryEnvironment = process.env): boolean {
  return flag(env.V2_CANARY_ENABLED, 'V2_CANARY_ENABLED') === true
}

/**
 * Strict allowlist parser. Accepts a comma-separated list but rejects absent,
 * empty, malformed, duplicate, or more-than-one IDs for the first canary run.
 */
export function parseCanaryLeadIds(raw: string | null | undefined): string[] {
  const value = raw?.trim() ?? ''
  if (!value) return []
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('V2_CANARY_LEAD_IDS must not be empty.')
  const unique = [...new Set(parts.map((id) => id.toLowerCase()))]
  if (unique.length !== parts.length) throw new Error('V2_CANARY_LEAD_IDS must not contain duplicate IDs.')
  for (const id of parts) {
    if (!UUID_PATTERN.test(id)) throw new Error('V2_CANARY_LEAD_IDS contains a malformed UUID.')
  }
  return parts
}

export function readCanaryLeadIds(env: CanaryEnvironment = process.env): string[] {
  return parseCanaryLeadIds(env.V2_CANARY_LEAD_IDS)
}

export interface CanaryConfiguration {
  enabled: boolean
  reachAgentEnv: string
  leadIds: string[]
}

export function readCanaryConfiguration(env: CanaryEnvironment = process.env): CanaryConfiguration {
  const enabled = isV2CanaryEnabled(env)
  const reachAgentEnv = env.REACHAGENT_ENV?.trim() ?? ''
  const leadIds = enabled || reachAgentEnv === V2_CANARY_ENV ? readCanaryLeadIds(env) : []
  return { enabled, reachAgentEnv, leadIds }
}

/** Fail closed whenever the canary runtime is requested but the contract is not exact. */
export function assertCanaryEnvironment(env: CanaryEnvironment = process.env): void {
  const { enabled, reachAgentEnv } = readCanaryConfiguration(env)
  if (enabled) {
    if (env.NEXT_PUBLIC_REACHAGENT_RUNTIME !== 'v2') throw new Error('V2 canary requires NEXT_PUBLIC_REACHAGENT_RUNTIME=v2.')
    if (reachAgentEnv !== V2_CANARY_ENV) throw new Error('V2_CANARY_ENABLED=true requires REACHAGENT_ENV=v2_canary.')
    if (flag(env.ORCHESTRATOR_ENABLED, 'ORCHESTRATOR_ENABLED') !== true) throw new Error('V2 canary requires ORCHESTRATOR_ENABLED=true.')
    if (flag(env.ORCHESTRATOR_SHADOW, 'ORCHESTRATOR_SHADOW') === true) throw new Error('V2 canary forbids ORCHESTRATOR_SHADOW=true.')
    if (flag(env.OUTREACH_SEND_ENABLED, 'OUTREACH_SEND_ENABLED') !== true) throw new Error('V2 canary requires OUTREACH_SEND_ENABLED=true.')
    if (flag(env.TRIGGER_JOBS_ENABLED, 'TRIGGER_JOBS_ENABLED') === true) throw new Error('V2 canary forbids TRIGGER_JOBS_ENABLED=true.')
    if (flag(env.FINDER_SCHEDULE_ENABLED, 'FINDER_SCHEDULE_ENABLED') === true) throw new Error('V2 canary forbids FINDER_SCHEDULE_ENABLED=true.')
    if (flag(env.HOSTINGER_MUTATIONS_ENABLED, 'HOSTINGER_MUTATIONS_ENABLED') === true) throw new Error('V2 canary forbids HOSTINGER_MUTATIONS_ENABLED=true.')
    if (flag(env.SHADOW_OBSERVABILITY_WRITE_ENABLED, 'SHADOW_OBSERVABILITY_WRITE_ENABLED') === true) throw new Error('V2 canary forbids SHADOW_OBSERVABILITY_WRITE_ENABLED=true.')
    if (flag(env.V2_SHADOW_ALLOW_PRODUCTION_READS, 'V2_SHADOW_ALLOW_PRODUCTION_READS') === true) throw new Error('V2 canary forbids V2_SHADOW_ALLOW_PRODUCTION_READS=true.')
  } else if (reachAgentEnv === V2_CANARY_ENV) {
    throw new Error('REACHAGENT_ENV=v2_canary requires V2_CANARY_ENABLED=true.')
  }
}

export function assertCanaryAllowlistLeadId(leadId: string, env: CanaryEnvironment = process.env): void {
  assertCanaryEnvironment(env)
  const ids = readCanaryLeadIds(env)
  if (ids.length !== 1) throw new Error('V2 canary requires exactly one allowlisted lead ID for the first run.')
  if (leadId.toLowerCase() !== ids[0].toLowerCase()) throw new Error('V2 canary lead ID is not allowlisted.')
}

export function assertCanaryPhase(phase: string | null | undefined): void {
  if (phase !== V2_CANARY_PHASE) {
    throw new Error(`V2 canary allows only ${V2_CANARY_PHASE}; received ${phase ?? 'no phase'}.`)
  }
}

export function assertCanaryProviderBoundary(
  params: { leadId: string; phase?: string | null },
  env: CanaryEnvironment = process.env,
): void {
  if (!isV2CanaryEnabled(env)) return
  assertCanaryEnvironment(env)
  assertCanaryAllowlistLeadId(params.leadId, env)
  assertCanaryPhase(params.phase)
}

export function assertCanarySingleRun(env: CanaryEnvironment = process.env): void {
  assertCanaryEnvironment(env)
  const ids = readCanaryLeadIds(env)
  if (ids.length !== 1) throw new Error('V2 canary first run requires exactly one lead ID.')
}
