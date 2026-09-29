import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireWorkspacePage } from '@/lib/page-access'

export default async function OutreachPage() {
  await requireWorkspacePage()

  return (
    <div>
      <TopBar title="Outreach" />
      <div className="page-content max-w-4xl">
        <Card>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Outreach setup is coming in the next phase</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Category targeting, message preferences, schedules, and progress will be managed here.
          </p>
        </Card>
      </div>
    </div>
  )
}
