import TopBar from '@/components/layout/TopBar'
import { DMQueueTable } from '@/components/dm-queue/DMQueueTable'
import { Card } from '@/components/ui/Card'

export default function DMQueuePage() {
  return (
    <div>
      <TopBar title="DM Queue" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <DMQueueTable />
        </Card>
      </div>
    </div>
  )
}
