import type { z } from 'zod'
import { currentWorkflowTrace } from '@/lib/observability/context'
import { isCanonicalUuid } from '@/lib/uuid'
import type { AIGenerateRequest, AIGenerateResponse, AIMessage } from './AIProvider'
import type { AIWorkflow, AIWorkflowAssignment } from './configuration/AIConfiguration'
import { AIExecutionError, classifyAIError } from './errors'
import { parseStructuredOutput } from './output'
import { assertModelAllowed, assertProviderAllowed } from './provider-policy'

export const DEFAULT_AI_TIMEOUT_MS = 60_000

/**
 * Resolves the authoritative server-resolved workspace for a workflow that must
 * be explicitly workspace-scoped. The ambient workflow trace is the authority;
 * a caller may supply it explicitly for tests. Missing workspace fails closed.
 */
export function requireServerWorkspace(explicit?: string): string {
  const workspaceId = explicit ?? currentWorkflowTrace()?.workspaceId
  if (!workspaceId) {
    throw new AIExecutionError('AI_WORKSPACE_REQUIRED', 'AI execution requires a server-resolved workspace', false)
  }
  return workspaceId
}

export interface AIWorkflowExecutionInput<TSchema extends z.ZodTypeAny> {
  workflow: AIWorkflow
  promptVersion: string
  /** Authoritative server-resolved workspace. Falls back to the ambient workflow trace. */
  workspaceId?: string
  system?: string
  messages: readonly AIMessage[]
  /** Schema for machine-consumed outputs. Omitted for free-text workflows. */
  outputSchema?: TSchema
  maxTokens: number
  timeoutMs?: number
  contextSize?: number
  contextTruncated?: boolean
  correlationId?: string
  idempotencyKey?: string
}

export interface AIWorkflowExecutionResult<T> {
  output: T
  rawText: string
  provider: string | null
  model: string | null
  promptVersion: string
  schemaValidated: boolean
  contextSize: number | null
  contextTruncated: boolean
  retryCount: number
}

export interface AIHarnessDependencies {
  /** Resolves provider/model for a workflow (defaults to the config service). */
  resolve?: (workflow: AIWorkflow) => Promise<AIWorkflowAssignment>
  /** Provider-neutral generation (defaults to the central registry). */
  generate?: (workflow: AIWorkflow, request: Omit<AIGenerateRequest, 'model' | 'workflow'>) => Promise<AIGenerateResponse>
  now?: () => number
}

export type AIExecuteWorkflow = <TSchema extends z.ZodTypeAny>(
  input: AIWorkflowExecutionInput<TSchema>,
) => Promise<AIWorkflowExecutionResult<z.infer<TSchema>>>

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AIExecutionError('AI_TIMEOUT', `AI request exceeded ${timeoutMs}ms`, true))
    }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Builds the single AI execution boundary. It is advisory: it produces text,
 * research and drafts, never authority for workspace, suppression, ownership,
 * sending, quota or any security decision.
 */
export function createAIHarness(dependencies: AIHarnessDependencies = {}): AIExecuteWorkflow {
  const execute = async <TSchema extends z.ZodTypeAny>(
    input: AIWorkflowExecutionInput<TSchema>,
  ): Promise<AIWorkflowExecutionResult<z.infer<TSchema>>> => {
    const startedAt = (dependencies.now ?? Date.now)()
    const workspaceId = input.workspaceId ?? currentWorkflowTrace()?.workspaceId

    if (workspaceId !== undefined && !isCanonicalUuid(workspaceId)) {
      throw new AIExecutionError('AI_WORKSPACE_MISMATCH', 'AI execution received a non-canonical workspace id', false)
    }

    // Provider/model allowlist is validated here, before any SDK/HTTP call,
    // using the same configuration the registry consumes.
    const resolve = dependencies.resolve ?? (await resolveDefault())
    const assignment = await resolve(input.workflow)
    assertProviderAllowed(assignment.providerKey)
    assertModelAllowed(assignment.modelKey)

    const request: Omit<AIGenerateRequest, 'model' | 'workflow'> = {
      maxTokens: input.maxTokens,
      ...(input.system !== undefined ? { system: input.system } : {}),
      messages: input.messages,
      ...(workspaceId ? { workspaceId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      metadata: {
        prompt_version: input.promptVersion,
        context_size_chars: input.contextSize ?? null,
        context_truncated: input.contextTruncated ?? false,
        correlation_id: input.correlationId ?? null,
        schema_validation_status: 'pending',
      },
    }

    const generate = dependencies.generate ?? (await generateDefault())
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS)

    let response: AIGenerateResponse
    try {
      response = await withTimeout(generate(input.workflow, request), timeoutMs)
    } catch (error) {
      const meta = classifyAIError(error)
      throw error instanceof AIExecutionError ? error : new AIExecutionError(meta.code, safeMessage(error), meta.retryable)
    }

    const rawText = response.text ?? ''
    const schemaValidated = input.outputSchema !== undefined
    const output = input.outputSchema
      ? parseStructuredOutput(input.outputSchema, rawText)
      : (rawText as z.infer<TSchema>)

    return {
      output,
      rawText,
      provider: assignment.providerKey,
      model: assignment.modelKey,
      promptVersion: input.promptVersion,
      schemaValidated,
      contextSize: input.contextSize ?? null,
      contextTruncated: input.contextTruncated ?? false,
      retryCount: response.retryCount ?? 0,
    }
  }

  return execute
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

// Lazy wiring so the harness module stays free of `server-only`/Supabase
// imports and can be unit-tested with plain tsx. Production callers use the
// singleton below, which dynamically resolves the central runtime.
async function resolveDefault(): Promise<(workflow: AIWorkflow) => Promise<AIWorkflowAssignment>> {
  const { aiConfigurationService } = await import('./AIRuntime')
  return (workflow) => aiConfigurationService.getWorkflowAssignment(workflow)
}

type GenerateFn = NonNullable<AIHarnessDependencies['generate']>

async function generateDefault(): Promise<GenerateFn> {
  const { aiRegistry } = await import('./AIRuntime')
  return (workflow, request) => aiRegistry.generate(workflow, request)
}
