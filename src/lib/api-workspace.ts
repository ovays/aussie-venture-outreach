import 'server-only'

import { NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser, type AuthContext } from '@/lib/auth'
import { requireWorkspaceContext, type WorkspaceContext } from '@/lib/workspace-context'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'

export interface ApiWorkspaceContext {
  auth: AuthContext
  workspace: WorkspaceContext
  supabase: ReturnType<typeof createWorkspaceServiceClient>
}

async function finish(auth: AuthContext | NextResponse): Promise<ApiWorkspaceContext | NextResponse> {
  if (isAuthErrorResponse(auth)) return auth
  try {
    const workspace = await requireWorkspaceContext(auth)
    return { auth, workspace, supabase: createWorkspaceServiceClient(workspace.workspaceId) }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Workspace access denied' }, { status: 403 })
  }
}

export async function requireApiWorkspaceUser(): Promise<ApiWorkspaceContext | NextResponse> {
  return finish(await requireApiUser())
}

export async function requireApiWorkspaceAdmin(): Promise<ApiWorkspaceContext | NextResponse> {
  const context = await finish(await requireApiUser())
  if (context instanceof NextResponse) return context
  if (!context.workspace.isPlatformAdmin && context.workspace.role !== 'owner' && context.workspace.role !== 'admin') {
    return NextResponse.json({ error: 'Workspace admin access is required' }, { status: 403 })
  }
  return context
}

export function isApiWorkspaceError(value: ApiWorkspaceContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}
