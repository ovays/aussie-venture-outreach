import 'server-only'

import { cache } from 'react'
import { createServiceClient } from '@/lib/supabase/server'
import type { AuthContext } from '@/lib/auth'

export interface WorkspaceContext {
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  isPlatformAdmin: boolean
}

function isWorkspaceRole(role: string): role is WorkspaceContext['role'] {
  return role === 'owner' || role === 'admin' || role === 'member'
}

/**
 * Authoritative server-side workspace resolution.
 *
 * Workspace authority lives in `workspace_members`, never in a JWT claim or a
 * client-supplied value. A requested workspace is only accepted when the caller
 * is an active member, or when the caller is a platform admin explicitly
 * targeting an existing workspace.
 */
export const getWorkspaceContext = cache(
  async (auth: AuthContext, requestedWorkspaceId?: string): Promise<WorkspaceContext> => {
    const service = createServiceClient()
    const isPlatformAdmin = auth.profile.role === 'admin'

    const { data: memberships, error } = await service
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('user_id', auth.user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: true })

    if (error) throw new Error(error.message)

    if (requestedWorkspaceId) {
      const membership = memberships?.find((row) => row.workspace_id === requestedWorkspaceId)
      if (membership && isWorkspaceRole(membership.role)) {
        return { workspaceId: membership.workspace_id, role: membership.role, isPlatformAdmin }
      }
      if (!isPlatformAdmin) throw new Error('Forbidden workspace')

      const { data: workspace, error: workspaceError } = await service
        .from('workspaces')
        .select('id')
        .eq('id', requestedWorkspaceId)
        .maybeSingle()

      if (workspaceError) throw new Error(workspaceError.message)
      if (!workspace) throw new Error('Workspace not found')

      return { workspaceId: workspace.id, role: 'admin', isPlatformAdmin: true }
    }

    const membership = memberships?.[0]
    if (!membership || !isWorkspaceRole(membership.role)) {
      if (isPlatformAdmin) throw new Error('Workspace selection required')
      throw new Error('No workspace membership')
    }

    return { workspaceId: membership.workspace_id, role: membership.role, isPlatformAdmin }
  }
)

export async function requireWorkspaceContext(auth: AuthContext, requestedWorkspaceId?: string): Promise<WorkspaceContext> {
  return getWorkspaceContext(auth, requestedWorkspaceId)
}
