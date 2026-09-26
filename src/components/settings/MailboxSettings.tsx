'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { PublicMailboxConnection } from '@/lib/mailbox/types'

export function MailboxSettings() {
  const [rows, setRows] = useState<PublicMailboxConnection[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/mailboxes')
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to load mailboxes')
      setRows(body.data); setCanManage(body.can_manage)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load mailboxes') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function disconnect(id: string) {
    if (!confirm('Disconnect this mailbox? Sending and reports will no longer use it.')) return
    const response = await fetch(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) { const body = await response.json(); setError(body.error || 'Unable to disconnect mailbox'); return }
    await load()
  }
  async function makeDefault(id: string) {
    const response = await fetch(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ default_sender: true }) })
    if (!response.ok) { const body = await response.json(); setError(body.error || 'Unable to select mailbox'); return }
    await load()
  }

  return <section id="mailboxes" className="scroll-mt-28">
    <div className="mb-5 flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--primary-muted)] text-[var(--primary)]"><Mail size={19} /></span><div><h2 className="text-base font-semibold text-[var(--text-primary)]">Mailboxes</h2><p className="mt-0.5 text-sm text-[var(--text-muted)]">Workspace-scoped sending and operational mailbox reporting.</p></div></div>
    {canManage && <div className="mb-4 flex flex-wrap gap-2"><Button onClick={() => { window.location.href = '/api/mailboxes/oauth/gmail' }}>Connect Gmail</Button><Button variant="secondary" onClick={() => { window.location.href = '/api/mailboxes/oauth/microsoft' }}>Connect Microsoft</Button></div>}
    {error && <p role="alert" className="mb-3 text-sm text-[var(--error)]">{error}</p>}
    {loading ? <p className="text-sm text-[var(--text-muted)]">Loading mailboxes…</p> : rows.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No mailbox is connected.</p> : <div className="space-y-3">{rows.map((row) => <div key={row.id} className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-[var(--text-primary)]">{row.email_address}</span><span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs capitalize text-[var(--text-muted)]">{row.provider}</span><span className="text-xs capitalize text-[var(--text-muted)]">{row.status}</span>{row.is_default_sender && <span className="text-xs text-[var(--success)]">Default sender</span>}</div><p className="mt-1 text-xs text-[var(--text-muted)]">{Object.entries(row.capabilities).filter(([, enabled]) => enabled).map(([name]) => name.replace(/^can/, '')).join(' · ')}{row.last_error_code ? ` · ${row.last_error_code}` : ''}</p></div>{canManage && !row.id.startsWith('env:') && <div className="flex gap-2">{row.capabilities.canSend && row.status === 'connected' && !row.is_default_sender && <Button size="sm" variant="secondary" onClick={() => void makeDefault(row.id)}>Use for sending</Button>}<Button size="sm" variant="secondary" onClick={() => { window.location.href = `/api/mailboxes/oauth/${row.provider}` }}><RefreshCw size={14} />Reconnect</Button><Button size="sm" variant="secondary" onClick={() => void disconnect(row.id)}><Trash2 size={14} />Disconnect</Button></div>}</div>)}</div>}
    {!canManage && <p className="mt-3 text-xs text-[var(--text-muted)]">Workspace admin access is required to connect or change mailboxes.</p>}
  </section>
}

