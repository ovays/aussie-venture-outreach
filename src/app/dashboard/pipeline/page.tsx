import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { KanbanBoard } from '@/components/pipeline/KanbanBoard'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

export const revalidate = 30

export default async function PipelinePage() {
  const supabase = await createClient()

  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .not('status', 'in', '("researched","email_ready")')
    .order('created_at', { ascending: false })
    .limit(500)

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Pipeline" />
      <ErrorBoundary label="KanbanBoard">
        <KanbanBoard leads={leads ?? []} />
      </ErrorBoundary>
    </div>
  )
}
