import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

export interface BreadcrumbItem { label: string; href?: string }

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  if (items.length < 2) return null
  return (
    <nav aria-label="Breadcrumb" className="mb-1 hidden items-center gap-1 text-xs text-[var(--text-muted)] sm:flex">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
          {item.href ? <Link href={item.href} className="truncate hover:text-[var(--primary)]">{item.label}</Link> : <span className="truncate">{item.label}</span>}
        </span>
      ))}
    </nav>
  )
}
