'use client'

import Link from 'next/link'

interface StatusCount {
  status: string
  count: number
}

const STATUSES = [
  { key: 'new', label: 'New', color: '#60a5fa' },
  { key: 'researched', label: 'Researched', color: '#a78bfa' },
  { key: 'contacted', label: 'Contacted', color: '#fb923c' },
  { key: 'replied', label: 'Replied', color: '#4ade80' },
  { key: 'negotiating', label: 'Negotiating', color: '#2dd4bf' },
  { key: 'closed', label: 'Closed', color: '#34d399' },
  { key: 'dead', label: 'Dead', color: '#6b7280' },
]

interface PipelineSummaryProps {
  counts: StatusCount[]
}

export function PipelineSummary({ counts }: PipelineSummaryProps) {
  const countMap = Object.fromEntries(counts.map((c) => [c.status, c.count]))

  return (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map(({ key, label, color }) => (
        <Link
          key={key}
          href={`/dashboard/leads?status=${key}`}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-opacity hover:opacity-80"
          style={{ background: `${color}20`, color }}
        >
          {label}
          <span
            className="font-bold px-1.5 py-0.5 rounded-full text-xs"
            style={{ background: `${color}30` }}
          >
            {countMap[key] ?? 0}
          </span>
        </Link>
      ))}
    </div>
  )
}
