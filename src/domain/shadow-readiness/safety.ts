import type { ShadowSafetyRequest } from './types'

const DISALLOWED_TRUE_GATES = [
  'ORCHESTRATOR_ENABLED',
  'OUTREACH_SEND_ENABLED',
  'HOSTINGER_MUTATIONS_ENABLED',
  'FINDER_SCHEDULE_ENABLED',
] as const

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

export interface ShadowSafetyState {
  target: ShadowSafetyRequest['target']
  shadowEnabled: true
  executionEnabled: false
  sendEnabled: false
  hostingerMutationsEnabled: false
  finderScheduleEnabled: false
  observabilityWriteEnabled: boolean
  productionReadsAcknowledged: boolean
}

/**
 * The single fail-closed runtime assertion for every shadow entry point.
 * A production-read acknowledgement authorizes reads only and never relaxes
 * execution, provider, Finder, or mutation gates.
 */
export function assertShadowSafeExecution(
  request: ShadowSafetyRequest,
  environment: NodeJS.ProcessEnv = process.env,
): ShadowSafetyState {
  if (!isTrue(environment.ORCHESTRATOR_SHADOW)) {
    throw new Error('Shadow execution is disabled: ORCHESTRATOR_SHADOW=true is required.')
  }
  for (const gate of DISALLOWED_TRUE_GATES) {
    if (isTrue(environment[gate])) throw new Error(`Unsafe shadow configuration: ${gate} must be false.`)
  }
  const productionReadsAcknowledged = isTrue(environment.V2_SHADOW_ALLOW_PRODUCTION_READS)
    && request.productionReadAcknowledged === true
  if (request.target === 'v1-production-readonly' && !productionReadsAcknowledged) {
    throw new Error('Production-like shadow reads require V2_SHADOW_ALLOW_PRODUCTION_READS=true and explicit command acknowledgement.')
  }
  return {
    target: request.target,
    shadowEnabled: true,
    executionEnabled: false,
    sendEnabled: false,
    hostingerMutationsEnabled: false,
    finderScheduleEnabled: false,
    observabilityWriteEnabled: isTrue(environment.SHADOW_OBSERVABILITY_WRITE_ENABLED),
    productionReadsAcknowledged,
  }
}
