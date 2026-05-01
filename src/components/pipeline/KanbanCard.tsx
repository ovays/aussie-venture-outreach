'use client'

interface Lead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  status: string
  deal_value: number | null
  created_at: string
}

interface KanbanCardProps {
  lead: Lead
  onClick: () => void
}

function daysSince(date: string): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000)
}

export function KanbanCard({ lead, onClick }: KanbanCardProps) {
  const days = daysSince(lead.created_at)

  return (
    <div
      onClick={onClick}
      className="rounded-lg p-3 cursor-pointer transition-colors hover:border-sky-500/50"
      style={{ background: '#1a1d27', border: '1px solid #2a2d3e' }}
    >
      <p className="text-sm font-medium text-white leading-snug">{lead.business_name}</p>
      <p className="text-xs mt-1" style={{ color: '#64748b' }}>{lead.category_name}</p>
      <p className="text-xs" style={{ color: '#64748b' }}>{[lead.suburb, lead.city].filter(Boolean).join(', ')}</p>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs" style={{ color: '#475569' }}>{days}d</span>
        {lead.deal_value && (
          <span className="text-xs font-semibold" style={{ color: '#4ade80' }}>${lead.deal_value}</span>
        )}
      </div>
    </div>
  )
}
