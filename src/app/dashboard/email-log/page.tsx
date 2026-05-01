import TopBar from '@/components/layout/TopBar'
import { EmailLogTable } from '@/components/email-log/EmailLogTable'
import { Card } from '@/components/ui/Card'

export default function EmailLogPage() {
  return (
    <div>
      <TopBar title="Email Log" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <EmailLogTable />
        </Card>
      </div>
    </div>
  )
}
