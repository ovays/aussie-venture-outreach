import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'
import { getWorkspaceUsageOverview } from '@/lib/quota/service'

export async function GET(): Promise<NextResponse> {
  const context = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(context)) return context

  try {
    const data = await getWorkspaceUsageOverview(context.workspace.workspaceId)
    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load usage' },
      { status: 500 },
    )
  }
}
