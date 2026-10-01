export type WorkspaceRole = 'owner' | 'admin' | 'member'

export function hasWorkspaceAdminAccess(role: WorkspaceRole, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || role === 'owner' || role === 'admin'
}

export function hasPlatformAdminAccess(isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin
}

export function canEditCustomerLeadNotes(role: WorkspaceRole, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || role === 'owner' || role === 'admin' || role === 'member'
}

export function canEditCustomerLeadOutcome(role: WorkspaceRole, isPlatformAdmin: boolean): boolean {
  return hasWorkspaceAdminAccess(role, isPlatformAdmin)
}

export type PlatformAdminApiDecision =
  | { allowed: true; status: 200 }
  | { allowed: false; status: 401 | 403; error: string }

/** Pure policy used by API guards and authorization-matrix tests. */
export function platformAdminApiDecision(role: 'admin' | 'member' | null): PlatformAdminApiDecision {
  if (role === null) return { allowed: false, status: 401, error: 'Authentication required' }
  if (role !== 'admin') return { allowed: false, status: 403, error: 'Admin access required' }
  return { allowed: true, status: 200 }
}
