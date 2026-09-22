import type { ReactNode } from 'react'

interface StatsCardProps { label: string; value: string | number; sub?: string; icon?: ReactNode; tone?: 'primary' | 'success' | 'warning' | 'accent' }

const tones = {
  primary: ['var(--primary)', 'var(--primary-muted)'],
  success: ['var(--success)', 'var(--success-muted)'],
  warning: ['var(--warning)', 'var(--warning-muted)'],
  accent: ['var(--accent)', 'var(--accent-muted)'],
} as const

export function StatsCard({ label, value, sub, icon, tone = 'primary' }: StatsCardProps) {
  const [color, background] = tones[tone]
  return <div className="surface flex min-w-0 items-start justify-between gap-4 p-4 md:p-5"><div className="min-w-0"><p className="text-xs font-medium text-[var(--text-muted)]">{label}</p><p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[var(--text-primary)] md:text-3xl">{typeof value === 'number' ? value.toLocaleString() : value}</p>{sub && <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{sub}</p>}</div>{icon && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ color, background }}>{icon}</div>}</div>
}
