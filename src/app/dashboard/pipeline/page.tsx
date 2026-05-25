import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { KanbanBoard } from '@/components/pipeline/KanbanBoard'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { buildStageCounts } from '@/lib/lead-status'

export const revalidate = 30

export default async function PipelinePage() {
  const supabase = await createClient()

  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .not('status', 'in', '("researched","email_ready")')
    .order('created_at', { ascending: false })
    .limit(2000)

  const statusMap: Record<string, number> = {}
  for (const lead of leads ?? []) {
    statusMap[lead.status] = (statusMap[lead.status] ?? 0) + 1
  }
  const stageCounts = buildStageCounts(statusMap)
  console.log('[STAGE_COUNTS_PIPELINE]', {
    source: 'leads (excl. researched/email_ready, limit 2000)',
    total_loaded: leads?.length ?? 0,
    raw_status_map: statusMap,
    stage_counts: stageCounts,
    note: 'negotiating = negotiating+interested, closed = closed+closed_won+closed_manual',
  })

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Pipeline" />
      <ErrorBoundary label="KanbanBoard">
        <KanbanBoard leads={leads ?? []} />
      </ErrorBoundary>
    </div>
  )
}
