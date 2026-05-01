import { Card } from '@/components/ui/Card'

interface StatsCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: string
}

export function StatsCard({ label, value, sub, accent }: StatsCardProps) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wider mb-1" style={{ color: '#64748b' }}>
        {label}
      </p>
      <p className="text-3xl font-bold" style={{ color: accent ?? '#e2e8f0' }}>
        {value}
      </p>
      {sub && <p className="text-xs mt-1" style={{ color: '#64748b' }}>{sub}</p>}
    </Card>
  )
}
