import TopBar from '@/components/layout/TopBar'
import { DeliveryFailuresTable } from '@/components/delivery-failures/DeliveryFailuresTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireInternalPage } from '@/lib/page-access'

export default async function DeliveryFailuresPage() {
  await requireInternalPage()
  return (
    <div>
      <TopBar title="Delivery Failures" />
      <div className="page-content">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Delivery Failures">
            <DeliveryFailuresTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
