import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireWorkspacePage } from '@/lib/page-access'

export default async function InboxPage() {
  await requireWorkspacePage()

  return (
    <div>
      <TopBar title="Inbox" />
      <div className="page-content max-w-4xl">
        <Card>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Your communications inbox is coming in the next phase</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Replies and delivery results will appear here once this customer view is connected.
          </p>
        </Card>
      </div>
    </div>
  )
}
