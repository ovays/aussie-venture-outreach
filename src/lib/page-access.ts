import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { requireUser, type AuthContext } from '@/lib/auth'
import { requireWorkspaceContext, type WorkspaceContext } from '@/lib/workspace-context'
import { hasPlatformAdminAccess, hasWorkspaceAdminAccess } from '@/lib/access-policy'

export interface WorkspacePageContext {
  auth: AuthContext
  workspace: WorkspaceContext
}

async function resolveWorkspacePage(): Promise<WorkspacePageContext> {
  const auth = await requireUser()
  try {
    const workspace = await requireWorkspaceContext(auth)
    return { auth, workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'No workspace membership' || message === 'Workspace selection required') {
      redirect('/no-workspace')
    }
    throw error
  }
}

/** Authenticated pages available to every active workspace member. */
export async function requireWorkspacePage(): Promise<WorkspacePageContext> {
  return resolveWorkspacePage()
}

/** Workspace configuration pages available to owners, admins, and platform admins. */
export async function requireWorkspaceAdminPage(): Promise<WorkspacePageContext> {
  const context = await resolveWorkspacePage()
  if (!hasWorkspaceAdminAccess(context.workspace.role, context.workspace.isPlatformAdmin)) {
    notFound()
  }
  return context
}

/** Internal operational pages available only to a server-verified platform admin. */
export async function requireInternalPage(): Promise<WorkspacePageContext> {
  const context = await resolveWorkspacePage()
  if (!hasPlatformAdminAccess(context.workspace.isPlatformAdmin) || context.auth.profile.role !== 'admin') {
    notFound()
  }
  return context
}
