import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { adminGetWorkspaceDetail } from '@/lib/admin/workspaces'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const { id } = await context.params
  const parsed = z.string().uuid().safeParse(id)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid workspace id' }, { status: 400 })

  try {
    return NextResponse.json({ data: await adminGetWorkspaceDetail(parsed.data) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load workspace detail' }, { status: 500 })
  }
}
