import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'
import { createPortalSession } from '@/lib/billing/service'

export async function POST(): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context
  try {
    const url = await createPortalSession(context.workspace.workspaceId)
    return NextResponse.json({ data: { url } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create portal session' }, { status: 502 })
  }
}
