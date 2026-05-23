'use client'

import { useState, useEffect, useMemo } from 'react'
import type { LifecycleLead } from '@/app/api/lifecycle/route'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Summary {
  fu1_due: number
  fu2_due: number
  reactivation_due: number
  awaiting_dead: number
  dead_today: number
}

type FilterKey = 'all' | 'fu1' | 'fu2' | 'reactivation' | 'awaiting_dead' | 'dead'
type SortKey = 'next_action_date' | 'days_since_initial' | 'stage'
type SortDir = 'asc' | 'desc'

// ── Stage badge colours (spec: gray, blue, purple, orange, yellow, amber, red) ─

const BADGE: Record<string, { bg: string; text: string }> = {
  'Initial Sent':      { bg: 'rgba(100,116,139,0.15)', text: '#94a3b8' },
  'Follow-up 1 Sent':  { bg: 'rgba(56,189,248,0.13)',  text: '#38bdf8' },
  'Follow-up 2 Sent':  { bg: 'rgba(167,139,250,0.14)', text: '#a78bfa' },
  'Follow-up 3 Sent':  { bg: 'rgba(167,139,250,0.10)', text: '#c4b5fd' },
  'Reactivation Due':  { bg: 'rgba(251,146,60,0.16)',  text: '#fb923c' },
  'Reactivated':       { bg: 'rgba(251,191,36,0.14)',  text: '#fbbf24' },
  'Awaiting Dead':     { bg: 'rgba(245,158,11,0.16)',  text: '#f59e0b' },
  'Dead':              { bg: 'rgba(239,68,68,0.13)',   text: '#f87171' },
  'Unknown':           { bg: 'rgba(100,116,139,0.08)', text: '#475569' },
}

// ── Mini timeline: 4 dots representing Init → FU1 → FU2 → React ───────────────

function stepsCompleted(stage: string): number {
  if (stage === 'Initial Sent') return 1
  if (stage === 'Follow-up 1 Sent') return 2
  if (['Follow-up 2 Sent', 'Follow-up 3 Sent', 'Reactivation Due'].includes(stage)) return 3
  return 4 // Reactivated, Awaiting Dead, Dead
}

function MiniTimeline({ stage }: { stage: string }) {
  const done = stepsCompleted(stage)
  const isTerminal = stage === 'Awaiting Dead' || stage === 'Dead'
  return (
    <div className="flex items-center gap-1" title={`${done} / 4 steps`}>
      {[0, 1, 2, 3].map((i) => {
        const complete = i < done
        const next = i === done && !isTerminal
        return (
          <span
            key={i}
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{
              background: complete ? '#4ade80' : next ? '#38bdf8' : '#2a2d3e',
              boxShadow: next ? '0 0 4px rgba(56,189,248,0.6)' : 'none',
            }}
          />
        )
      })}
    </div>
  )
}

// ── Next action date with urgency highlighting ─────────────────────────────────

function resolveDate(isoDate: string | null, isOverdue: boolean): {
  label: string; color: string; highlighted: boolean
} {
  if (!isoDate) return { label: '—', color: '#475569', highlighted: false }
  const target = new Date(isoDate)
  const d0 = new Date(); d0.setHours(0, 0, 0, 0)
  const d1 = new Date(d0); d1.setDate(d1.getDate() + 1)
  const d2 = new Date(d1); d2.setDate(d2.getDate() + 1)

  if (isOverdue || target < d0) return { label: 'Overdue',  color: '#ef4444', highlighted: true }
  if (target < d1)              return { label: 'Today',    color: '#fb923c', highlighted: true }
  if (target < d2)              return { label: 'Tomorrow', color: '#fbbf24', highlighted: true }

  return {
    label: target.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
    color: '#64748b',
    highlighted: false,
  }
}

// ── Summary cards ──────────────────────────────────────────────────────────────

