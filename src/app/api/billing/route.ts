import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { getWorkspaceBillingSummary } from '@/lib/billing/service'

export async function GET(): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context
  try {
    return NextResponse.json({ data: await getWorkspaceBillingSummary(context.workspace.workspaceId) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load billing' }, { status: 500 })
  }
}
