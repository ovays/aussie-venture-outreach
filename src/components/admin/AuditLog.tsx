'use client'

import { useState } from 'react'
import type { AuditEventRow } from '@/lib/audit/types'
import { Button } from '@/components/ui/Button'

interface Page { events: AuditEventRow[]; hasMore: boolean; nextCursor: string | null }

export function AuditLog({ initial }: { initial: Page }) {
  const [events, setEvents] = useState(initial.events)
  const [cursor, setCursor] = useState(initial.nextCursor)
  const [hasMore, setHasMore] = useState(initial.hasMore)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadMore() {
    if (!cursor) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/admin/audit?limit=50&cursor=${encodeURIComponent(cursor)}`, { cache: 'no-store' })
      const body = await response.json() as { data?: Page; error?: string }
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Unable to load audit events')
      setEvents((current) => [...current, ...body.data!.events]); setCursor(body.data.nextCursor); setHasMore(body.data.hasMore)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load audit events') }
    finally { setBusy(false) }
  }

  return <div>
    <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
      <thead className="border-b border-[var(--border)] text-xs uppercase text-[var(--text-muted)]"><tr><th className="px-3 py-3">Time</th><th className="px-3 py-3">Action</th><th className="px-3 py-3">Workspace</th><th className="px-3 py-3">Actor</th><th className="px-3 py-3">Target</th><th className="px-3 py-3">Metadata</th></tr></thead>
      <tbody className="divide-y divide-[var(--border-subtle)]">{events.map((event) => <tr key={event.id}>
        <td className="whitespace-nowrap px-3 py-3 text-xs">{new Date(event.created_at).toLocaleString()}</td><td className="px-3 py-3 font-medium">{event.action}</td><td className="px-3 py-3 text-xs">{event.workspace_id ?? 'Platform'}</td><td className="px-3 py-3 text-xs">{event.actor_role ?? event.actor_type}<br />{event.actor_user_id ?? '—'}</td><td className="px-3 py-3 text-xs">{event.target_type}<br />{event.target_id ?? '—'}</td><td className="max-w-xs truncate px-3 py-3 font-mono text-xs" title={JSON.stringify(event.metadata)}>{JSON.stringify(event.metadata)}</td>
      </tr>)}</tbody>
    </table></div>
    {events.length === 0 && <p className="py-10 text-center text-sm text-[var(--text-muted)]">No audit events recorded.</p>}
    <div className="mt-4 flex items-center gap-3">{hasMore && <Button variant="secondary" disabled={busy} onClick={() => void loadMore()}>{busy ? 'Loading…' : 'Load more'}</Button>}{error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}</div>
  </div>
}
