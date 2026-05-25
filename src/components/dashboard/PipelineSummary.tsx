'use client'

import { Fragment, useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { STAGE_STATUSES, ALL_STATUSES } from '@/lib/lead-status'

interface StatusCount {
  status: string
  count: number
}

// Non-cumulative funnel: each stage shows ONLY leads currently in that stage.
// This ensures these counts match the Pipeline Kanban column counts exactly.
const FUNNEL = [
  {
    id: 'all',
    label: 'All Leads',
    sub: 'Total pipeline',
    color: '#818cf8',
    statuses: ALL_STATUSES as readonly string[],
    href: '/dashboard/leads',
  },
  {
    id: 'contacted',
    label: 'Contacted',
    sub: 'Pitch sent',
    color: '#fb923c',
    statuses: STAGE_STATUSES.contacted as readonly string[],
    href: '/dashboard/leads?status=contacted',
  },
  {
    id: 'replied',
    label: 'Replied',
    sub: 'Responded',
    color: '#4ade80',
    statuses: STAGE_STATUSES.replied as readonly string[],
    href: '/dashboard/leads?status=replied',
  },
  {
    id: 'negotiating',
    label: 'Negotiating',
    sub: 'Active deal',
    color: '#22d3ee',
    statuses: STAGE_STATUSES.negotiating as readonly string[],
    href: '/dashboard/leads?stage=negotiating',
  },
  {
    id: 'won',
    label: 'Won',
    sub: 'Deal closed',
    color: '#34d399',
    statuses: STAGE_STATUSES.closed as readonly string[],
    href: '/dashboard/leads?stage=closed',
  },
]

function rateColor(pct: number): string {
  if (pct >= 25) return '#34d399'
  if (pct >= 10) return '#fbbf24'
  return '#f87171'
}

interface PipelineSummaryProps {
  counts: StatusCount[]
}

export function PipelineSummary({ counts }: PipelineSummaryProps) {
  const [mounted, setMounted] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 80)
    return () => clearTimeout(t)
  }, [])

  const map = Object.fromEntries(counts.map((c) => [c.status, c.count]))

  const stages = FUNNEL.map((f) => ({
    ...f,
    count: f.statuses.reduce((sum, k) => sum + (map[k] ?? 0), 0),
  }))

  const topCount = Math.max(stages[0].count, 1)
  const deadCount = map['dead'] ?? 0
  const queueCount = (map['new'] ?? 0) + (map['researched'] ?? 0) + (map['email_ready'] ?? 0)
  const winRate = ((stages[4].count / topCount) * 100).toFixed(1)

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: '#13161f', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div>
          <h3 className="text-sm font-semibold leading-none" style={{ color: '#f1f5f9' }}>
            Sales Funnel
          </h3>
          <p className="text-xs mt-1" style={{ color: '#475569' }}>
            {topCount.toLocaleString()} active leads in pipeline
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span style={{ color: '#475569' }}>Win rate</span>
          <span
            className="font-bold px-2 py-0.5 rounded-full"
            style={{
              color: '#34d399',
              background: 'rgba(52,211,153,0.1)',
              border: '1px solid rgba(52,211,153,0.18)',
            }}
          >
            {winRate}%
          </span>
        </div>
      </div>

      {/* Stages */}
      <div className="p-4 md:p-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 lg:flex lg:items-stretch lg:gap-2">
          {stages.map((stage, i) => {
            const isHovered = hovered === stage.id
            const isLast = i === stages.length - 1
            const prevCount = i > 0 ? stages[i - 1].count : null
            const convPct =
              prevCount != null && prevCount > 0
                ? Math.round((stage.count / prevCount) * 100)
                : null
            const barPct = Math.max((stage.count / topCount) * 100, stage.count > 0 ? 3 : 0)

            return (
              <Fragment key={stage.id}>
                {/* Stage card */}
                <Link
                  href={stage.href}
                  onMouseEnter={() => setHovered(stage.id)}
                  onMouseLeave={() => setHovered(null)}
                  className="flex flex-col p-4 rounded-2xl lg:flex-1 transition-all duration-200"
                  style={{
                    background: isHovered
                      ? `linear-gradient(145deg, #161927 0%, ${stage.color}0d 100%)`
                      : 'linear-gradient(145deg, #161927 0%, #1a1d2e 100%)',
                    border: `1px solid ${isHovered ? `${stage.color}48` : 'rgba(255,255,255,0.055)'}`,
                    boxShadow: isHovered
                      ? `0 0 28px ${stage.color}1e, 0 4px 24px rgba(0,0,0,0.3)`
                      : '0 2px 12px rgba(0,0,0,0.2)',
                    textDecoration: 'none',
                    minWidth: 0,
                  }}
                >
                  {/* Top accent line */}
                  <div
                    style={{
                      height: '2px',
                      background: `linear-gradient(90deg, ${stage.color} 0%, transparent 80%)`,
                      opacity: isHovered ? 1 : 0.5,
                      borderRadius: '2px',
                      marginBottom: '14px',
                      flexShrink: 0,
                      transition: 'opacity 0.2s',
                    }}
                  />

                  {/* Count */}
                  <span
                    style={{
                      color: isHovered ? stage.color : '#f1f5f9',
                      transition: 'color 0.2s',
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: 1,
                    }}
                    className="text-[2.25rem] font-bold tracking-tight"
                  >
                    {stage.count.toLocaleString()}
                  </span>

                  {/* Label + sub */}
                  <p className="text-xs font-semibold mt-3 mb-0.5 leading-snug" style={{ color: '#cbd5e1' }}>
                    {stage.label}
                  </p>
                  <p className="text-[0.6875rem]" style={{ color: '#475569' }}>
                    {stage.sub}
                  </p>

                  {/* Conversion badge */}
                  <div className="mt-3 mb-3 min-h-[20px]">
                    {convPct !== null ? (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-bold"
                        style={{
                          color: rateColor(convPct),
                          background: `${rateColor(convPct)}18`,
                          border: `1px solid ${rateColor(convPct)}28`,
                        }}
                      >
                        {convPct}% conv.
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium"
                        style={{ color: '#334155', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                      >
                        Top of funnel
                      </span>
                    )}
                  </div>

                  {/* Progress bar — narrows proportionally to funnel */}
                  <div className="mt-auto">
                    <div
                      style={{
                        height: '3px',
                        background: 'rgba(255,255,255,0.06)',
                        borderRadius: '2px',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: mounted ? `${barPct}%` : '0%',
                          background: `linear-gradient(90deg, ${stage.color} 0%, ${stage.color}60 100%)`,
                          transition: `width ${0.5 + i * 0.1}s cubic-bezier(0.4, 0, 0.2, 1)`,
                          borderRadius: '2px',
                        }}
                      />
                    </div>
                  </div>
                </Link>

                {/* Desktop-only connector with conversion label */}
                {!isLast && (
                  <div className="hidden lg:flex flex-col items-center justify-center flex-shrink-0 gap-1 px-0.5">
                    {convPct !== null && (
                      <span
                        className="text-[0.5625rem] font-bold leading-none"
                        style={{ color: rateColor(convPct) }}
                      >
                        {convPct}%
                      </span>
                    )}
                    <ChevronRight size={14} strokeWidth={1.5} style={{ color: '#2a3040' }} />
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>

        {/* Footer — off-funnel stats */}
        <div
          className="mt-4 pt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5"
          style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
        >
          {queueCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: '#334155' }}
              />
              <span className="text-[0.6875rem]" style={{ color: '#475569' }}>
                <span className="font-semibold" style={{ color: '#64748b' }}>
                  {queueCount.toLocaleString()}
                </span>{' '}
                not yet contacted
              </span>
            </div>
          )}
          {deadCount > 0 && (
            <Link
              href="/dashboard/leads?status=dead"
              className="flex items-center gap-1.5 transition-opacity hover:opacity-75"
            >
              <span className="text-xs leading-none">💀</span>
              <span className="text-[0.6875rem]" style={{ color: '#475569' }}>
                <span className="font-semibold" style={{ color: '#64748b' }}>
                  {deadCount.toLocaleString()}
                </span>{' '}
                exited pipeline
              </span>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
