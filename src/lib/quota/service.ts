import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import {
  isConsumableDimension,
  isQuotaDimension,
  QUOTA_DIMENSIONS,
  type QuotaDimension,
} from './dimensions'
import {
  NoEntitlementError,
  QUOTA_EXCEEDED_CODE,
  NO_ENTITLEMENT_CODE,
  QuotaExceededError,
} from './errors'

/**
 * Central workspace usage/quota service. All quota decisions flow through here;
 * API routes and expensive/limited operations must not reimplement this logic.
 *
 * The quota RPCs are service-role only (a browser cannot consume or mutate
 * quota directly). Workspace_id is always resolved server-side by the caller
 * before it reaches this module.
 */

export interface QuotaCheck {
  allowed: boolean
  dimension: QuotaDimension
  limit: number | null
  used: number
  remaining: number | null
  periodStart: string | null
  periodEnd: string | null
  reason: typeof QUOTA_EXCEEDED_CODE | null
}

export interface QuotaConsumption extends QuotaCheck {
  consumed: boolean
  alreadyConsumed: boolean
}

export interface WorkspaceUsageOverview {
  planCode: string | null
  planName: string | null
  periodStart: string | null
  periodEnd: string | null
  dimensions: Record<QuotaDimension, QuotaCheck>
}

export interface WorkspaceEntitlementRow {
  id: string
  name: string
  slug: string
  status: string
  plan: string
  planCode: string | null
  planName: string | null
  createdAt: string
}

export interface WorkspaceOverrideRow {
  dimensionKey: string
  limitValue: number | null
  notes: string | null
  updatedBy: string | null
  updatedAt: string
}

type RpcError = { message: string; code?: string; hint?: string; details?: string } | null

// The new quota RPCs are not yet present in the generated Database types (they
// are added by `npm run types:v2` after migration 14 is applied). This helper
// localizes the single cast so the rest of the service stays fully typed.
async function callRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const service = createServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (service.rpc as any)(fn, args)) as { data: unknown; error: RpcError }
  if (error) throw error
  return data
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function toUsed(value: unknown): number {
  const n = toNumber(value)
  return n === null ? 0 : n
}

function mapRpcError(error: RpcError, dimension: QuotaDimension): Error {
  const message = error?.message ?? 'Quota operation failed'
  if (message.includes(QUOTA_EXCEEDED_CODE)) {
    return new QuotaExceededError(dimension, message)
  }
  if (message.includes(NO_ENTITLEMENT_CODE)) {
    return new NoEntitlementError(dimension)
  }
  return new Error(message)
}

function parseCheck(raw: Record<string, unknown>, fallbackDimension: QuotaDimension): QuotaCheck {
  const dimension = isQuotaDimension(String(raw.dimension ?? '')) ? (raw.dimension as QuotaDimension) : fallbackDimension
  return {
    allowed: raw.allowed === true,
    dimension,
    limit: toNumber(raw.limit),
    used: toUsed(raw.used),
    remaining: toNumber(raw.remaining),
    periodStart: typeof raw.period_start === 'string' ? raw.period_start : null,
    periodEnd: typeof raw.period_end === 'string' ? raw.period_end : null,
    reason: raw.reason === QUOTA_EXCEEDED_CODE ? QUOTA_EXCEEDED_CODE : null,
  }
}

export async function checkQuota(workspaceId: string, dimension: QuotaDimension): Promise<QuotaCheck> {
  try {
    const raw = await callRpc('check_workspace_quota', {
      p_workspace_id: workspaceId,
      p_dimension_key: dimension,
    })
    return parseCheck((raw ?? {}) as Record<string, unknown>, dimension)
  } catch (error) {
    throw mapRpcError(error as RpcError, dimension)
  }
}

/**
 * Atomically + idempotently consume one unit of a consumable dimension.
 * Throws QuotaExceededError when the limit is reached (the event insert is
 * rolled back so a blocked operation never leaves a durable consumption).
 */
