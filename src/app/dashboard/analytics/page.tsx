import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireWorkspacePage } from '@/lib/page-access'

export default async function AnalyticsPage() {
  await requireWorkspacePage()

  return (
    <div>
      <TopBar title="Analytics" />
      <div className="page-content max-w-4xl">
        <Card>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Customer analytics are coming in the next phase</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Business outcome reporting will appear here when the customer analytics view is ready.
          </p>
        </Card>
      </div>
    </div>
  )
}
