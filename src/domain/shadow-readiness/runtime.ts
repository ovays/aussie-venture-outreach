import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadDecisionContexts } from '@/domain/decision-engine'
import { observability } from '@/lib/observability/service'
import type { Database } from '@/types/database'
import { evaluateShadowBatch, summarizeShadowResults } from './batch'
import { loadDerivedDecisionContexts, selectDerivedShadowLeadIds } from './derived-context-loader'
import { createReadOnlySupabaseClient, type ReadOnlyClientAudit } from './read-only-client'
import { assertShadowSafeExecution } from './safety'
import { selectShadowLeadIds, type ShadowSampleSelector } from './selector'
import type { ShadowComparisonResult, ShadowEvaluationOutcome, ShadowSafetyRequest, ShadowTarget } from './types'
import type { ShadowDifferenceClassification } from '@/domain/decision-engine'

const KNOWN_V1_PRODUCTION_REF = 'obppfnujusqiwjhwzosv'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const PRODUCTION_SHADOW_ROLE = 'reachagent_prompt15_shadow_reader'
const PRODUCTION_SHADOW_SCHEMA = 'reachagent_prompt15_shadow'
const MAX_PRODUCTION_TOKEN_REMAINING_SECONDS = 2 * 60 * 60

function refFor(url: URL): string | null {
  return /^([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname)?.[1]?.toLowerCase() ?? null
}

export interface ShadowRuntimeClient {
  client: SupabaseClient<Database>
  audit: ReadOnlyClientAudit
  targetUrl: string
}

type JwtClaims = { role?: unknown; exp?: unknown }

function decodeJwtClaims(token: string): JwtClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Production shadow access token must be a JWT.')
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtClaims
  } catch {
    throw new Error('Production shadow access token has an invalid JWT payload.')
  }
}

export function validateProductionShadowCredentials(environment: NodeJS.ProcessEnv, now = new Date()): {
  url: string
  publishableKey: string
  accessToken: string
} {
  if (environment.V2_SHADOW_SUPABASE_READ_KEY?.trim()) {
    throw new Error('V1 production shadow mode rejects V2_SHADOW_SUPABASE_READ_KEY; use split publishable-key and access-token credentials.')
  }
  const url = environment.V2_SHADOW_SUPABASE_URL?.trim()
  const publishableKey = environment.V2_SHADOW_SUPABASE_PUBLISHABLE_KEY?.trim()
  const accessToken = environment.V2_SHADOW_SUPABASE_ACCESS_TOKEN?.trim()
  const schema = environment.V2_SHADOW_SUPABASE_SCHEMA?.trim()
  if (!url || !publishableKey || !accessToken || schema !== PRODUCTION_SHADOW_SCHEMA) {
    throw new Error(`Production-read shadow requires URL, publishable key, access token, and V2_SHADOW_SUPABASE_SCHEMA=${PRODUCTION_SHADOW_SCHEMA}.`)
  }
  if (!publishableKey.startsWith('sb_publishable_') || publishableKey.startsWith('sb_secret_') || publishableKey === 'service_role') {
    throw new Error('Production shadow API key must be an sb_publishable key.')
  }
  if (accessToken.startsWith('sb_secret_') || accessToken === 'service_role') {
    throw new Error('Production shadow access token cannot be a secret or service_role credential.')
  }
  if (publishableKey === accessToken) throw new Error('Production shadow publishable key and access token must be distinct.')
  const claims = decodeJwtClaims(accessToken)
  if (claims.role !== PRODUCTION_SHADOW_ROLE) {
    throw new Error(`Production shadow JWT role must be exactly ${PRODUCTION_SHADOW_ROLE}.`)
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new Error('Production shadow JWT requires a numeric expiry.')
  }
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const remainingSeconds = claims.exp - nowSeconds
  if (remainingSeconds <= 0) throw new Error('Production shadow JWT is expired.')
  if (remainingSeconds > MAX_PRODUCTION_TOKEN_REMAINING_SECONDS) {
    throw new Error('Production shadow JWT remaining lifetime must not exceed two hours.')
  }
  return { url, publishableKey, accessToken }
}

const getHeadOnlyFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') throw new Error(`Prompt 15 network guard blocked ${method}`)
  return fetch(input, init)
}

export function createShadowRuntimeClient(
  target: ShadowTarget,
  environment: NodeJS.ProcessEnv = process.env,
  clientOverride?: SupabaseClient<Database>,
): ShadowRuntimeClient {
  const audit = { blockedMutationAttempts: 0, allowedMethodCalls: 0 }
  if (clientOverride) return { client: createReadOnlySupabaseClient(clientOverride, audit), audit, targetUrl: 'injected://test' }
  const productionLike = target === 'v1-production-readonly'
  if (productionLike) {
    const credentials = validateProductionShadowCredentials(environment)
    const url = new URL(credentials.url)
    if (LOCAL_HOSTS.has(url.hostname)) throw new Error('v1-production-readonly target cannot use a local URL.')
    if (refFor(url) !== KNOWN_V1_PRODUCTION_REF) throw new Error('v1-production-readonly target requires the known V1 production project.')
    const raw = createClient<any, typeof PRODUCTION_SHADOW_SCHEMA>(credentials.url, credentials.publishableKey, {
      db: { schema: PRODUCTION_SHADOW_SCHEMA },
      accessToken: async () => credentials.accessToken,
      global: { fetch: getHeadOnlyFetch },
      auth: { autoRefreshToken: false, persistSession: false },
    })
    return {
      client: createReadOnlySupabaseClient(raw as never, audit) as unknown as SupabaseClient<Database>,
      audit,
      targetUrl: `${url.protocol}//${url.host}`,
    }
  }
  const rawUrl = productionLike ? environment.V2_SHADOW_SUPABASE_URL : environment.NEXT_PUBLIC_SUPABASE_URL
  const key = environment.V2_SHADOW_SUPABASE_READ_KEY
    ?? (!productionLike && target === 'local-v2' ? environment.SUPABASE_SERVICE_ROLE_KEY : undefined)
  if (!rawUrl || !key) {
    throw new Error(productionLike
      ? 'Production-read shadow requires V2_SHADOW_SUPABASE_URL and V2_SHADOW_SUPABASE_READ_KEY.'
      : 'Shadow target requires a Supabase URL and V2_SHADOW_SUPABASE_READ_KEY (local-v2 may use the local service-role key).')
  }
  const url = new URL(rawUrl)
  const actualRef = refFor(url)
  if (target === 'local-v2' && !LOCAL_HOSTS.has(url.hostname)) throw new Error('local-v2 target requires a loopback Supabase URL.')
  if (target === 'v2') {
    const expected = environment.NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF?.trim().toLowerCase()
    if (!expected || actualRef !== expected || actualRef === KNOWN_V1_PRODUCTION_REF) {
      throw new Error('v2 shadow target requires an explicit matching non-production V2 Supabase project reference.')
    }
  }
  const raw = createClient<Database>(rawUrl, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return { client: createReadOnlySupabaseClient(raw, audit), audit, targetUrl: `${url.protocol}//${url.host}` }
}

export interface RunShadowReportInput {
  safety: ShadowSafetyRequest
  selector: ShadowSampleSelector
  source: string
  classification?: ShadowDifferenceClassification
  concurrency?: number
  environment?: NodeJS.ProcessEnv
  clientOverride?: SupabaseClient<Database>
  now?: Date
  workspaceId?: string
}

export interface ShadowRuntimeReport {
  target: ShadowTarget
  targetUrl: string
  correlationId: string
  observabilityWritesEnabled: boolean
  providerCallsEnabled: false
  operationalMutationsEnabled: false
  selectedLeadIds: string[]
  outcomes: ShadowEvaluationOutcome[]
  displayedOutcomes: ShadowEvaluationOutcome[]
  summary: ReturnType<typeof summarizeShadowResults>
  contextMetrics: Awaited<ReturnType<typeof loadDecisionContexts>>['metrics']
  readOnlyAudit: ReadOnlyClientAudit
}

export async function runShadowReport(input: RunShadowReportInput): Promise<ShadowRuntimeReport> {
  const environment = input.environment ?? process.env
  const safety = assertShadowSafeExecution(input.safety, environment)
  const runtime = createShadowRuntimeClient(input.safety.target, environment, input.clientOverride)
  const now = input.now ?? new Date()
  const productionLike = input.safety.target === 'v1-production-readonly'
  const selectedLeadIds = productionLike
    ? await selectDerivedShadowLeadIds(runtime.client as never, input.selector, now)
    : await selectShadowLeadIds(runtime.client, input.selector, now)
  if (selectedLeadIds.length === 0) throw new Error('The bounded selector returned no leads.')
  const loaded = productionLike
    ? await loadDerivedDecisionContexts(runtime.client as never, selectedLeadIds, { asOf: now.toISOString() })
    : await loadDecisionContexts(runtime.client, selectedLeadIds, { asOf: now.toISOString() })
  const contexts = new Map(loaded.contexts.map((context) => [context.leadId, context]))
  const correlationId = randomUUID()
  const telemetry = safety.observabilityWriteEnabled && input.workspaceId ? observability(input.workspaceId) : null
  const workflowRunId = telemetry ? await telemetry.startWorkflowRun({
    workspaceId: input.workspaceId!,
    workflowType: 'shadow_comparison', source: input.source, correlationId,
    metadata: { target: input.safety.target, selected_count: selectedLeadIds.length, cohort_status: input.selector.status ?? null, recent_days: input.selector.recentDays ?? null },
  }) : null
  let sequence = 0
  const observer = telemetry ? {
    recordComparison: async (result: ShadowComparisonResult) => {
      const stepId = await telemetry.startWorkflowStep({
        workflowRunId: workflowRunId ?? undefined, stepName: 'shadow_decision_comparison', stepType: 'decision',
        leadId: result.leadId, sequence: ++sequence, decision: {
          action: result.v2Action, reasonCode: result.reason.v2ReasonCode, leadId: result.leadId,
          inputsUsed: result.relevantFacts.factNames,
        },
        inputSummary: { safe_fact_names: result.relevantFacts.factNames, source: result.source, sample_cohort: result.sampleCohort ?? null },
      })
      await telemetry.completeWorkflowStep(stepId, { outputSummary: {
        v2_action: result.v2Action, v2_reason: result.reason.v2ReasonCode,
        legacy_action: result.legacyAction, classification: result.classification,
        status: result.relevantFacts.status, category_disposition: result.relevantFacts.categoryDisposition,
        correlation_id: result.correlationId,
      } })
    },
  } : undefined
  try {
    const batch = await evaluateShadowBatch(selectedLeadIds, {
      safety: input.safety, environment, source: input.source,
      sampleCohort: input.selector.status ?? (input.selector.recentDays ? `recent-${input.selector.recentDays}-days` : 'explicit-leads'),
      correlationId, observer,
      loadContext: async (leadId) => contexts.get(leadId) ?? null,
      now: () => now,
    }, input.concurrency)
    await telemetry?.completeWorkflowRun(workflowRunId, batch.summary.failedEvaluationCount ? 'partial' : 'succeeded', {
      ...batch.summary, blocked_mutation_attempts: runtime.audit.blockedMutationAttempts,
    })
    const displayedOutcomes = input.classification
      ? batch.outcomes.filter((item) => item.ok && item.result.classification === input.classification)
      : batch.outcomes
    return {
      target: input.safety.target, targetUrl: runtime.targetUrl, correlationId,
      observabilityWritesEnabled: safety.observabilityWriteEnabled,
      providerCallsEnabled: false, operationalMutationsEnabled: false,
      selectedLeadIds, outcomes: batch.outcomes, displayedOutcomes,
      summary: batch.summary, contextMetrics: loaded.metrics, readOnlyAudit: runtime.audit,
    }
  } catch (error) {
    await telemetry?.failWorkflowRun(workflowRunId, error)
    throw error
  }
}
