'use client'

import { useState } from 'react'
import { KanbanCard } from './KanbanCard'
import { LeadDetailPanel } from '@/components/leads/LeadDetailPanel'

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
  halal_confidence_score?: number | null
  halal_reasons?: string[] | null
}

const COLUMNS = [
  { key: 'new', label: 'New', color: '#60a5fa' },
  { key: 'contacted', label: 'Contacted', color: '#fb923c' },
  { key: 'replied', label: 'Replied 🔥', color: '#4ade80' },
  { key: 'negotiating', label: 'Negotiating', color: '#2dd4bf' },
  { key: 'closed', label: 'Closed ✅', color: '#34d399' },
  { key: 'dead', label: 'Dead ❌', color: '#6b7280' },
]

interface KanbanBoardProps {
  leads: Lead[]
}

export function KanbanBoard({ leads: initialLeads }: KanbanBoardProps) {
  const [leads, setLeads] = useState(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)

  function updateLead(id: string, updates: Partial<Lead>) {
    setLeads((prev) => prev.map((l) => l.id === id ? { ...l, ...updates } : l))
    if (selectedLead?.id === id) setSelectedLead((prev) => prev ? { ...prev, ...updates } : prev)
  }

  async function moveCard(leadId: string, newStatus: string) {
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: leadId, status: newStatus }),
    })
    updateLead(leadId, { status: newStatus })
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 p-3 md:p-6 min-h-0 flex-1 snap-x snap-mandatory">
      {COLUMNS.map(({ key, label, color }) => {
        const columnLeads = leads.filter((l) => l.status === key)

        return (
          <div
            key={key}
            className="flex flex-col rounded-xl shrink-0 w-[82vw] md:w-64 snap-center"
            style={{ background: '#1e2130', border: '1px solid #2a2d3e' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const leadId = e.dataTransfer.getData('text/plain')
              if (leadId) moveCard(leadId, key)
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 border-b rounded-t-xl"
              style={{ borderColor: '#2a2d3e', borderTop: `3px solid ${color}` }}
            >
              <h3 className="text-sm font-semibold" style={{ color }}>{label}</h3>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{ background: `${color}20`, color }}
              >
                {columnLeads.length}
              </span>
            </div>

            <div className="flex-1 p-3 space-y-2 overflow-y-auto">
              {columnLeads.map((lead) => (
                <div
                  key={lead.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', lead.id)}
                >
                  <KanbanCard lead={lead} onClick={() => setSelectedLead(lead)} />
                </div>
              ))}
              {columnLeads.length === 0 && (
                <p className="text-xs text-center py-4" style={{ color: '#475569' }}>No leads</p>
              )}
            </div>
          </div>
        )
      })}

      {selectedLead && (
        <LeadDetailPanel
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onUpdate={updateLead}
        />
      )}
    </div>
  )
}
