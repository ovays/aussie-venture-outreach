import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { AUDIT_ACTION_PATTERN } from '@/lib/audit/types'
import { listAuditEvents } from '@/lib/audit/read'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const search = request.nextUrl.searchParams
  const workspace = search.get('workspace') ?? null
  const action = search.get('action') ?? null
  const actor = search.get('actor') ?? null
  const cursor = search.get('cursor') ?? null

  if (workspace !== null && !z.string().uuid().safeParse(workspace).success) {
    return NextResponse.json({ error: 'Invalid workspace filter' }, { status: 400 })
  }
  if (actor !== null && !z.string().uuid().safeParse(actor).success) {
    return NextResponse.json({ error: 'Invalid actor filter' }, { status: 400 })
  }
  if (action !== null && !AUDIT_ACTION_PATTERN.test(action)) {
    return NextResponse.json({ error: 'Invalid action filter' }, { status: 400 })
  }

  const limit = search.get('limit') ? Number(search.get('limit')) : 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: 'limit must be between 1 and 100' }, { status: 400 })
  }

  try {
    const result = await listAuditEvents({ workspaceId: workspace, action, actorUserId: actor, limit, cursor })
    return NextResponse.json({ data: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load audit log'
    return NextResponse.json({ error: message }, { status: message === 'Invalid audit cursor' ? 400 : 500 })
  }
}
