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
  const location = [lead.suburb, lead.city].filter(Boolean).join(', ')

  return (
    <div
      onClick={onClick}
      className="rounded-lg p-3 cursor-pointer group"
      style={{ background: '#1a1d2b', border: '1px solid #2a2d3e' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = '#0284c7' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = '#2a2d3e' }}
    >
      <p className="text-sm font-semibold text-white leading-snug group-hover:text-sky-300 transition-colors">
        {lead.business_name}
      </p>
      <p className="text-xs mt-1" style={{ color: '#64748b' }}>{lead.category_name}</p>
      {location && (
        <p className="text-xs" style={{ color: '#475569' }}>{location}</p>
      )}
      <div className="flex items-center justify-between mt-2.5 pt-2" style={{ borderTop: '1px solid #1e2130' }}>
        <span className="text-xs" style={{ color: days > 7 ? '#f87171' : '#475569' }}>
          {days}d ago
        </span>
        {lead.deal_value && (
          <span
            className="text-xs font-semibold px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80' }}
          >
            ${lead.deal_value}
          </span>
        )}
      </div>
    </div>
  )
}