const CARDS = [
  { key: 'fu1_due',          label: 'FU1 Due',         accent: '#38bdf8' },
  { key: 'fu2_due',          label: 'FU2 Due',          accent: '#a78bfa' },
  { key: 'reactivation_due', label: 'Reactivation Due', accent: '#fb923c' },
  { key: 'awaiting_dead',    label: 'Awaiting Dead',    accent: '#f59e0b' },
  { key: 'dead_today',       label: 'Dead Today',       accent: '#f87171' },
] as const

// ── Filter pill definitions ────────────────────────────────────────────────────

type PillDef = { key: FilterKey; label: string; fn: (l: LifecycleLead) => boolean }

const PILLS: PillDef[] = [
  { key: 'all',          label: 'All',          fn: () => true },
  { key: 'fu1',         label: 'FU1',          fn: (l) => l.filter_key === 'fu1' },
  { key: 'fu2',         label: 'FU2',          fn: (l) => l.filter_key === 'fu2' },
  { key: 'reactivation', label: 'Reactivation', fn: (l) => l.filter_key === 'reactivation' && l.stage !== 'Awaiting Dead' },
  { key: 'awaiting_dead', label: 'Awaiting Dead', fn: (l) => l.stage === 'Awaiting Dead' },
  { key: 'dead',         label: 'Dead',         fn: (l) => l.filter_key === 'dead' },
]

// ── Sorting ────────────────────────────────────────────────────────────────────

function sortLeads(rows: LifecycleLead[], key: SortKey, dir: SortDir): LifecycleLead[] {
  return [...rows].sort((a, b) => {
    let c = 0
    if (key === 'next_action_date') {
      const ta = a.next_action_date ? new Date(a.next_action_date).getTime() : 9e12
      const tb = b.next_action_date ? new Date(b.next_action_date).getTime() : 9e12
      c = ta - tb
    } else if (key === 'days_since_initial') {
      c = (a.days_since_initial ?? -1) - (b.days_since_initial ?? -1)
    } else {
      c = a.stage.localeCompare(b.stage)
    }
    return dir === 'asc' ? c : -c
  })
}

// ── Sortable column header ─────────────────────────────────────────────────────

