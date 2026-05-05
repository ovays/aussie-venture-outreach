'use client'

import { useState, useEffect, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import { PlatformBadge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatDate } from '@/lib/utils'

interface DMItem {
  id: string
  platform: 'instagram' | 'facebook'
  handle: string
  message_text: string
  status: 'pending' | 'sent' | 'skipped'
  created_at: string
  leads: { business_name: string; category_name: string; city: string } | null
}

export function DMQueueTable() {
  const [items, setItems] = useState<DMItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<DMItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('pending')
  const [platformFilter, setPlatformFilter] = useState('')

  const fetchItems = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (platformFilter) params.set('platform', platformFilter)

    const res = await fetch(`/api/dm-queue?${params}`)
    const json = await res.json() as { data: DMItem[] }
    setItems(json.data ?? [])
    setLoading(false)
  }, [statusFilter, platformFilter])

  useEffect(() => { fetchItems() }, [fetchItems])

  async function updateStatus(id: string, status: 'sent' | 'skipped') {
    await fetch('/api/dm-queue', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, status } : i))
  }

  async function copyMessage(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function copyInline(id: string, text: string) {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  function handleUrl(item: DMItem): string {
    const raw = item.handle.replace(/^@/, '')
    if (item.platform === 'facebook') {
      return item.handle.startsWith('http') ? item.handle : `https://facebook.com/${raw}`
    }
    return `https://instagram.com/${raw}`
  }

  return (
    <div>
      {/* Info bar */}
      <div className="px-4 md:px-5 py-3 md:py-4 border-b" style={{ borderColor: '#2a2d3e' }}>
        <p className="text-sm" style={{ color: '#94a3b8' }}>
          These businesses have Instagram/Facebook. Send them a DM manually from the Instagram app.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
        {(['', 'pending', 'sent', 'skipped'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-2 rounded-full text-xs font-medium transition-colors min-h-[36px]"
            style={{
              background: statusFilter === s ? '#0284c7' : '#1e2130',
              color: statusFilter === s ? 'white' : '#94a3b8',
            }}
          >
            {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          {(['', 'instagram', 'facebook'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatformFilter(p)}
              className="px-3 py-2 rounded-full text-xs font-medium transition-colors min-h-[36px]"
              style={{
                background: platformFilter === p ? '#2a2d3e' : 'transparent',
                color: platformFilter === p ? 'white' : '#64748b',
              }}
            >
              {p === '' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Mobile card view ── */}
      <div className="md:hidden">
        {loading ? (
          <p className="px-4 py-12 text-center text-sm" style={{ color: '#64748b' }}>Loading...</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm" style={{ color: '#64748b' }}>No DMs in queue</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="px-4 py-4 border-b" style={{ borderColor: '#1e2130' }}>
              {/* Top row: business + status */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="font-medium text-white truncate">{item.leads?.business_name ?? '—'}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>{item.leads?.city}</p>
                </div>
                <StatusBadge status={item.status} />
              </div>

              {/* Handle + message preview stacked */}
              <a
                href={handleUrl(item)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs hover:text-sky-400 transition-colors block mb-1"
                style={{ color: '#94a3b8' }}
                onClick={(e) => e.stopPropagation()}
              >
                {item.handle}
              </a>
              <p className="text-xs mb-3" style={{ color: '#64748b' }}>
                {item.message_text.slice(0, 100)}...
              </p>

              {/* Action buttons — stacked vertically */}
              {item.status === 'pending' ? (
                <div className="flex flex-col gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full justify-center"
                    onClick={() => copyInline(item.id, item.message_text)}
                  >
                    {copiedId === item.id ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy DM</>}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="w-full justify-center"
                    onClick={() => updateStatus(item.id, 'sent')}
                  >
                    Mark Sent
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-center"
                    onClick={() => updateStatus(item.id, 'skipped')}
                  >
                    Skip
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setSelectedItem(item)}>
                  View
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Desktop table view ── */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
              {['Business', 'Platform', 'Handle', 'Message Preview', 'Status', 'Added', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center" style={{ color: '#64748b' }}>No DMs in queue</td></tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b" style={{ borderColor: '#1e2130' }}>
                  <td className="px-4 py-3">
                    <div className="text-white font-medium">{item.leads?.business_name ?? '—'}</div>
                    <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>{item.leads?.city}</div>
                  </td>
                  <td className="px-4 py-3"><PlatformBadge platform={item.platform} /></td>
                  <td className="px-4 py-3">
                    <a
                      href={handleUrl(item)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs hover:text-sky-400 transition-colors"
                      style={{ color: '#94a3b8' }}
                    >
                      {item.handle}
                    </a>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <p className="text-xs truncate" style={{ color: '#94a3b8' }}>{item.message_text.slice(0, 80)}...</p>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                  <td className="px-4 py-3 text-xs" style={{ color: '#64748b' }}>{formatDate(item.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {item.status === 'pending' ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => copyInline(item.id, item.message_text)}>
                            {copiedId === item.id ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy DM</>}
                          </Button>
                          <Button size="sm" variant="primary" onClick={() => updateStatus(item.id, 'sent')}>
                            Mark Sent
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => updateStatus(item.id, 'skipped')}>
                            Skip
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => setSelectedItem(item)}>
                          View
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Message Modal */}
      <Modal
        open={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        title={`DM for ${selectedItem?.leads?.business_name ?? ''}`}
      >
        <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>
          Handle: <span className="font-mono text-white">{selectedItem?.handle}</span>
        </p>
        <div
          className="rounded-lg p-4 text-sm whitespace-pre-wrap mb-4"
          style={{ background: '#0f1117', color: '#e2e8f0', border: '1px solid #2a2d3e' }}
        >
          {selectedItem?.message_text}
        </div>
        <Button
          onClick={() => selectedItem && copyMessage(selectedItem.message_text)}
          className="w-full justify-center"
        >
          {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy Message</>}
        </Button>
      </Modal>
    </div>
  )
}
