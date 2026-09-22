import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-5 py-12 text-center" role="status">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--background-subtle)] text-[var(--text-muted)]">{icon ?? <Inbox size={20} />}</div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-[var(--text-muted)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
