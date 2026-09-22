import Link from 'next/link'

export interface TabItem { label: string; href: string; active?: boolean }

export function Tabs({ items, label = 'Sections' }: { items: TabItem[]; label?: string }) {
  return <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-[var(--border-subtle)]">{items.map((item) => <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${item.active ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{item.label}</Link>)}</nav>
}
