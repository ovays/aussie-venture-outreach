import { requireAdmin } from '@/lib/auth'
import TopBar from '@/components/layout/TopBar'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { DataQualityDashboard } from '@/components/data-quality/DataQualityDashboard'

export const revalidate = 0

export default async function DataQualityPage() {
  await requireAdmin()
  return (
    <div>
      <TopBar title="Data Quality" subtitle="Review duplicate, invalid, and incomplete lead data" />
      <div className="page-content">
        <ErrorBoundary label="Data Quality">
          <DataQualityDashboard />
        </ErrorBoundary>
      </div>
    </div>
  )
}
