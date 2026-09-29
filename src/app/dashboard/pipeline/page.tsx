import TopBar from '@/components/layout/TopBar'
import { KanbanBoard } from '@/components/pipeline/KanbanBoard'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireInternalPage } from '@/lib/page-access'

export default async function PipelinePage() {
  await requireInternalPage()
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Pipeline" />
      <ErrorBoundary label="KanbanBoard">
        <KanbanBoard />
      </ErrorBoundary>
    </div>
  )
}
