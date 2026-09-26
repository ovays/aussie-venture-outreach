import { requireAdmin } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { UserManagement } from '@/components/admin/UserManagement'
import type { Profile } from '@/lib/auth-types'
import { UsageAdministration } from '@/components/admin/UsageAdministration'

export const revalidate = 0

export default async function AdminPage() {
  const { user } = await requireAdmin()
  const supabase = createServiceClient()

  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return (
    <div>
      <TopBar title="Admin" />
      <div className="page-content page-stack">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Team &amp; member access</h1>
          <p className="text-sm mt-1 text-[var(--text-muted)]">
            Admin-created accounts, role assignment, account status, password resets, and deletions.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {['Users', 'Roles', 'Create User', 'Disable User', 'Delete User', 'Reset Password'].map((label) => (
            <span
              key={label}
              className="rounded-full border border-[var(--border)] bg-[var(--background-subtle)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)]"
            >
              {label}
            </span>
          ))}
        </div>

        <Card>
          <UserManagement initialUsers={(users ?? []) as Profile[]} currentUserId={user.id} />
        </Card>
        <Card>
          <UsageAdministration />
        </Card>
      </div>
    </div>
  )
}
