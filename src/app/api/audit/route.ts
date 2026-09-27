import { NextRequest, NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'
import { AUDIT_ACTION_PATTERN } from '@/lib/audit/types'
import { listAuditEvents } from '@/lib/audit/read'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context

  const search = request.nextUrl.searchParams
  const action = search.get('action') ?? null
  const cursor = search.get('cursor') ?? null

  if (action !== null && !AUDIT_ACTION_PATTERN.test(action)) {
    return NextResponse.json({ error: 'Invalid action filter' }, { status: 400 })
  }

  const limit = search.get('limit') ? Number(search.get('limit')) : 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: 'limit must be between 1 and 100' }, { status: 400 })
  }

  try {
    const result = await listAuditEvents({
      workspaceId: context.workspace.workspaceId,
      action,
      limit,
      cursor,
    })
    return NextResponse.json({ data: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load audit log'
    return NextResponse.json({ error: message }, { status: message === 'Invalid audit cursor' ? 400 : 500 })
  }
}
