'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}

export function Modal({ open, onClose, title, children, wide }: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={[
          'relative z-10 w-full max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto',
          'h-full sm:h-auto sm:rounded-2xl sm:max-h-[90vh]',
          'shadow-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        ].join(' ')}
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
      >
        <div
          className="sticky top-0 z-20 flex items-center justify-between border-b px-4 py-4 sm:px-6"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
        >
          <h3 id="modal-title" className="pr-2 text-base font-semibold text-[var(--text-primary)] sm:text-lg">{title}</h3>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close dialog"
            className="flex items-center justify-center w-10 h-10 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 sm:px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
