import TopBar from '@/components/layout/TopBar'
import { EmailLogTable } from '@/components/email-log/EmailLogTable'
import { Card } from '@/components/ui/Card'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

export default function EmailLogPage() {
  return (
    <div>
      <TopBar title="Email Log" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <ErrorBoundary label="Email Log">
            <EmailLogTable />
          </ErrorBoundary>
        </Card>
      </div>
    </div>
  )
}
