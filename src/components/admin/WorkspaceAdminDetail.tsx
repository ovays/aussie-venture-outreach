'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorkspaceAdminDetail as WorkspaceDetail } from '@/lib/admin/workspaces'
import { Button } from '@/components/ui/Button'

async function request(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Administrative request failed')
}

export function WorkspaceAdminDetail({ workspace }: { workspace: WorkspaceDetail }) {
  const router = useRouter()
  const [name, setName] = useState(workspace.name)
  const [status, setStatus] = useState(workspace.status)
  const [newUserId, setNewUserId] = useState('')
  const [newRole, setNewRole] = useState<'owner' | 'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function perform(work: () => Promise<void>, success: string) {
    setBusy(true); setMessage(null)
    try { await work(); setMessage(success); router.refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed') }
    finally { setBusy(false) }
  }

  const membersUrl = `/api/admin/workspaces/${workspace.id}/members`
  return (
    <div className="page-stack">
      <section className="grid gap-4 md:grid-cols-2">
        <label className="text-sm text-[var(--text-secondary)]">Workspace name
          <input className="control-field mt-1 w-full px-3" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="text-sm text-[var(--text-secondary)]">Status
          <select className="control-field mt-1 w-full px-3" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="active">active</option><option value="suspended">suspended</option><option value="archived">archived</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button disabled={busy || !name.trim()} onClick={() => void perform(() => request('/api/admin/workspaces', { method: 'PATCH', body: JSON.stringify({ action: 'update_name', workspaceId: workspace.id, name }) }), 'Workspace name updated.')}>Save name</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void perform(() => request('/api/admin/workspaces', { method: 'PATCH', body: JSON.stringify({ action: 'set_status', workspaceId: workspace.id, status }) }), 'Workspace status updated.')}>Save status</Button>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">Members</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input aria-label="New member user ID" className="control-field min-w-0 flex-1 px-3" placeholder="Existing profile UUID" value={newUserId} onChange={(event) => setNewUserId(event.target.value)} />
          <select aria-label="New member role" className="control-field px-3" value={newRole} onChange={(event) => setNewRole(event.target.value as typeof newRole)}><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select>
          <Button disabled={busy || !newUserId} onClick={() => void perform(() => request(membersUrl, { method: 'POST', body: JSON.stringify({ userId: newUserId, role: newRole }) }), 'Member added.')}>Add member</Button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--text-muted)]"><tr><th className="py-2">Person</th><th>Role</th><th>Status</th><th className="text-right">Action</th></tr></thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">{workspace.members.map((member) => <tr key={member.userId}>
              <td className="py-3"><p>{member.fullName ?? member.email ?? member.userId}</p><p className="text-xs text-[var(--text-muted)]">{member.email ?? member.userId}</p></td>
              <td><select aria-label={`Role for ${member.email ?? member.userId}`} className="control-field px-2" defaultValue={member.role} disabled={busy} onChange={(event) => void perform(() => request(membersUrl, { method: 'PATCH', body: JSON.stringify({ action: 'set_role', userId: member.userId, role: event.target.value }) }), 'Member role updated.')}><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select></td>
              <td><select aria-label={`Status for ${member.email ?? member.userId}`} className="control-field px-2" defaultValue={member.status} disabled={busy} onChange={(event) => void perform(() => request(membersUrl, { method: 'PATCH', body: JSON.stringify({ action: 'set_status', userId: member.userId, status: event.target.value }) }), 'Member status updated.')}><option value="active">active</option><option value="invited">invited</option><option value="suspended">suspended</option></select></td>
              <td className="text-right"><Button variant="secondary" disabled={busy} onClick={() => void perform(() => request(`${membersUrl}?userId=${encodeURIComponent(member.userId)}`, { method: 'DELETE' }), 'Member removed.')}>Remove</Button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="grid gap-3 text-sm sm:grid-cols-3">
        <div><p className="text-[var(--text-muted)]">Entitlement</p><p>{workspace.entitlement?.planName ?? workspace.plan}</p></div>
        <div><p className="text-[var(--text-muted)]">Billing</p><p className="capitalize">{workspace.billing?.subscriptionStatus ?? 'Not connected'}</p></div>
        <div><p className="text-[var(--text-muted)]">Usage period</p><p>{workspace.usage?.periodStart ? `${workspace.usage.periodStart.slice(0, 10)} – ${workspace.usage.periodEnd?.slice(0, 10) ?? 'current'}` : 'Unavailable'}</p></div>
      </section>
      {message && <p role="status" className="text-sm text-[var(--text-secondary)]">{message}</p>}
    </div>
  )
}
