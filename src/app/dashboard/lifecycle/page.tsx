import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { LifecycleTable } from '@/components/lifecycle/LifecycleTable'

export default function LifecyclePage() {
  return (
    <div>
      <TopBar title="Lifecycle" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Lifecycle">
            <LifecycleTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
