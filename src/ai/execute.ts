import { createAIHarness, type AIExecuteWorkflow } from './harness'

/**
 * The single production AI execution boundary. Workflows call this instead of
 * reaching the provider registry directly, so provider/model allowlisting,
 * finite timeouts, structured-output validation, prompt versioning and quota
 * scoping are applied at exactly one place.
 *
 * It lazily resolves the central configuration service and registry, so this
 * module stays free of `server-only`/Supabase imports and remains unit-testable.
 */
export const executeAIWorkflow: AIExecuteWorkflow = createAIHarness()
