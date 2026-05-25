'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Send, MessageSquare, TrendingUp, RotateCcw, AlertTriangle,
  ArrowRight, CheckCircle2, ListTodo,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ─── props ───────────────────────────────────────────────────────────────────

export interface WorkflowQueueProps {
  fu1Due: number
  fu2Due: number
  fu3Overdue: number
  repliesToReview: number
  negotiationsActive: number
  reactivationQueue: number
  initialSentToday: number
  fu1SentToday: number
  fu2SentToday: number
  fu3SentToday: number
  dmsToday: number
  repliesToday: number
}

// ─── types ────────────────────────────────────────────────────────────────────

type Priority = 'urgent' | 'high' | 'medium' | 'queue'

interface TaskDef {
  id: string
  title: string
  subtitle: string
  count: number
  priority: Priority
  accent: string
  href: string
  ctaLabel: string
  icon: LucideIcon
  pulse: boolean
}

interface DoneItem {
  label: string
  count: number
}

// ─── constants ────────────────────────────────────────────────────────────────

const PRIORITY_GROUPS: { key: Priority; label: string; dotColor: string }[] = [
  { key: 'urgent', label: 'URGENT',  dotColor: '#f87171' },
  { key: 'high',   label: 'HIGH',    dotColor: '#fb923c' },
  { key: 'medium', label: 'ACTIVE',  dotColor: '#a78bfa' },
  { key: 'queue',  label: 'QUEUE',   dotColor: '#475569' },
]

// ─── component ────────────────────────────────────────────────────────────────

