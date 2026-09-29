import TopBar from '@/components/layout/TopBar'
import { EmailReportDashboard } from '@/components/email-report/EmailReportDashboard'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { requireInternalPage } from '@/lib/page-access'

export default async function EmailReportPage() {
  await requireInternalPage()
  return (
    <div>
      <TopBar title="Email Report" />
      <div className="page-content">
        <ErrorBoundary label="Email Report">
          <EmailReportDashboard />
        </ErrorBoundary>
      </div>
    </div>
  )
}
