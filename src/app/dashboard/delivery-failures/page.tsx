import TopBar from '@/components/layout/TopBar'
import { DeliveryFailuresTable } from '@/components/delivery-failures/DeliveryFailuresTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

export default function DeliveryFailuresPage() {
  return (
    <div>
      <TopBar title="Delivery Failures" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Delivery Failures">
            <DeliveryFailuresTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
