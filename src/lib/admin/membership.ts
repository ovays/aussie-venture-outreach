import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import type { AuditActorRole } from '@/lib/audit/types'

export type WorkspaceMemberRole = 'owner' | 'admin' | 'member'
export type WorkspaceMemberStatus = 'active' | 'invited' | 'suspended'

export async function adminAddWorkspaceMember(
  workspaceId: string,
  targetUserId: string,
  role: WorkspaceMemberRole,
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_add_workspace_member', {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_role: role,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}

export async function adminSetWorkspaceMemberRole(
  workspaceId: string,
  targetUserId: string,
  role: WorkspaceMemberRole,
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_set_workspace_member_role', {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_role: role,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}

export async function adminSetWorkspaceMemberStatus(
  workspaceId: string,
  targetUserId: string,
  status: WorkspaceMemberStatus,
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_set_workspace_member_status', {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_status: status,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}

export async function adminRemoveWorkspaceMember(
  workspaceId: string,
  targetUserId: string,
  actorUserId: string,
  actorRole: AuditActorRole,
): Promise<void> {
  const service = createServiceClient()
  const { error } = await service.rpc('admin_remove_workspace_member', {
    p_workspace_id: workspaceId,
    p_target_user_id: targetUserId,
    p_actor_id: actorUserId,
    p_actor_role: actorRole,
  })
  if (error) throw new Error(error.message)
}
