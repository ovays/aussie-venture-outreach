import { requireAdmin } from '@/lib/auth'
import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { UsageAdministration } from '@/components/admin/UsageAdministration'
import { BillingAdministration } from '@/components/admin/BillingAdministration'

export default async function AdminUsagePage() {
  await requireAdmin()
  return <div><TopBar title="Usage & Billing" /><div className="page-content page-stack"><div><h1 className="text-xl font-semibold">Usage &amp; billing</h1><p className="mt-1 text-sm text-[var(--text-muted)]">Manage workspace entitlements and review subscription state.</p></div><Card><UsageAdministration /></Card><Card><BillingAdministration /></Card></div></div>
}
