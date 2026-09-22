import type { ReactNode } from 'react'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span className="group/tooltip relative inline-flex" aria-label={label}>{children}<span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+0.5rem)] left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white shadow-lg group-hover/tooltip:block group-focus-within/tooltip:block">{label}</span></span>
}
