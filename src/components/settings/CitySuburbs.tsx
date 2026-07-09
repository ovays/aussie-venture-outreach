'use client'

import { useState } from 'react'
import { X, Plus } from 'lucide-react'

interface SuburbRow {
  id: string
  suburb: string
  active: boolean
  priority: number
}

interface CitySuburbsProps {
  initialData: Record<string, SuburbRow[]>
}

export function CitySuburbs({ initialData }: CitySuburbsProps) {
  const [data, setData] = useState<Record<string, SuburbRow[]>>(initialData)
  const cities = Object.keys(data).sort()
  const [activeCity, setActiveCity] = useState(cities[0] ?? '')
  const [newSuburb, setNewSuburb] = useState('')
  const [adding, setAdding] = useState(false)

  async function toggleSuburb(id: string, active: boolean) {
    await fetch('/api/city-suburbs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active }),
    })
    setData((prev) => ({
      ...prev,
      [activeCity]: (prev[activeCity] ?? []).map((s) => s.id === id ? { ...s, active } : s),
    }))
  }

  async function updatePriority(id: string, priority: number) {
    const clamped = Math.min(10, Math.max(1, Math.round(priority)))
    setData((prev) => ({
      ...prev,
      [activeCity]: (prev[activeCity] ?? []).map((s) => s.id === id ? { ...s, priority: clamped } : s),
    }))
    await fetch('/api/city-suburbs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, priority: clamped }),
    })
  }

  async function removeSuburb(id: string) {
    await fetch('/api/city-suburbs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setData((prev) => ({
      ...prev,
      [activeCity]: (prev[activeCity] ?? []).filter((s) => s.id !== id),
    }))
  }

  async function addSuburb() {
    const trimmed = newSuburb.trim()
    if (!trimmed) return
    setAdding(true)
    const res = await fetch('/api/city-suburbs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: activeCity, suburb: trimmed }),
    })
    const json = await res.json() as { data?: { id: string; suburb: string; active: boolean; priority?: number | null } }
    if (json.data) {
      setData((prev) => ({
        ...prev,
        [activeCity]: [...(prev[activeCity] ?? []), { id: json.data!.id, suburb: json.data!.suburb, active: true, priority: json.data!.priority ?? 1 }],
      }))
      setNewSuburb('')
    }
    setAdding(false)
  }

  const suburbs = data[activeCity] ?? []
  const activeCount = suburbs.filter((s) => s.active).length

  return (
    <section>
      <h3 className="text-base font-semibold text-white mb-1">Cities & Suburbs</h3>
      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Only active suburbs are used by the finder agent when searching for leads. Toggle to pause a suburb without deleting it.
      </p>

      {/* City tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {cities.map((city) => {
          const citySuburbs = data[city] ?? []
          const count = citySuburbs.filter((s) => s.active).length
          const total = citySuburbs.length
          const isActive = activeCity === city
          return (
            <button
              key={city}
              onClick={() => { setActiveCity(city); setNewSuburb('') }}
              className="px-3 py-2 rounded-full text-sm font-medium transition-colors min-h-[36px]"
              style={{
                background: isActive ? '#0284c7' : '#1e2130',
                color: isActive ? 'white' : '#94a3b8',
                border: '1px solid #2a2d3e',
              }}
            >
              {city}
              <span className="ml-1.5 text-xs" style={{ color: isActive ? 'rgba(255,255,255,0.65)' : '#475569' }}>
                {count}/{total}
              </span>
            </button>
          )
        })}
      </div>

      {/* Suburbs list */}
      <div className="rounded-lg p-4 mb-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
        <p className="text-xs font-medium mb-3" style={{ color: '#64748b' }}>
          {activeCity} — {activeCount} of {suburbs.length} active
        </p>

        {suburbs.length === 0 ? (
          <p className="text-sm" style={{ color: '#475569' }}>No suburbs yet. Add one below.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {suburbs.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors"
                style={{ background: s.active ? '#1e2130' : 'transparent' }}
              >
                <input
                  type="checkbox"
                  checked={s.active}
                  onChange={(e) => toggleSuburb(s.id, e.target.checked)}
                  className="shrink-0 cursor-pointer accent-sky-500"
                  style={{ width: 14, height: 14 }}
                />
                <span
                  className="flex-1 text-sm"
                  style={{ color: s.active ? '#e2e8f0' : '#475569' }}
                >
                  {s.suburb}
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={s.priority}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val)) {
                      setData((prev) => ({
                        ...prev,
                        [activeCity]: (prev[activeCity] ?? []).map((r) => r.id === s.id ? { ...r, priority: val } : r),
                      }))
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val)) updatePriority(s.id, val)
                  }}
                  className="shrink-0 text-center text-xs rounded outline-none focus:ring-1 focus:ring-sky-500"
                  style={{
                    width: 36,
                    background: '#0f1117',
                    border: '1px solid #2a2d3e',
                    color: '#94a3b8',
                    padding: '2px 4px',
                  }}
                  title="Priority (1–10)"
                />
                <button
                  onClick={() => removeSuburb(s.id)}
                  className="shrink-0 transition-colors hover:text-red-400"
                  style={{ color: '#374151' }}
                  aria-label={`Remove ${s.suburb}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add suburb */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newSuburb}
          onChange={(e) => setNewSuburb(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addSuburb() }}
          placeholder={`Add ${activeCity} suburb…`}
          className="flex-1 px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        />
        <button
          onClick={addSuburb}
          disabled={!newSuburb.trim() || adding}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          style={{ background: '#0284c7', color: 'white' }}
        >
          <Plus size={14} />
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
    </section>
  )
}
