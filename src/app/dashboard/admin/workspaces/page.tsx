import { requireAdmin } from '@/lib/auth'
import { adminListWorkspaceDirectoryPage } from '@/lib/admin/workspaces'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { WorkspaceDirectory } from '@/components/admin/WorkspaceDirectory'
import { resolvePagination } from '@/lib/pagination'
import { normalizeSearchTerm } from '@/lib/search'

export const revalidate = 0

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>
}) {
  await requireAdmin()
  const params = await searchParams
  const pagination = resolvePagination({ page: params.page }, { defaultPageSize: 50 })
  const search = normalizeSearchTerm(params.search)
  const result = await adminListWorkspaceDirectoryPage({ ...pagination, search })
  return <div><TopBar title="Workspaces" /><div className="page-content page-stack"><div><h1 className="text-xl font-semibold">Workspace directory</h1><p className="mt-1 text-sm text-[var(--text-muted)]">Inspect tenant status, membership, usage, and billing without impersonation.</p></div><Card><WorkspaceDirectory result={result} search={search} /></Card></div></div>
}
