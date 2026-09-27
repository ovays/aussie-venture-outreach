export type AuditActorType = 'user' | 'service_role' | 'system'
export type AuditActorRole = 'platform_admin' | 'owner' | 'admin' | 'member'
export type AuditResult = 'success' | 'failure' | 'denied'

export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

export const AuditAction = {
  WorkspaceUpdated: 'workspace.updated',
  WorkspaceStatusChanged: 'platform.workspace.status_changed',
  MemberAdded: 'workspace.member.added',
  MemberRoleChanged: 'workspace.member.role_changed',
  MemberDeactivated: 'workspace.member.deactivated',
  MemberReactivated: 'workspace.member.reactivated',
  MemberRemoved: 'workspace.member.removed',
  EntitlementOverrideSet: 'workspace.entitlement.override_set',
  EntitlementOverrideCleared: 'workspace.entitlement.override_cleared',
  AdminUserCreated: 'admin.user.created',
  AdminUserUpdated: 'admin.user.updated',
  AdminUserDeleted: 'admin.user.deleted',
  AdminPasswordResetRequested: 'admin.password_reset_requested',
} as const

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction]

export interface AuditEventRow {
  id: string
  workspace_id: string | null
  actor_user_id: string | null
  actor_type: AuditActorType
  actor_role: AuditActorRole | null
  action: string
  target_type: string
  target_id: string | null
  result: AuditResult
  request_id: string | null
  source: string
  metadata: Record<string, unknown>
  created_at: string
}

export function isAuditActionName(action: string): action is AuditActionName {
  return AUDIT_ACTION_PATTERN.test(action)
}
