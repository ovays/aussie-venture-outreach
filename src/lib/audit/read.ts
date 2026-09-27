import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import type { AuditEventRow } from './types'

export interface AuditListParams {
  workspaceId?: string | null
  action?: string | null
  actorUserId?: string | null
  limit?: number
  cursor?: string | null
}

export interface AuditListResult {
  events: AuditEventRow[]
  hasMore: boolean
  nextCursor: string | null
}

interface AuditCursor {
  created_at: string
  id: string
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string | null | undefined): AuditCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as AuditCursor
    if (
      typeof parsed.created_at !== 'string'
      || !Number.isFinite(Date.parse(parsed.created_at))
      || typeof parsed.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error('Invalid audit cursor')
    }
    return parsed
  } catch {
    throw new Error('Invalid audit cursor')
  }
}

/**
 * Server-resolved, cursor-paginated audit read. The caller must already have
 * enforced workspace/platform authorization; this module only bounds the query.
 */
export async function listAuditEvents(params: AuditListParams = {}): Promise<AuditListResult> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50), 1), 100)
  const cursor = decodeCursor(params.cursor)

  const service = createServiceClient()
  const { data, error } = await service.rpc('admin_list_audit_events', {
    p_workspace_id: params.workspaceId ?? null,
    p_action: params.action ?? null,
    p_actor_user_id: params.actorUserId ?? null,
    p_limit: limit,
    p_cursor_created_at: cursor?.created_at ?? null,
    p_cursor_id: cursor?.id ?? null,
  })

  if (error) throw new Error(error.message)

  const raw = (data ?? {}) as { events?: AuditEventRow[]; has_more?: boolean; next_cursor?: AuditCursor | null }
  const events = raw.events ?? []
  const hasMore = raw.has_more === true
  const nextCursor = hasMore && raw.next_cursor ? encodeCursor(raw.next_cursor) : null

  return { events, hasMore, nextCursor }
}
