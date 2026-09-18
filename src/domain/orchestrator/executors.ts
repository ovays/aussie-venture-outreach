import { getAnalyticsDayRange } from '@/lib/analytics'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { observability } from '@/lib/observability/service'
import type { FollowUpType } from '@/lib/followup-eligibility'
import { researchLead, researchPurposeForMode } from '@/services/research'
import { generateInitialContent } from '@/services/initial-content'
import { sendInitialOutreach } from '@/services/outbound'
import { sendFollowUp } from '@/services/followup'
import { sendReactivation } from '@/services/reactivation'
import type { ExecutorAdapters } from './executor-map'
import { createExecutorRegistry } from './executor-map'
import type { ExecutorInput, ExecutorRegistry, ExecutorResult } from './types'

type Client = ExecutorInput['client']
const SEND_BUDGET_LOCK = 'sender_agent'
const SEND_BUDGET_LOCK_TTL_MS = 15 * 60 * 1000

function failed(reason: string, retryable = false): ExecutorResult {
  return { outcome: 'failed', changedState: false, retryable, details: { reason } }
}

async function isSystemActive(client: Client): Promise<boolean> {
  const result = await client.from('settings').select('value').eq('key', 'system_active').maybeSingle()
  if (result.error) throw new Error(`System setting read failed: ${result.error.message}`)
  return result.data?.value === 'true'
}

async function withSendBudget<T>(client: Client, work: () => Promise<T>): Promise<T | null> {
  const token = await acquireLock(client, SEND_BUDGET_LOCK, SEND_BUDGET_LOCK_TTL_MS)
  if (!token) return null
  try {
    return await work()
  } finally {
    await releaseLock(client, SEND_BUDGET_LOCK, token)
  }
}

async function loadSettings(client: Client, keys: readonly string[]): Promise<Map<string, string>> {
  const result = await client.from('settings').select('key,value').in('key', [...keys]).limit(keys.length)
  if (result.error) throw new Error(`Executor settings read failed: ${result.error.message}`)
  return new Map((result.data ?? []).map((row) => [row.key, row.value]))
}

