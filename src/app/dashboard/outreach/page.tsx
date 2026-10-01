import TopBar from '@/components/layout/TopBar'
import { requireWorkspacePage } from '@/lib/page-access'
import { getCustomerOutreach } from '@/lib/customer-outreach'
import { CustomerOutreachSettings } from '@/components/outreach/CustomerOutreachSettings'

export default async function OutreachPage() {
  const { workspace } = await requireWorkspacePage()
  const canEdit=workspace.isPlatformAdmin||workspace.role==='owner'||workspace.role==='admin'
  const data=await getCustomerOutreach(workspace.workspaceId,canEdit)

  return (
    <div>
      <TopBar title="Outreach" />
      <div className="page-content max-w-4xl"><CustomerOutreachSettings initialData={data} /></div>
    </div>
  )
}
