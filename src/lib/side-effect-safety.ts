import { assertV2SupabaseTarget, isReachAgentV2 } from './v2-runtime-safety'

function enabled(name: 'OUTREACH_SEND_ENABLED' | 'TRIGGER_JOBS_ENABLED' | 'HOSTINGER_MUTATIONS_ENABLED' | 'FINDER_SCHEDULE_ENABLED'): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true'
}

function assertEnabled(
  name: 'OUTREACH_SEND_ENABLED' | 'TRIGGER_JOBS_ENABLED' | 'HOSTINGER_MUTATIONS_ENABLED' | 'FINDER_SCHEDULE_ENABLED',
  operation: string,
): void {
  if (!isReachAgentV2()) return
  assertV2SupabaseTarget()
  if (!enabled(name)) throw new Error(`ReachAgent V2 blocked ${operation}: ${name}=true is required.`)
}

export function assertOutreachSendEnabled(operation = 'outreach send'): void {
  assertEnabled('OUTREACH_SEND_ENABLED', operation)
}

export function assertTriggerJobsEnabled(operation = 'Trigger.dev job'): void {
  assertEnabled('TRIGGER_JOBS_ENABLED', operation)
}

export function assertHostingerMutationsEnabled(operation = 'Hostinger mutation'): void {
  assertEnabled('HOSTINGER_MUTATIONS_ENABLED', operation)
}

export function assertFinderScheduleEnabled(operation = 'scheduled Finder run'): void {
  assertEnabled('FINDER_SCHEDULE_ENABLED', operation)
}
