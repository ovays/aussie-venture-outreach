'use client'

import Link from 'next/link'

interface StatusCount {
  status: string
  count: number
}

const STATUSES = [
  { key: 'new',         label: 'New',         color: '#60a5fa' },
  { key: 'researched',  label: 'Researched',  color: '#a78bfa' },
  { key: 'contacted',   label: 'Contacted',   color: '#fb923c' },
  { key: 'replied',     label: 'Replied',     color: '#4ade80' },
  { key: 'negotiating', label: 'Negotiating', color: '#2dd4bf' },
  { key: 'closed',      label: 'Closed',      color: '#34d399' },
  { key: 'dead',        label: 'Dead',        color: '#6b7280' },
]

interface PipelineSummaryProps {
  counts: StatusCount[]
}

export function PipelineSummary({ counts }: PipelineSummaryProps) {
  const countMap = Object.fromEntries(counts.map((c) => [c.status, c.count]))

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {STATUSES.map(({ key, label, color }) => {
        const count = countMap[key] ?? 0
        return (
          <Link
            key={key}
            href={`/dashboard/leads?status=${key}`}
            className="flex flex-col items-center gap-1 px-3 py-3 rounded-xl transition-opacity hover:opacity-80 text-center"
            style={{ background: `${color}10`, border: `1px solid ${color}25` }}
          >
            <span className="text-2xl font-bold" style={{ color }}>{count}</span>
            <span className="text-xs font-medium" style={{ color: `${color}cc` }}>{label}</span>
          </Link>
        )
      })}
    </div>
  )
}
