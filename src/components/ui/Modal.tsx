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
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        className={[
          'relative z-10 w-full overflow-y-auto',
          'h-full sm:h-auto sm:rounded-xl sm:max-h-[90vh]',
          'shadow-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        ].join(' ')}
        style={{ background: '#1a1d27', border: '1px solid #2a2d3e' }}
      >
        <div
          className="flex items-center justify-between px-4 sm:px-6 py-4 border-b sticky top-0"
          style={{ borderColor: '#2a2d3e', background: '#1a1d27' }}
        >
          <h3 className="text-base sm:text-lg font-semibold text-white pr-2">{title}</h3>
          <button
            onClick={onClose}
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
