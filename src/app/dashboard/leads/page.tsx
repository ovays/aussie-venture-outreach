import TopBar from '@/components/layout/TopBar'
import { LeadsTable } from '@/components/leads/LeadsTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

interface Props {
  searchParams: Promise<{ status?: string; stage?: string }>
}

export default async function LeadsPage({ searchParams }: Props) {
  const { status, stage } = await searchParams

  return (
    <div>
      <TopBar title="Leads" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Leads Table">
            <LeadsTable initialStatus={status} initialStage={stage} />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
