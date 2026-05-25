import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { LifecycleTable } from '@/components/lifecycle/LifecycleTable'

interface Props {
  searchParams: Promise<{ filter?: string }>
}

export default async function LifecyclePage({ searchParams }: Props) {
  const { filter } = await searchParams

  return (
    <div>
      <TopBar title="Lifecycle" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Lifecycle">
            <LifecycleTable initialFilter={filter} />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
