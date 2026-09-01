import { requireAdmin } from '@/lib/auth'
import TopBar from '@/components/layout/TopBar'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { DataQualityDashboard } from '@/components/data-quality/DataQualityDashboard'

export const revalidate = 0

export default async function DataQualityPage() {
  await requireAdmin()
  return (
    <div>
      <TopBar title="Admin / Data Quality" />
      <div className="p-3 md:p-6">
        <ErrorBoundary label="Data Quality">
          <DataQualityDashboard />
        </ErrorBoundary>
      </div>
    </div>
  )
}

