import TopBar from '@/components/layout/TopBar'
import { DealsTable } from '@/components/deals/DealsTable'
import { Card } from '@/components/ui/Card'

export default function DealsPage() {
  return (
    <div>
      <TopBar title="Deals" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <DealsTable />
        </Card>
      </div>
    </div>
  )
}
