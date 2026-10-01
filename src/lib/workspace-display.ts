import type { WorkspaceRole } from '@/lib/access-policy'

export interface WorkspaceExecutionDisplayState {
  systemActive: boolean
  mailboxConnected: boolean
  onboardingCompleted: boolean
}

export function workspaceExecutionLabel(state: WorkspaceExecutionDisplayState): 'Live' | 'Paused' {
  return state.systemActive && state.mailboxConnected && state.onboardingCompleted ? 'Live' : 'Paused'
}

export function workspaceRoleLabel(role: WorkspaceRole): string {
  if (role === 'owner') return 'Workspace Owner'
  if (role === 'admin') return 'Workspace Admin'
  return 'Workspace Member'
}
