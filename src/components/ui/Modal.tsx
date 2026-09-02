'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}

export function Modal({ open, onClose, title, children, wide }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={[
          'relative z-10 w-full max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto',
          'h-full sm:h-auto sm:rounded-xl sm:max-h-[90vh]',
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
            onClick={onClose}
            aria-label="Close dialog"
            className="flex items-center justify-center w-10 h-10 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 sm:px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
