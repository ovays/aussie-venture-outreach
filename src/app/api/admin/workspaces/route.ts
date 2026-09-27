import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import {
  adminListWorkspaceDirectoryPage,
  adminSetWorkspaceStatus,
  adminUpdateWorkspaceName,
} from '@/lib/admin/workspaces'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

const mutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_status'),
    workspaceId: z.string().uuid(),
    status: z.enum(['active', 'suspended', 'archived']),
  }),
  z.object({
    action: z.literal('update_name'),
    workspaceId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  }),
])

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  try {
    const pagination = resolvePagination({
      page: request.nextUrl.searchParams.get('page'),
      pageSize: request.nextUrl.searchParams.get('page_size'),
    })
    const result = await adminListWorkspaceDirectoryPage({
      ...pagination,
      search: normalizeSearchTerm(request.nextUrl.searchParams.get('search')),
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load workspace directory' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = mutationSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })

  try {
    if (parsed.data.action === 'set_status') {
      await adminSetWorkspaceStatus(parsed.data.workspaceId, parsed.data.status, auth.user.id, 'platform_admin')
    } else {
      await adminUpdateWorkspaceName(parsed.data.workspaceId, parsed.data.name, auth.user.id, 'platform_admin')
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update workspace' }, { status: 500 })
  }
}
