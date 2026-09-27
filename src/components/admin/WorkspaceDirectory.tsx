'use client'

import Link from 'next/link'
import type { WorkspaceDirectoryPage } from '@/lib/admin/workspaces'
import { Button } from '@/components/ui/Button'

export function WorkspaceDirectory({ result, search }: { result: WorkspaceDirectoryPage; search: string }) {
  const { data: workspaces, page, totalPages, total } = result
  const pageHref = (nextPage: number) => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    params.set('page', String(nextPage))
    return `/dashboard/admin/workspaces?${params}`
  }
  return (
    <div>
      <form className="mb-4 flex gap-2" action="/dashboard/admin/workspaces">
        <input className="control-field min-w-0 flex-1 px-3 py-2 text-sm" name="search" defaultValue={search} placeholder="Search workspace name or slug" />
        <Button type="submit" size="sm">Search</Button>
      </form>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--text-muted)]">
          <tr>
            <th className="px-4 py-3">Workspace</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Plan / billing</th>
            <th className="px-4 py-3 text-right">Members</th>
            <th className="px-4 py-3 text-right">Leads</th>
            <th className="px-4 py-3 text-right">Mailboxes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {workspaces.map((workspace) => (
            <tr key={workspace.id}>
              <td className="px-4 py-3">
                <Link className="font-medium text-sky-400 hover:underline" href={`/dashboard/admin/workspaces/${workspace.id}`}>
                  {workspace.name}
                </Link>
                <p className="text-xs text-[var(--text-muted)]">{workspace.slug}</p>
              </td>
              <td className="px-4 py-3 capitalize">{workspace.status}</td>
              <td className="px-4 py-3">
                <p>{workspace.planName ?? workspace.planCode ?? 'No entitlement'}</p>
                <p className="text-xs capitalize text-[var(--text-muted)]">{workspace.billingStatus ?? 'not connected'}</p>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{workspace.memberCount}</td>
              <td className="px-4 py-3 text-right tabular-nums">{workspace.storedLeads}</td>
              <td className="px-4 py-3 text-right tabular-nums">{workspace.mailboxCount}</td>
            </tr>
          ))}
          {workspaces.length === 0 && <tr><td className="px-4 py-10 text-center text-[var(--text-muted)]" colSpan={6}>No workspaces found.</td></tr>}
        </tbody>
      </table>
      </div>
      <div className="pagination-bar mt-4">
        <Link aria-disabled={page <= 1} tabIndex={page <= 1 ? -1 : undefined} className={`inline-flex min-h-8 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1 text-xs font-medium ${page <= 1 ? 'pointer-events-none opacity-45' : 'hover:bg-[var(--surface-hover)]'}`} href={pageHref(Math.max(1, page - 1))}>Previous</Link>
        <span className="pagination-bar__label">Page {page} of {Math.max(totalPages, 1)} · {total} workspaces</span>
        <Link aria-disabled={page >= totalPages} tabIndex={page >= totalPages ? -1 : undefined} className={`inline-flex min-h-8 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1 text-xs font-medium ${page >= totalPages ? 'pointer-events-none opacity-45' : 'hover:bg-[var(--surface-hover)]'}`} href={pageHref(page + 1)}>Next</Link>
      </div>
    </div>
  )
}
