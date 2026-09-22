'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

export function DropdownMenu({ trigger, children, label }: { trigger: ReactNode; children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  return <div ref={ref} className="relative"><button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{trigger}</button>{open && <div role="menu" className="absolute right-0 top-[calc(100%+0.5rem)] z-50 min-w-48 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-1.5 shadow-xl">{children}</div>}</div>
}

export function DropdownMenuItem({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]">{children}</button>
}
