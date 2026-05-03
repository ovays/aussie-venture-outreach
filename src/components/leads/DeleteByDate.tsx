'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

interface DeleteByDateProps {
  onDeleted: () => void
}

export function DeleteByDate({ onDeleted }: DeleteByDateProps) {
  const today = new Date().toISOString().slice(0, 10)

  const [date, setDate] = useState(today)
  const [checking, setChecking] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  async function handleCheck() {
    if (!date) return
    setChecking(true)
    setMessage(null)
    setCount(null)
    const res = await fetch(`/api/leads/delete-by-date?date=${date}`)
    const json = await res.json() as { count?: number; error?: string }
    setChecking(false)
    if (json.error) { setMessage({ text: json.error, ok: false }); return }
    setCount(json.count ?? 0)
    setModalOpen(true)
  }

  async function handleConfirm() {
    setDeleting(true)
    const res = await fetch('/api/leads/delete-by-date', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    })
    const json = await res.json() as { deleted?: number; error?: string }
    setDeleting(false)
    setModalOpen(false)
    if (json.error) {
      setMessage({ text: `Error: ${json.error}`, ok: false })
    } else {
      setMessage({ text: `Deleted ${json.deleted ?? 0} leads from ${date}`, ok: true })
      onDeleted()
    }
  }

  const labelDate = (d: string) => {
    const parsed = new Date(`${d}T12:00:00Z`)
    return `${parsed.getDate()} ${parsed.toLocaleString('en', { month: 'short', year: 'numeric' })}`
  }

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: '#2a2d3e', background: '#161824' }}
      >
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
          Delete by date
        </span>
        <input
          type="date"
          value={date}
          max={today}
          onChange={(e) => { setDate(e.target.value); setMessage(null) }}
          className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e', colorScheme: 'dark' }}
        />
        <Button
          variant="danger"
          size="sm"
          onClick={handleCheck}
          disabled={!date || checking}
        >
          <Trash2 size={13} />
          {checking ? 'Checking…' : 'Delete leads on this date'}
        </Button>

        {message && (
          <span className="text-xs" style={{ color: message.ok ? '#4ade80' : '#f87171' }}>
            {message.text}
          </span>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm Deletion"
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            This will permanently delete{' '}
            <span className="font-semibold text-white">{count} lead{count !== 1 ? 's' : ''}</span>{' '}
            added on{' '}
            <span className="font-semibold text-white">{labelDate(date)}</span>,
            along with all related emails, DMs, and follow-ups.
          </p>
          {count === 0 && (
            <p className="text-sm" style={{ color: '#fbbf24' }}>No leads found for this date.</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleConfirm}
              disabled={deleting || count === 0}
            >
              {deleting ? 'Deleting…' : `Delete ${count} lead${count !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
