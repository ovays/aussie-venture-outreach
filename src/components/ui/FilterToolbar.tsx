import type { ReactNode } from 'react'

interface FilterToolbarProps {
  children: ReactNode
  actions?: ReactNode
  resultCount?: ReactNode
  className?: string
  ariaLabel?: string
}

export function FilterToolbar({
  children,
  actions,
  resultCount,
  className = '',
  ariaLabel = 'Filters',
}: FilterToolbarProps) {
  return (
    <div className={`filter-toolbar ${className}`} role="search" aria-label={ariaLabel}>
      <div className="filter-toolbar__controls">{children}</div>
      {(resultCount || actions) && (
        <div className="filter-toolbar__aside">
          {resultCount && <div className="filter-toolbar__count" aria-live="polite">{resultCount}</div>}
          {actions && <div className="filter-toolbar__actions">{actions}</div>}
        </div>
      )}
    </div>
  )
}
