import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { isQuotaDimension } from '@/lib/quota/dimensions'
import {
  adminClearWorkspaceOverride,
  adminGetWorkspaceOverrides,
  adminListWorkspaces,
  adminSetWorkspaceEntitlement,
  adminSetWorkspaceOverride,
  getWorkspaceUsageOverview,
} from '@/lib/quota/service'

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_override'),
    workspaceId: z.string().uuid(),
    dimension: z.string().refine(isQuotaDimension),
    limit: z.number().int().nonnegative().nullable(),
    notes: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('clear_override'),
    workspaceId: z.string().uuid(),
    dimension: z.string().refine(isQuotaDimension),
  }),
  z.object({
    action: z.literal('set_entitlement'),
    workspaceId: z.string().uuid(),
    planCode: z.string().regex(/^[a-z0-9][a-z0-9_]{0,79}$/),
  }),
])

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  try {
    const workspaceId = request.nextUrl.searchParams.get('workspaceId')
    if (!workspaceId) return NextResponse.json({ data: await adminListWorkspaces() })
    const parsed = z.string().uuid().safeParse(workspaceId)
    if (!parsed.success) return NextResponse.json({ error: 'Invalid workspaceId' }, { status: 400 })

    const workspaces = await adminListWorkspaces()
    if (!workspaces.some((workspace) => workspace.id === parsed.data)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    }
    const [usage, overrides] = await Promise.all([
      getWorkspaceUsageOverview(parsed.data),
      adminGetWorkspaceOverrides(parsed.data),
    ])
    return NextResponse.json({ data: { usage, overrides } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load quota administration' }, { status: 500 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    if (parsed.data.action === 'set_override') {
      await adminSetWorkspaceOverride(
        parsed.data.workspaceId,
        parsed.data.dimension,
        parsed.data.limit,
        parsed.data.notes,
        auth.user.id,
      )
    } else if (parsed.data.action === 'clear_override') {
      await adminClearWorkspaceOverride(parsed.data.workspaceId, parsed.data.dimension, auth.user.id)
    } else {
      await adminSetWorkspaceEntitlement(parsed.data.workspaceId, parsed.data.planCode, auth.user.id)
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update quota administration' }, { status: 500 })
  }
}
