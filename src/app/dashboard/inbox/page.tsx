import TopBar from '@/components/layout/TopBar'
import { Card } from '@/components/ui/Card'
import { requireWorkspacePage } from '@/lib/page-access'
import { CustomerInbox } from '@/components/inbox/CustomerInbox'

export default async function InboxPage() {
  await requireWorkspacePage()

  return (
    <div>
      <TopBar title="Inbox" />
      <div className="page-content max-w-5xl">
        <Card className="!p-0 overflow-hidden"><CustomerInbox /></Card>
      </div>
    </div>
  )
}
