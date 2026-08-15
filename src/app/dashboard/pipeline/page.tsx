import TopBar from '@/components/layout/TopBar'
import { KanbanBoard } from '@/components/pipeline/KanbanBoard'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

export default function PipelinePage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Pipeline" />
      <ErrorBoundary label="KanbanBoard">
        <KanbanBoard />
      </ErrorBoundary>
    </div>
  )
}
