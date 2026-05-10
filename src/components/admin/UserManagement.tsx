'use client'

import { useMemo, useState } from 'react'
import { KeyRound, Plus, Search, Trash2, UserRound, UsersRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Toggle } from '@/components/ui/Toggle'
import type { Profile, UserRole } from '@/lib/auth-types'

interface UserManagementProps {
  initialUsers: Profile[]
  currentUserId: string
}

interface CreateForm {
  email: string
  full_name: string
  role: UserRole
  password: string
}

function RoleBadge({ role }: { role: UserRole }) {
  const className = role === 'admin'
    ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
    : 'bg-slate-500/15 text-slate-300 border-slate-500/30'

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}>
      {role}
    </span>
  )
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
        active
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : 'bg-red-500/15 text-red-300 border-red-500/30',
      ].join(' ')}
    >
      {active ? 'active' : 'inactive'}
    </span>
  )
}

export function UserManagement({ initialUsers, currentUserId }: UserManagementProps) {
  const [users, setUsers] = useState(initialUsers)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetUser, setResetUser] = useState<Profile | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [form, setForm] = useState<CreateForm>({
    email: '',
    full_name: '',
    role: 'member',
    password: '',
  })

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return users
    return users.filter((user) => (
      user.email.toLowerCase().includes(needle) ||
      (user.full_name ?? '').toLowerCase().includes(needle) ||
      user.role.includes(needle)
    ))
  }, [query, users])

  async function refreshUsers() {
    const res = await fetch('/api/admin/users')
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'Unable to load users')
    setUsers(body.data)
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusyId('create')

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Unable to create user')

      setUsers((current) => [body.data, ...current])
      setForm({ email: '', full_name: '', role: 'member', password: '' })
      setCreateOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function updateUser(userId: string, updates: Partial<Profile> & { password?: string }) {
    setError('')
    setBusyId(userId)

    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...updates }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Unable to update user')

      setUsers((current) => current.map((user) => user.id === userId ? body.data : user))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function deleteUser(userId: string) {
    const user = users.find((item) => item.id === userId)
    if (!window.confirm(`Delete ${user?.email ?? 'this user'}? This removes their Auth account and profile.`)) {
      return
    }

    setError('')
    setBusyId(userId)

    try {
      const res = await fetch(`/api/admin/users?userId=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Unable to delete user')

      setUsers((current) => current.filter((user) => user.id !== userId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    if (!resetUser) return

    await updateUser(resetUser.id, { password: resetPassword })
    setResetUser(null)
    setResetPassword('')
    await refreshUsers()
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border p-4" style={{ borderColor: '#2a2d3e', background: '#11141d' }}>
          <div className="flex items-center gap-3">
            <UsersRound size={18} className="text-sky-300" />
            <div>
              <p className="text-xs" style={{ color: '#94a3b8' }}>Total users</p>
              <p className="text-xl font-semibold text-white">{users.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border p-4" style={{ borderColor: '#2a2d3e', background: '#11141d' }}>
          <div className="flex items-center gap-3">
            <UserRound size={18} className="text-emerald-300" />
            <div>
              <p className="text-xs" style={{ color: '#94a3b8' }}>Active accounts</p>
              <p className="text-xl font-semibold text-white">{users.filter((user) => user.is_active).length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border p-4" style={{ borderColor: '#2a2d3e', background: '#11141d' }}>
          <div className="flex items-center gap-3">
            <KeyRound size={18} className="text-amber-300" />
            <div>
              <p className="text-xs" style={{ color: '#94a3b8' }}>Admins</p>
              <p className="text-xl font-semibold text-white">{users.filter((user) => user.role === 'admin').length}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#64748b' }} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users"
            className="pl-9"
          />
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} />
          Create User
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border px-4 py-3 text-sm text-red-300 bg-red-500/10 border-red-500/30">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: '#2a2d3e' }}>
        <table className="w-full text-sm">
          <thead style={{ background: '#11141d' }}>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              {['User', 'Role', 'Status', 'Created', 'Controls'].map((header) => (
                <th key={header} className="px-4 py-3 text-left text-xs font-medium uppercase" style={{ color: '#64748b' }}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((user) => (
              <tr key={user.id} className="border-b" style={{ borderColor: '#1e2130' }}>
                <td className="px-4 py-4">
                  <div>
                    <p className="font-medium text-white">{user.full_name ?? 'Unnamed user'}</p>
                    <p className="text-xs" style={{ color: '#94a3b8' }}>{user.email}</p>
                  </div>
                </td>
                <td className="px-4 py-4">
                  <select
                    value={user.role}
                    disabled={busyId === user.id || user.id === currentUserId}
                    onChange={(e) => updateUser(user.id, { role: e.target.value as UserRole })}
                    className="rounded-lg px-3 py-2 text-sm text-white outline-none"
                    style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                </td>
                <td className="px-4 py-4">
                  <div className="flex items-center gap-3">
                    <StatusBadge active={user.is_active} />
                    <Toggle
                      checked={user.is_active}
                      onChange={(checked) => updateUser(user.id, { is_active: checked })}
                      disabled={busyId === user.id || user.id === currentUserId}
                    />
                  </div>
                </td>
                <td className="px-4 py-4" style={{ color: '#94a3b8' }}>
                  {new Date(user.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <RoleBadge role={user.role} />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setResetUser(user)}
                      disabled={busyId === user.id}
                    >
                      <KeyRound size={14} />
                      Reset Password
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => deleteUser(user.id)}
                      disabled={busyId === user.id || user.id === currentUserId}
                    >
                      <Trash2 size={14} />
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>
                  No users found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create User">
        <form onSubmit={createUser} className="space-y-4">
          <Input
            label="Full name"
            value={form.full_name}
            onChange={(e) => setForm((current) => ({ ...current, full_name: e.target.value }))}
            required
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))}
            required
          />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" style={{ color: '#94a3b8' }}>Role</label>
            <select
              value={form.role}
              onChange={(e) => setForm((current) => ({ ...current, role: e.target.value as UserRole }))}
              className="w-full rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Input
            label="Temporary password"
            type="password"
            minLength={8}
            value={form.password}
            onChange={(e) => setForm((current) => ({ ...current, password: e.target.value }))}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busyId === 'create'}>Create User</Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!resetUser} onClose={() => setResetUser(null)} title="Reset Password">
        <form onSubmit={submitReset} className="space-y-4">
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            Set a new temporary password for {resetUser?.email}.
          </p>
          <Input
            label="New password"
            type="password"
            minLength={8}
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setResetUser(null)}>Cancel</Button>
            <Button type="submit" disabled={!!resetUser && busyId === resetUser.id}>Reset Password</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
