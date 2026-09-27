import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import {
  adminAddWorkspaceMember,
  adminRemoveWorkspaceMember,
  adminSetWorkspaceMemberRole,
  adminSetWorkspaceMemberStatus,
} from '@/lib/admin/membership'

const roleSchema = z.enum(['owner', 'admin', 'member'])
const statusSchema = z.enum(['active', 'invited', 'suspended'])

const addSchema = z.object({
  userId: z.string().uuid(),
  role: roleSchema,
})

const updateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_role'), userId: z.string().uuid(), role: roleSchema }),
  z.object({ action: z.literal('set_status'), userId: z.string().uuid(), status: statusSchema }),
])

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const { id } = await context.params
  const parsedId = z.string().uuid().safeParse(id)
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = addSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    await adminAddWorkspaceMember(parsedId.data, parsed.data.userId, parsed.data.role, auth.user.id, 'platform_admin')
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to add member' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const { id } = await context.params
  const parsedId = z.string().uuid().safeParse(id)
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    if (parsed.data.action === 'set_role') {
      await adminSetWorkspaceMemberRole(parsedId.data, parsed.data.userId, parsed.data.role, auth.user.id, 'platform_admin')
    } else {
      await adminSetWorkspaceMemberStatus(parsedId.data, parsed.data.userId, parsed.data.status, auth.user.id, 'platform_admin')
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update member' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const { id } = await context.params
  const parsedId = z.string().uuid().safeParse(id)
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 })

  const userId = request.nextUrl.searchParams.get('userId')
  const parsedUserId = z.string().uuid().safeParse(userId ?? '')
  if (!parsedUserId.success) return NextResponse.json({ error: 'A valid userId is required' }, { status: 400 })

  try {
    await adminRemoveWorkspaceMember(parsedId.data, parsedUserId.data, auth.user.id, 'platform_admin')
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to remove member' }, { status: 500 })
  }
}
