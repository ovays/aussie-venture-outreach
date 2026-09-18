import type { DecisionAction } from '@/domain/decision-engine'
import type { ExecutorRegistry, LeadExecutor, OrchestrationStopCause } from './types'

export const EXECUTABLE_ACTIONS = [
  'RESEARCH', 'GENERATE_INITIAL', 'SEND_INITIAL', 'SEND_FOLLOWUP_1',
  'SEND_FOLLOWUP_2', 'SEND_FOLLOWUP_3', 'REACTIVATE', 'MARK_DEAD',
] as const satisfies readonly DecisionAction[]

export const STOP_ACTIONS: Readonly<Partial<Record<DecisionAction, OrchestrationStopCause>>> = {
  WAIT: 'WAIT',
  STOP: 'STOP',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  HANDLE_REPLY: 'HANDOFF_REPLY',
}

export interface ExecutorAdapters {
  research: LeadExecutor
  initialContent: LeadExecutor
  initialSend: LeadExecutor
  followUp: LeadExecutor
  reactivation: LeadExecutor
  lifecycle: LeadExecutor
}

export function createExecutorRegistry(adapters: ExecutorAdapters): ExecutorRegistry {
  return {
    RESEARCH: adapters.research,
    GENERATE_INITIAL: adapters.initialContent,
    SEND_INITIAL: adapters.initialSend,
    SEND_FOLLOWUP_1: adapters.followUp,
    SEND_FOLLOWUP_2: adapters.followUp,
    SEND_FOLLOWUP_3: adapters.followUp,
    REACTIVATE: adapters.reactivation,
    MARK_DEAD: adapters.lifecycle,
  }
}
