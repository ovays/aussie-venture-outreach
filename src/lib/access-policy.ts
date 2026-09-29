export type WorkspaceRole = 'owner' | 'admin' | 'member'

export function hasWorkspaceAdminAccess(role: WorkspaceRole, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || role === 'owner' || role === 'admin'
}

export function hasPlatformAdminAccess(isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin
}
