import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { adminGetWorkspaceDetail } from '@/lib/admin/workspaces'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { WorkspaceAdminDetail } from '@/components/admin/WorkspaceAdminDetail'

export const revalidate = 0

export default async function AdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params
  const workspace = await adminGetWorkspaceDetail(id).catch(() => null)
  if (!workspace) notFound()
  return <div><TopBar title={workspace.name} /><div className="page-content page-stack"><div><h1 className="text-xl font-semibold">Workspace administration</h1><p className="mt-1 text-sm text-[var(--text-muted)]">{workspace.slug} · {workspace.id}</p></div><Card><WorkspaceAdminDetail workspace={workspace} /></Card></div></div>
}
