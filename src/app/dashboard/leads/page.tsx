import TopBar from '@/components/layout/TopBar'
import { LeadsTable } from '@/components/leads/LeadsTable'
import { Card } from '@/components/ui/Card'

interface Props {
  searchParams: Promise<{ status?: string }>
}

export default async function LeadsPage({ searchParams }: Props) {
  const { status } = await searchParams

  return (
    <div>
      <TopBar title="Leads" />
      <div className="p-6">
        <Card className="!p-0 overflow-hidden">
          <LeadsTable initialStatus={status} />
        </Card>
      </div>
    </div>
  )
}
