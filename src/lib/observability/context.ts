import { AsyncLocalStorage } from 'node:async_hooks'

export interface WorkflowTraceContext {
  workflowRunId: string
  workflowStepId?: string
}

const traceStorage = new AsyncLocalStorage<WorkflowTraceContext>()

export function currentWorkflowTrace(): WorkflowTraceContext | undefined {
  return traceStorage.getStore()
}

export function withWorkflowTrace<T>(context: WorkflowTraceContext, work: () => T): T {
  return traceStorage.run(context, work)
}
