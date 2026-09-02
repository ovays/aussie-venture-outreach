import type { ReactNode } from 'react'

interface ResponsiveDataCardProps {
  title: ReactNode
  badge?: ReactNode
  children: ReactNode
  actions?: ReactNode
  onClick?: () => void
  selected?: boolean
  className?: string
}

export function ResponsiveDataCard({ title, badge, children, actions, onClick, selected, className = '' }: ResponsiveDataCardProps) {
  const Component = onClick ? 'button' : 'article'
  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`responsive-data-card ${onClick ? 'responsive-data-card--interactive' : ''} ${selected ? 'responsive-data-card--selected' : ''} ${className}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold text-[var(--text-primary)]">{title}</div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
      <div className="mt-3 min-w-0 space-y-2 text-left text-xs text-[var(--text-secondary)]">{children}</div>
      {actions && <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3" onClick={(event) => event.stopPropagation()}>{actions}</div>}
    </Component>
  )
}

export function DataCardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 break-words text-[var(--text-secondary)]">{children}</span>
    </div>
  )
}