export function WorkflowQueue({
  fu1Due,
  fu2Due,
  fu3Overdue,
  repliesToReview,
  negotiationsActive,
  reactivationQueue,
  initialSentToday,
  fu1SentToday,
  fu2SentToday,
  fu3SentToday,
  dmsToday,
  repliesToday,
}: WorkflowQueueProps) {
  const [mounted, setMounted] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60)
    return () => clearTimeout(t)
  }, [])

  // Build task list from props
  const allTasks: TaskDef[] = [
    {
      id: 'fu3',
      title: 'Overdue Follow-ups',
      subtitle: 'Past final follow-up window — needs immediate action',
      count: fu3Overdue,
      priority: 'urgent',
      accent: '#f87171',
      href: '/dashboard/lifecycle?filter=overdue',
      ctaLabel: 'Review Now',
      icon: AlertTriangle,
      pulse: fu3Overdue > 0,
    },
    {
      id: 'replies',
      title: 'Replies to Review',
      subtitle: 'Someone responded — keep the conversation warm',
      count: repliesToReview,
      priority: 'urgent',
      accent: '#38bdf8',
      href: '/dashboard/leads?status=replied',
      ctaLabel: 'Open Inbox',
      icon: MessageSquare,
      pulse: repliesToReview > 0,
    },
    {
      id: 'fu1',
      title: 'FU1 Emails Due',
      subtitle: 'First follow-up sequence ready to send',
      count: fu1Due,
      priority: 'high',
      accent: '#fb923c',
      href: '/dashboard/lifecycle?filter=fu_due',
      ctaLabel: 'Start Queue',
      icon: Send,
      pulse: false,
    },
    {
      id: 'fu2',
      title: 'FU2 Emails Due',
      subtitle: 'Second follow-up — final nudge before cooling',
      count: fu2Due,
      priority: 'high',
      accent: '#fbbf24',
      href: '/dashboard/lifecycle?filter=fu_due',
      ctaLabel: 'Start Queue',
      icon: Send,
      pulse: false,
    },
    {
      id: 'negotiations',
      title: 'Negotiations Active',
      subtitle: 'Active conversations — keep momentum going',
      count: negotiationsActive,
      priority: 'medium',
      accent: '#a78bfa',
      href: '/dashboard/leads?status=negotiating',
      ctaLabel: 'Review Leads',
      icon: TrendingUp,
      pulse: false,
    },
    {
      id: 'reactivation',
      title: 'Reactivation Queue',
      subtitle: 'Cold leads ready for DM re-engagement',
      count: reactivationQueue,
      priority: 'queue',
      accent: '#64748b',
      href: '/dashboard/lifecycle?filter=reactivation',
      ctaLabel: 'Open Queue',
      icon: RotateCcw,
      pulse: false,
    },
  ]

  // Only show tasks with count > 0
  const activeTasks = allTasks.filter((t) => t.count > 0)

  // Done today items
  const doneItems: DoneItem[] = [
    { label: 'Initial Pitches Sent', count: initialSentToday },
    { label: 'FU1 Sent',            count: fu1SentToday },
    { label: 'FU2 Sent',            count: fu2SentToday },
    { label: 'FU3 Sent',            count: fu3SentToday },
    { label: 'DMs Sent',            count: dmsToday },
    { label: 'Replies Today',       count: repliesToday },
  ].filter((d) => d.count > 0)

  const pendingCount = activeTasks.length
  const doneTodayTotal = doneItems.reduce((s, d) => s + d.count, 0)
  const progressPct = doneTodayTotal > 0
    ? Math.min(Math.round((doneTodayTotal / (doneTodayTotal + activeTasks.reduce((s, t) => s + t.count, 0))) * 100), 100)
    : 0

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: '#161927', border: '1px solid rgba(255,255,255,0.055)' }}
    >
      {/* ── Header ── */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="p-1.5 rounded-lg"
            style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}
          >
            <ListTodo size={14} strokeWidth={2} />
          </div>
          <div>
            <span className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>
              Today&apos;s Tasks
            </span>
            <span className="text-xs ml-2" style={{ color: '#334155' }}>
              Your outreach workflow
            </span>
          </div>
        </div>

        {/* Progress row */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            {pendingCount > 0 ? (
              <span style={{ color: '#64748b' }}>
                <span className="font-semibold" style={{ color: '#94a3b8' }}>{pendingCount}</span>
                {' '}pending
              </span>
            ) : (
              <span className="font-semibold" style={{ color: '#34d399' }}>All clear ✓</span>
            )}
            {doneItems.length > 0 && (
              <>
                <span style={{ color: '#1e293b' }}>·</span>
                <span style={{ color: '#34d399' }}>
                  <span className="font-semibold">{doneTodayTotal}</span>
                  {' '}done today
                </span>
              </>
            )}
          </div>

          {/* Progress bar */}
          {(pendingCount > 0 || doneItems.length > 0) && (
            <div className="flex items-center gap-2">
              <div
                className="rounded-full overflow-hidden"
                style={{ width: '80px', height: '5px', background: 'rgba(255,255,255,0.06)' }}
              >
                <div
                  style={{
                    height: '100%',
                    width: mounted ? `${progressPct}%` : '0%',
                    background: 'linear-gradient(90deg, #a78bfa 0%, #34d399 100%)',
                    transition: 'width 0.9s cubic-bezier(0.4, 0, 0.2, 1)',
                    borderRadius: '9999px',
                  }}
                />
              </div>
              <span className="text-[0.6875rem] font-bold tabular-nums" style={{ color: '#475569' }}>
                {progressPct}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Task list ── */}
      <div className="px-4 py-3">
        {activeTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle2 size={32} style={{ color: '#34d399', opacity: 0.5 }} className="mb-3" />
            <p className="text-sm font-semibold" style={{ color: '#64748b' }}>
              You&apos;re all caught up
            </p>
            <p className="text-xs mt-1" style={{ color: '#334155' }}>
              No pending tasks right now. Check back after the next pipeline run.
            </p>
          </div>
        ) : (
          PRIORITY_GROUPS.map(({ key, label, dotColor }) => {
            const group = activeTasks.filter((t) => t.priority === key)
            if (group.length === 0) return null

            return (
              <div key={key} className="mb-1 last:mb-0">
                {/* Group divider */}
                <div className="flex items-center gap-2 mb-1 mt-3 first:mt-0">
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: dotColor }}
                  />
                  <span
                    className="text-[0.5625rem] font-bold tracking-widest"
                    style={{ color: '#334155' }}
                  >
                    {label}
                  </span>
                  <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.04)' }} />
                </div>

                {/* Task rows */}
                {group.map((task) => {
                  const isHovered = hovered === task.id
                  const Icon = task.icon

                  return (
                    <div
                      key={task.id}
                      onMouseEnter={() => setHovered(task.id)}
                      onMouseLeave={() => setHovered(null)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-default transition-all duration-150"
                      style={{
                        background: isHovered
                          ? `${task.accent}09`
                          : 'transparent',
                      }}
                    >
                      {/* Urgency dot with optional pulse */}
                      <div className="relative flex items-center justify-center w-3 flex-shrink-0">
                        {task.pulse && (
                          <span
                            className="absolute w-3 h-3 rounded-full animate-ping"
                            style={{ background: task.accent, opacity: 0.3 }}
                          />
                        )}
                        <span
                          className="relative w-2 h-2 rounded-full block"
                          style={{
                            background: task.accent,
                            boxShadow: task.pulse ? `0 0 6px ${task.accent}` : 'none',
                          }}
                        />
                      </div>

                      {/* Icon */}
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{
                          background: `${task.accent}14`,
                          color: task.accent,
                          boxShadow: isHovered ? `0 0 10px ${task.accent}20` : 'none',
                          transition: 'box-shadow 0.15s',
                        }}
                      >
                        <Icon size={13} strokeWidth={2} />
                      </div>

                      {/* Title + subtitle */}
                      <div className="flex-1 min-w-0">
                        <p
                          className="text-[0.8125rem] font-semibold leading-none"
                          style={{ color: isHovered ? '#f1f5f9' : '#cbd5e1', transition: 'color 0.15s' }}
                        >
                          {task.title}
                        </p>
                        <p
                          className="text-[0.6875rem] mt-0.5 truncate"
                          style={{ color: '#334155' }}
                        >
                          {task.subtitle}
                        </p>
                      </div>

                      {/* Count chip */}
                      <span
                        className="inline-flex items-center justify-center px-2.5 py-1 rounded-lg text-sm font-bold tabular-nums flex-shrink-0"
                        style={{
                          color: task.accent,
                          background: `${task.accent}18`,
                          border: `1px solid ${task.accent}25`,
                          minWidth: '2.75rem',
                          transition: 'background 0.15s',
                        }}
                      >
                        {task.count.toLocaleString()}
                      </span>

                      {/* CTA */}
                      <Link
                        href={task.href}
                        className="hidden sm:flex flex-shrink-0 items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all duration-150"
                        style={{
                          color: task.accent,
                          background: isHovered ? `${task.accent}20` : `${task.accent}0c`,
                          border: `1px solid ${isHovered ? `${task.accent}35` : `${task.accent}18`}`,
                          minWidth: '7rem',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>{task.ctaLabel}</span>
                        <ArrowRight
                          size={10}
                          strokeWidth={2.5}
                          style={{
                            transform: isHovered ? 'translateX(2px)' : 'translateX(0)',
                            transition: 'transform 0.15s',
                          }}
                        />
                      </Link>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}

        {/* ── Done Today ── */}
        {doneItems.length > 0 && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 size={11} style={{ color: '#22c55e' }} />
              <span
                className="text-[0.5625rem] font-bold tracking-widest"
                style={{ color: '#334155' }}
              >
                DONE TODAY
              </span>
              <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.04)' }} />
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-1">
              {doneItems.map((item) => (
                <div key={item.label} className="flex items-center gap-1.5">
                  <CheckCircle2 size={11} style={{ color: '#22c55e', opacity: 0.7 }} />
                  <span className="text-xs" style={{ color: '#475569' }}>
                    <span className="font-semibold" style={{ color: '#64748b' }}>
                      {item.count.toLocaleString()}
                    </span>
                    {' '}{item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
