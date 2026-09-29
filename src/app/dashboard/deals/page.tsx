import TopBar from '@/components/layout/TopBar'
import { DealsTable } from '@/components/deals/DealsTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireInternalPage } from '@/lib/page-access'

export default async function DealsPage() {
  await requireInternalPage()
  return (
    <div>
      <TopBar title="Deals" />
      <div className="page-content">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Deals">
            <DealsTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
