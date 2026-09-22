import { Skeleton } from '@/components/ui/Skeleton'

export default function DashboardLoading() {
  return (
    <div aria-label="Loading page" aria-busy="true">
      <div className="border-b border-[var(--border-subtle)] bg-white px-[var(--page-gutter)] py-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="mt-2 h-3 w-64 max-w-full" />
      </div>
      <div className="page-content space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32" />)}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
      </div>
    </div>
  )
}
