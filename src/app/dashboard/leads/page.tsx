import TopBar from '@/components/layout/TopBar'
import { LeadsTable } from '@/components/leads/LeadsTable'
import { CustomerLeads } from '@/components/leads/CustomerLeads'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireWorkspacePage } from '@/lib/page-access'
import { isCustomerLeadFilter } from '@/lib/customer-lead'

interface Props {
  searchParams: Promise<{ status?: string; stage?: string }>
}

export default async function LeadsPage({ searchParams }: Props) {
  const { workspace } = await requireWorkspacePage()
  const { status, stage } = await searchParams

  return (
    <div>
      <TopBar title="Leads" />
      <div className="page-content">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Leads Table">
            {workspace.isPlatformAdmin
              ? <LeadsTable initialStatus={status} initialStage={stage} />
              : <CustomerLeads initialStatus={isCustomerLeadFilter(status) ? status : 'all'} />}
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