export async function consumeQuota(
  workspaceId: string,
  dimension: QuotaDimension,
  idempotencyKey: string,
  amount = 1,
): Promise<QuotaConsumption> {
  if (!isConsumableDimension(dimension)) {
    throw new Error(`Dimension "${dimension}" is not consumable`)
  }
  try {
    const raw = await callRpc('consume_workspace_quota', {
      p_workspace_id: workspaceId,
      p_dimension_key: dimension,
      p_idempotency_key: idempotencyKey,
      p_amount: amount,
    })
    const parsed = parseCheck((raw ?? {}) as Record<string, unknown>, dimension)
    const flags = raw as Record<string, unknown>
    return {
      ...parsed,
      consumed: flags.consumed === true,
      alreadyConsumed: flags.already_consumed === true,
    }
  } catch (error) {
    throw mapRpcError(error as RpcError, dimension)
  }
}

export async function getWorkspaceUsageOverview(workspaceId: string): Promise<WorkspaceUsageOverview> {
  const raw = (await callRpc('get_workspace_usage_overview', { p_workspace_id: workspaceId })) as Record<string, unknown>
  const dimensions = (raw.dimensions ?? {}) as Record<string, unknown>
  const parsed: Record<QuotaDimension, QuotaCheck> = {} as Record<QuotaDimension, QuotaCheck>
  for (const dimension of QUOTA_DIMENSIONS) {
    parsed[dimension] = parseCheck((dimensions[dimension] ?? {}) as Record<string, unknown>, dimension)
  }
  return {
    planCode: typeof raw.plan_code === 'string' ? raw.plan_code : null,
    planName: typeof raw.plan_name === 'string' ? raw.plan_name : null,
    periodStart: typeof raw.period_start === 'string' ? raw.period_start : null,
    periodEnd: typeof raw.period_end === 'string' ? raw.period_end : null,
    dimensions: parsed,
  }
}

// ── Idempotency keys (re-exported for server consumers) ──────────────────────

export { aiRequestIdempotencyKey, discoveryIdempotencyKey, outboundEmailIdempotencyKey } from './keys'

// ── Platform-admin operations ────────────────────────────────────────────────

export async function adminListWorkspaces(): Promise<WorkspaceEntitlementRow[]> {
  const raw = (await callRpc('admin_list_workspaces', {})) as Record<string, unknown>[]
  return (raw ?? []).map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    status: String(row.status ?? ''),
    plan: String(row.plan ?? ''),
    planCode: row.plan_code === null ? null : String(row.plan_code ?? ''),
    planName: row.plan_name === null ? null : String(row.plan_name ?? ''),
    createdAt: String(row.created_at ?? ''),
  }))
}

export async function adminGetWorkspaceOverrides(workspaceId: string): Promise<WorkspaceOverrideRow[]> {
  const raw = (await callRpc('admin_get_workspace_overrides', { p_workspace_id: workspaceId })) as Record<string, unknown>[]
  return (raw ?? []).map((row) => ({
    dimensionKey: String(row.dimension_key ?? ''),
    limitValue: toNumber(row.limit_value),
    notes: row.notes === null ? null : String(row.notes ?? ''),
    updatedBy: row.updated_by === null ? null : String(row.updated_by ?? ''),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  }))
}

export async function adminSetWorkspaceEntitlement(workspaceId: string, planCode: string, actorId: string): Promise<void> {
  await callRpc('admin_set_workspace_entitlement', {
    p_workspace_id: workspaceId,
    p_plan_code: planCode,
    p_actor_id: actorId,
  })
}

export async function adminSetWorkspaceOverride(
  workspaceId: string,
  dimensionKey: QuotaDimension,
  limitValue: number | null,
  notes?: string,
  actorId?: string,
): Promise<void> {
  await callRpc('admin_set_workspace_override', {
    p_workspace_id: workspaceId,
    p_dimension_key: dimensionKey,
    p_limit_value: limitValue,
    p_notes: notes ?? null,
    p_actor_id: actorId ?? null,
  })
}

export async function adminClearWorkspaceOverride(workspaceId: string, dimensionKey: QuotaDimension, actorId: string): Promise<void> {
  await callRpc('admin_clear_workspace_override', {
    p_workspace_id: workspaceId,
    p_dimension_key: dimensionKey,
    p_actor_id: actorId,
  })
}