async function quotaAvailable(client: Client, type: FollowUpType | 'initial_pitch' | 'reactivation'): Promise<boolean> {
  const keys = type === 'initial_pitch'
    ? ['daily_lead_limit', 'daily_initial_outreach_limit']
    : type === 'reactivation'
      ? ['daily_reactivation_limit']
      : ['daily_lead_limit', `daily_followup${type.slice(-1)}_limit`]
  const settings = await loadSettings(client, keys)
  const today = getAnalyticsDayRange()
  const typeResult = await client.from('emails').select('*', { count: 'exact', head: true })
    .eq('status', 'sent').eq('type', type).gte('sent_at', today.start).lt('sent_at', today.end)
  if (typeResult.error) throw new Error(`Executor quota read failed: ${typeResult.error.message}`)
  const typeDefault = type === 'initial_pitch' ? 50 : type === 'reactivation' ? 10 : type === 'follow_up_1' ? 20 : type === 'follow_up_2' ? 10 : 5
  const typeKey = type === 'initial_pitch' ? 'daily_initial_outreach_limit' : type === 'reactivation' ? 'daily_reactivation_limit' : `daily_followup${type.slice(-1)}_limit`
  if ((typeResult.count ?? 0) >= Number.parseInt(settings.get(typeKey) ?? String(typeDefault), 10)) return false
  if (type === 'reactivation') return true
  const globalResult = await client.from('emails').select('*', { count: 'exact', head: true })
    .eq('status', 'sent').in('type', ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3'])
    .gte('sent_at', today.start).lt('sent_at', today.end)
  if (globalResult.error) throw new Error(`Global executor quota read failed: ${globalResult.error.message}`)
  return (globalResult.count ?? 0) < Number.parseInt(settings.get('daily_lead_limit') ?? '100', 10)
}

const research: ExecutorAdapters['research'] = async ({ client, context }) => {
  if (!(await isSystemActive(client))) return { outcome: 'waiting', changedState: false, details: { reason: 'system_paused' } }
  const purpose = researchPurposeForMode(context.initialEmailMode)
  const result = await researchLead({ client, leadId: context.leadId, purpose })
  return result.outcome === 'completed'
    ? { outcome: 'completed', changedState: result.changedState, details: { email_found: result.emailFound ?? false, purpose } }
    : failed(result.summary?.error ?? 'research_failed', true)
}

const initialContent: ExecutorAdapters['initialContent'] = async ({ client, context }) => {
  if (!(await isSystemActive(client))) return { outcome: 'waiting', changedState: false, details: { reason: 'system_paused' } }
  const generated = await generateInitialContent({ client, leadId: context.leadId, mode: context.initialEmailMode })
  if (!generated.ok) return failed(`${generated.error.code}: ${generated.error.reason}`, generated.error.code.endsWith('_failed'))
  return {
    outcome: 'completed', changedState: true,
    details: { mode: generated.mode, generation_source: generated.generationSource ?? null, result: generated.outcome },
  }
}

const initialSend: ExecutorAdapters['initialSend'] = async ({ client, context, decision }) => {
  if (!(await isSystemActive(client))) return { outcome: 'waiting', changedState: false, details: { reason: 'system_paused' } }
  const result = await withSendBudget(client, async (): Promise<ExecutorResult> => {
    if (!(await quotaAvailable(client, 'initial_pitch'))) return { outcome: 'waiting', changedState: false, details: { reason: 'quota_exhausted' } }
    return sendInitialOutreach({ client, leadId: context.leadId, decisionReason: decision.reasonCode })
  })
  return result ?? { outcome: 'waiting', changedState: false, retryable: true, details: { reason: 'send_budget_locked' } }
}

function followUpType(action: ExecutorInput['decision']['action']): FollowUpType | null {
  if (action === 'SEND_FOLLOWUP_1') return 'follow_up_1'
  if (action === 'SEND_FOLLOWUP_2') return 'follow_up_2'
  if (action === 'SEND_FOLLOWUP_3') return 'follow_up_3'
  return null
}

const followUp: ExecutorAdapters['followUp'] = async ({ client, context, decision }) => {
  const type = followUpType(decision.action)
  if (!type) return failed('unsupported_followup_action')
  if (!(await isSystemActive(client))) return { outcome: 'waiting', changedState: false, details: { reason: 'system_paused' } }
  const result = await withSendBudget(client, async (): Promise<ExecutorResult> => {
    if (!(await quotaAvailable(client, type))) return { outcome: 'waiting', changedState: false, details: { reason: 'quota_exhausted' } }
    return sendFollowUp({ client, leadId: context.leadId, type, daysSinceInitial: Number(decision.metadata?.daysSinceInitial ?? 0) })
  })
  return result ?? { outcome: 'waiting', changedState: false, retryable: true, details: { reason: 'send_budget_locked' } }
}

const reactivation: ExecutorAdapters['reactivation'] = async ({ client, context }) => {
  if (!(await isSystemActive(client))) return { outcome: 'waiting', changedState: false, details: { reason: 'system_paused' } }
  const result = await withSendBudget(client, async (): Promise<ExecutorResult> => {
    if (!(await quotaAvailable(client, 'reactivation'))) return { outcome: 'waiting', changedState: false, details: { reason: 'quota_exhausted' } }
    return sendReactivation({ client, leadId: context.leadId })
  })
  return result ?? { outcome: 'waiting', changedState: false, retryable: true, details: { reason: 'send_budget_locked' } }
}

const lifecycle: ExecutorAdapters['lifecycle'] = async ({ client, context, decision }) => {
  const updated = await client.from('leads').update({ status: 'dead' }).eq('id', context.leadId).eq('status', context.status).select('id').maybeSingle()
  if (updated.error) return failed(updated.error.message, true)
  if (!updated.data) return { outcome: 'skipped', changedState: false, details: { reason: 'status_changed_concurrently' } }
  await observability().observeLeadStatusTransition({ leadId: context.leadId, fromStatus: context.status, toStatus: 'dead', actor: 'orchestrator.lifecycle', reasonCode: decision.reasonCode })
  return { outcome: 'completed', changedState: true, details: { target_status: 'dead' } }
}

export function createProductionExecutorRegistry(): ExecutorRegistry {
  return createExecutorRegistry({ research, initialContent, initialSend, followUp, reactivation, lifecycle })
}
