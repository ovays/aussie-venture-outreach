import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'
import type { AuditActorRole } from '@/lib/audit/types'
import {
  adminAddWorkspaceMember,
  adminRemoveWorkspaceMember,
  adminSetWorkspaceMemberRole,
  adminSetWorkspaceMemberStatus,
} from '@/lib/admin/membership'

const roleSchema = z.enum(['owner', 'admin', 'member'])
const statusSchema = z.enum(['active', 'invited', 'suspended'])

const addSchema = z.object({ userId: z.string().uuid(), role: roleSchema })
const updateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_role'), userId: z.string().uuid(), role: roleSchema }),
  z.object({ action: z.literal('set_status'), userId: z.string().uuid(), status: statusSchema }),
])

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context

  const actorRole: AuditActorRole = context.workspace.isPlatformAdmin ? 'platform_admin' : context.workspace.role

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    await adminAddWorkspaceMember(context.workspace.workspaceId, parsed.data.userId, parsed.data.role, context.auth.user.id, actorRole)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to add member' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context

  const actorRole: AuditActorRole = context.workspace.isPlatformAdmin ? 'platform_admin' : context.workspace.role

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    if (parsed.data.action === 'set_role') {
      await adminSetWorkspaceMemberRole(context.workspace.workspaceId, parsed.data.userId, parsed.data.role, context.auth.user.id, actorRole)
    } else {
      await adminSetWorkspaceMemberStatus(context.workspace.workspaceId, parsed.data.userId, parsed.data.status, context.auth.user.id, actorRole)
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update member' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context

  const actorRole: AuditActorRole = context.workspace.isPlatformAdmin ? 'platform_admin' : context.workspace.role

  const userId = request.nextUrl.searchParams.get('userId')
  const parsedUserId = z.string().uuid().safeParse(userId ?? '')
  if (!parsedUserId.success) return NextResponse.json({ error: 'A valid userId is required' }, { status: 400 })

  try {
    await adminRemoveWorkspaceMember(context.workspace.workspaceId, parsedUserId.data, context.auth.user.id, actorRole)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to remove member' }, { status: 500 })
  }
}
