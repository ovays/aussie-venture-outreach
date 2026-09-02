import type { ReactNode } from 'react'

interface DataStateProps {
  title: string
  description?: string
  action?: ReactNode
  tone?: 'muted' | 'error'
  compact?: boolean
}

export function DataState({ title, description, action, tone = 'muted', compact = false }: DataStateProps) {
  return (
    <div className={`data-state ${compact ? 'data-state--compact' : ''} ${tone === 'error' ? 'data-state--error' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p className="data-state__title">{title}</p>
      {description && <p className="data-state__description">{description}</p>}
      {action && <div className="data-state__action">{action}</div>}
    </div>
  )
}

export function DataSkeleton({ rows = 4, card = false }: { rows?: number; card?: boolean }) {
  return (
    <div className={card ? 'space-y-3' : 'space-y-2'} aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`${card ? 'h-32 rounded-xl' : 'h-11 rounded-lg'} animate-pulse bg-[var(--surface-hover)]`} />
      ))}
    </div>
  )
}
