import { requireAdmin } from '@/lib/auth'
import { listAuditEvents } from '@/lib/audit/read'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { AuditLog } from '@/components/admin/AuditLog'

export const revalidate = 0

export default async function AdminAuditPage() {
  await requireAdmin()
  const initial = await listAuditEvents({ limit: 50 })
  return <div><TopBar title="Audit Log" /><div className="page-content page-stack"><div><h1 className="text-xl font-semibold">Platform audit log</h1><p className="mt-1 text-sm text-[var(--text-muted)]">Append-only administrative and workspace security events.</p></div><Card><AuditLog initial={initial} /></Card></div></div>
}
