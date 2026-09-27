import { requireAdmin } from '@/lib/auth'
import { adminListWorkspaceDirectory } from '@/lib/admin/workspaces'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { WorkspaceDirectory } from '@/components/admin/WorkspaceDirectory'

export const revalidate = 0

export default async function AdminWorkspacesPage() {
  await requireAdmin()
  const workspaces = await adminListWorkspaceDirectory()
  return <div><TopBar title="Workspaces" /><div className="page-content page-stack"><div><h1 className="text-xl font-semibold">Workspace directory</h1><p className="mt-1 text-sm text-[var(--text-muted)]">Inspect tenant status, membership, usage, and billing without impersonation.</p></div><Card><WorkspaceDirectory workspaces={workspaces} /></Card></div></div>
}