function SortTh({
  label, col, sortKey, sortDir, onSort, className = '',
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir
  onSort: (k: SortKey) => void; className?: string
}) {
  const active = sortKey === col
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider cursor-pointer select-none whitespace-nowrap ${className}`}
      style={{ color: active ? '#38bdf8' : '#64748b' }}
      onClick={() => onSort(col)}
    >
      {label}
      <span className="ml-1" style={{ fontSize: '9px', opacity: active ? 1 : 0.3 }}>
        {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function LifecycleTable() {
  const [leads, setLeads] = useState<LifecycleLead[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('next_action_date')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/lifecycle')
      .then((r) => r.json())
      .then((json: { leads: LifecycleLead[]; summary: Summary }) => {
        setLeads(json.leads ?? [])
        setSummary(json.summary ?? null)
        setLoading(false)
      })
  }, [])

  function onSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const displayed = useMemo(() => {
    const pill = PILLS.find((p) => p.key === filter)!
    let rows = leads.filter(pill.fn)
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (l) => l.business_name.toLowerCase().includes(q) || l.email.toLowerCase().includes(q),
      )
    }
    return sortLeads(rows, sortKey, sortDir)
  }, [leads, filter, search, sortKey, sortDir])

  const pillCounts = useMemo(
    () => Object.fromEntries(PILLS.map((p) => [p.key, leads.filter(p.fn).length])),
    [leads],
  )

  return (
    <div>
      {/* ── Summary cards ── */}
      <div
        className="grid grid-cols-2 md:grid-cols-5 gap-3 p-4 md:p-5 border-b"
        style={{ borderColor: '#2a2d3e' }}
      >
        {CARDS.map(({ key, label, accent }) => (
          <div
            key={key}
            className="rounded-lg p-3 md:p-4"
            style={{ background: '#13151f', border: '1px solid #2a2d3e', borderTop: `2px solid ${accent}` }}
          >
            <p className="text-xs uppercase tracking-wide font-medium mb-2" style={{ color: '#475569' }}>
              {label}
            </p>
            <p className="text-2xl md:text-3xl font-bold leading-none" style={{ color: accent }}>
              {loading ? '—' : ((summary as unknown as Record<string, number>)?.[key] ?? 0)}
            </p>
          </div>
        ))}
      </div>

      {/* ── Toolbar: search + filter pills ── */}
      <div className="px-4 py-3 border-b space-y-2.5" style={{ borderColor: '#2a2d3e' }}>
        {/* Search */}
        <div className="relative w-full max-w-xs">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: '#475569' }}
            width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-md text-xs outline-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e', color: '#e2e8f0' }}
          />
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {PILLS.map(({ key, label }) => {
            const active = filter === key
            const count = (pillCounts[key] as number) ?? 0
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                style={
                  active
                    ? { background: 'rgba(2,132,199,0.2)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.35)' }
                    : { background: 'rgba(255,255,255,0.03)', color: '#64748b', border: '1px solid #2a2d3e' }
                }
              >
                {label}
                {!loading && (
                  <span className="ml-1.5 tabular-nums" style={{ opacity: 0.55 }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
          {!loading && (
            <span className="ml-auto text-xs" style={{ color: '#475569' }}>
              {displayed.length} lead{displayed.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: '640px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                Business
              </th>
              <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                Email
              </th>
              <SortTh label="Stage" col="stage" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="hidden sm:table-cell px-4 py-3 text-left text-xs font-medium uppercase tracking-wider whitespace-nowrap" style={{ color: '#64748b' }}>
                Progress
              </th>
              <SortTh label="Days" col="days_since_initial" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider whitespace-nowrap" style={{ color: '#64748b' }}>
                Next Action
              </th>
              <SortTh label="Date" col="next_action_date" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-14 text-center text-sm" style={{ color: '#475569' }}>
                  Loading…
                </td>
              </tr>
            ) : displayed.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-14 text-center text-sm" style={{ color: '#475569' }}>
                  {search.trim() ? `No results for "${search}"` : 'No leads in this filter'}
                </td>
              </tr>
            ) : (
              displayed.map((lead) => {
                const badge = BADGE[lead.stage] ?? BADGE['Unknown']
                const { label: dateLabel, color: dateColor, highlighted } = resolveDate(
                  lead.next_action_date,
                  lead.is_overdue,
                )
                return (
                  <tr
                    key={lead.id}
                    className="border-b"
                    style={{ borderColor: '#1a1d2a' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.018)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
                  >
                    {/* Business */}
                    <td className="px-4 py-3">
                      <span className="font-medium text-white leading-snug">{lead.business_name}</span>
                    </td>

                    {/* Email */}
                    <td className="hidden md:table-cell px-4 py-3 max-w-[160px]">
                      <span className="text-xs truncate block" style={{ color: '#475569' }}>
                        {lead.email}
                      </span>
                    </td>

                    {/* Stage badge */}
                    <td className="px-4 py-3">
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap"
                        style={{ background: badge.bg, color: badge.text }}
                      >
                        {lead.stage}
                      </span>
                    </td>

                    {/* Mini timeline dots */}
                    <td className="hidden sm:table-cell px-4 py-3">
                      <MiniTimeline stage={lead.stage} />
                    </td>

                    {/* Days since initial */}
                    <td className="px-4 py-3 tabular-nums text-xs" style={{ color: '#64748b' }}>
                      {lead.days_since_initial !== null ? `${lead.days_since_initial}d` : '—'}
                    </td>

                    {/* Next action text */}
                    <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: '#cbd5e1' }}>
                      {lead.next_action}
                    </td>

                    {/* Action date pill */}
                    <td className="px-4 py-3">
                      <span
                        className="text-xs font-semibold whitespace-nowrap"
                        style={
                          highlighted
                            ? {
                                background: `${dateColor}1a`,
                                color: dateColor,
                                padding: '2px 7px',
                                borderRadius: '4px',
                                border: `1px solid ${dateColor}30`,
                              }
                            : { color: dateColor }
                        }
                      >
                        {dateLabel}
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
