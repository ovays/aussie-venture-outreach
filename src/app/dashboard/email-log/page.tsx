import TopBar from '@/components/layout/TopBar'
import { EmailLogTable } from '@/components/email-log/EmailLogTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireInternalPage } from '@/lib/page-access'

export default async function EmailLogPage() {
  await requireInternalPage()
  return (
    <div>
      <TopBar title="Email Log" />
      <div className="page-content">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Email Log">
            <EmailLogTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
