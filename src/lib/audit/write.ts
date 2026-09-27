import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { sanitizeAuditMetadata } from './sanitize'
import {
  AUDIT_ACTION_PATTERN,
  type AuditActorRole,
  type AuditActorType,
  type AuditResult,
} from './types'

export interface AuditEventInput {
  workspaceId?: string | null
  actorUserId?: string | null
  actorType?: AuditActorType
  actorRole?: AuditActorRole | null
  action: string
  targetType: string
  targetId?: string | null
  result?: AuditResult
  requestId?: string | null
  source?: string
  metadata?: Record<string, unknown>
}

/**
 * Single trusted server-side audit writer. Actor identity/role and workspace
 * scope are resolved by the caller (never request bodies); this module only
 * normalizes, sanitizes, and persists through the service-role RPC. It throws
 * when the audit write fails so privileged mutations never silently claim full
 * success without a durable record.
 */
export async function writeAuditEvent(input: AuditEventInput): Promise<string> {
  if (!AUDIT_ACTION_PATTERN.test(input.action)) {
    throw new Error(`Invalid audit action name: ${input.action}`)
  }
  const service = createServiceClient()
  const metadata = sanitizeAuditMetadata(input.metadata ?? {})
  const { data, error } = await service.rpc('write_audit_event', {
    p_workspace_id: input.workspaceId ?? null,
    p_actor_user_id: input.actorUserId ?? null,
    p_actor_type: input.actorType ?? 'user',
    p_actor_role: input.actorRole ?? null,
    p_action: input.action,
    p_target_type: input.targetType,
    p_target_id: input.targetId ?? null,
    p_result: input.result ?? 'success',
    p_request_id: input.requestId ?? null,
    p_source: input.source ?? 'application',
    p_metadata: metadata ?? {},
  })
  if (error) throw new Error(`Audit write failed: ${error.message}`)
  return String(data)
}
