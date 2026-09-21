type Row = Record<string, unknown>

const clientWorkspaces = new WeakMap<object, string>()

export function registerWorkspaceServiceClient(client: object, workspaceId: string): void {
  clientWorkspaces.set(client, workspaceId)
}

export function workspaceIdForServiceClient(client: object): string | undefined {
  return clientWorkspaces.get(client)
}

export function requireWorkspaceIdForServiceClient(client: object): string {
  const workspaceId = workspaceIdForServiceClient(client)
  if (!workspaceId) throw new Error('Workspace-scoped service client required')
  return workspaceId
}

export function workspaceRow<T extends Row>(client: object, row: T): T & { workspace_id: string } {
  return { ...row, workspace_id: requireWorkspaceIdForServiceClient(client) }
}

export function workspaceRows<T extends Row>(client: object, rows: readonly T[]): Array<T & { workspace_id: string }> {
  const workspaceId = requireWorkspaceIdForServiceClient(client)
  return rows.map((row) => ({ ...row, workspace_id: workspaceId }))
}
