'use client'

import { useState } from 'react'
import { X, ExternalLink, Pencil, Check, X as XIcon } from 'lucide-react'
import { StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { formatDate } from '@/lib/utils'

interface Lead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  email: string | null
  phone: string | null
  website: string | null
  instagram_handle: string | null
  google_rating: number | null
  status: string
  deal_value: number | null
  deal_type: string | null
  content_created: boolean
  payment_received: boolean
  notes: string | null
  created_at: string
  halal: boolean
  description: string | null
  services: string | null
}

interface LeadDetailPanelProps {
  lead: Lead | null
  onClose: () => void
  onUpdate: (id: string, updates: Partial<Lead>) => void
}

const STATUS_OPTIONS = ['new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'closed', 'dead']

export function LeadDetailPanel({ lead, onClose, onUpdate }: LeadDetailPanelProps) {
  const [notes, setNotes] = useState(lead?.notes ?? '')
  const [savingNotes, setSavingNotes] = useState(false)

  const [editingEmail, setEditingEmail] = useState(false)
  const [emailInput, setEmailInput] = useState(lead?.email ?? '')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailSaved, setEmailSaved] = useState(false)

  if (!lead) return null

  async function saveEmail() {
    if (!lead) return
    setSavingEmail(true)
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, email: emailInput || null }),
    })
    onUpdate(lead.id, { email: emailInput || null })
    setSavingEmail(false)
    setEditingEmail(false)
    setEmailSaved(true)
    setTimeout(() => setEmailSaved(false), 3000)
  }

  function cancelEmailEdit() {
    setEmailInput(lead?.email ?? '')
    setEditingEmail(false)
  }

  async function saveNotes() {
    if (!lead) return
    setSavingNotes(true)
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, notes }),
    })
    onUpdate(lead.id, { notes })
    setSavingNotes(false)
  }

  async function changeStatus(status: string) {
    if (!lead) return
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, status }),
    })
    onUpdate(lead.id, { status })
  }

  async function toggleField(field: 'content_created' | 'payment_received', value: boolean) {
    if (!lead) return
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, [field]: value }),
    })
    onUpdate(lead.id, { [field]: value })
  }

  return (
    <div
      className="fixed right-0 top-0 h-full w-96 z-40 overflow-y-auto shadow-2xl"
      style={{ background: '#1a1d27', borderLeft: '1px solid #2a2d3e' }}
    >
      <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0" style={{ borderColor: '#2a2d3e', background: '#1a1d27' }}>
        <h3 className="font-semibold text-white truncate">{lead.business_name}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white ml-2 shrink-0">
          <X size={18} />
        </button>
      </div>

      <div className="p-5 space-y-5">
        {/* Status */}
        <div>
          <label className="block text-xs font-medium mb-2" style={{ color: '#64748b' }}>STATUS</label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => changeStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-opacity ${lead.status === s ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}
                style={{ background: lead.status === s ? '#0284c7' : '#2a2d3e', color: 'white' }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Details */}
        <div className="space-y-2">
          {[
            { label: 'Category', value: lead.category_name },
            { label: 'Location', value: [lead.suburb, lead.city].filter(Boolean).join(', ') },
            { label: 'Phone', value: lead.phone },
            { label: 'Rating', value: lead.google_rating ? `${lead.google_rating} ★` : null },
            { label: 'Added', value: formatDate(lead.created_at) },
          ].map(({ label, value }) =>
            value ? (
              <div key={label} className="flex justify-between text-sm">
                <span style={{ color: '#64748b' }}>{label}</span>
                <span className="text-right" style={{ color: '#e2e8f0' }}>{value}</span>
              </div>
            ) : null
          )}

          {/* Email — editable */}
          <div className="text-sm">
            <div className="flex items-center justify-between">
              <span style={{ color: '#64748b' }}>Email</span>
              {!editingEmail && (
                <button
                  onClick={() => { setEmailInput(lead.email ?? ''); setEditingEmail(true) }}
                  className="flex items-center gap-1 transition-colors hover:text-white"
                  style={{ color: '#64748b' }}
                  title="Edit email"
                >
                  <span style={{ color: '#e2e8f0' }}>{lead.email ?? '—'}</span>
                  <Pencil size={11} className="ml-1.5 shrink-0" />
                </button>
              )}
            </div>

            {editingEmail && (
              <div className="mt-2 space-y-2">
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveEmail(); if (e.key === 'Escape') cancelEmailEdit() }}
                  autoFocus
                  className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
                  style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
                  placeholder="email@example.com"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveEmail}
                    disabled={savingEmail}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    style={{ background: '#0284c7', color: 'white' }}
                  >
                    <Check size={11} />
                    {savingEmail ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={cancelEmailEdit}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-colors"
                    style={{ color: '#64748b' }}
                  >
                    <XIcon size={11} />
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {emailSaved && !editingEmail && (
              <p className="text-xs mt-1" style={{ color: '#4ade80' }}>Email updated ✓</p>
            )}
          </div>

          {lead.website && (
            <div className="flex justify-between text-sm">
              <span style={{ color: '#64748b' }}>Website</span>
              <a href={lead.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sky-400 hover:text-sky-300">
                Visit <ExternalLink size={11} />
              </a>
            </div>
          )}

          {lead.instagram_handle && (
            <div className="flex justify-between text-sm">
              <span style={{ color: '#64748b' }}>Instagram</span>
              <span style={{ color: '#e2e8f0' }}>{lead.instagram_handle}</span>
            </div>
          )}
        </div>

        {/* Description */}
        {lead.description && (
          <div>
            <p className="text-xs font-medium mb-1.5" style={{ color: '#64748b' }}>DESCRIPTION</p>
            <p className="text-sm" style={{ color: '#94a3b8' }}>{lead.description}</p>
          </div>
        )}

        {/* Deal info */}
        {lead.status === 'closed' && (
          <div className="rounded-lg p-4 space-y-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
            <p className="text-xs font-medium" style={{ color: '#64748b' }}>DEAL</p>
            <div className="flex justify-between text-sm">
              <span style={{ color: '#94a3b8' }}>Value</span>
              <span className="text-white font-semibold">{lead.deal_value ? `$${lead.deal_value}` : '—'}</span>
            </div>
            <Toggle
              checked={lead.content_created}
              onChange={(v) => toggleField('content_created', v)}
              label="Content created"
            />
            <Toggle
              checked={lead.payment_received}
              onChange={(v) => toggleField('payment_received', v)}
              label="Payment received"
            />
          </div>
        )}

        {/* Notes */}
        <div>
          <p className="text-xs font-medium mb-1.5" style={{ color: '#64748b' }}>NOTES</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Add notes..."
            className="w-full px-3 py-2 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500 resize-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          />
          <Button size="sm" onClick={saveNotes} disabled={savingNotes} className="mt-2">
            {savingNotes ? 'Saving...' : 'Save Notes'}
          </Button>
        </div>

        {/* Status badge */}
        <div className="pt-2">
          <StatusBadge status={lead.status} />
        </div>
      </div>
    </div>
  )
}
