'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface SuburbRow {
  id: string
  suburb: string
  active: boolean
  priority: number
}

interface CategoryOption {
  id: string
  name: string
  status: string
}

interface CitySuburbsProps {
  initialData: Record<string, SuburbRow[]>
  initialCategories: CategoryOption[]
}

interface SuburbResponse {
  data?: Record<string, SuburbRow[]>
  prioritySet?: { customized: boolean }
  error?: string
}

const GLOBAL_SCOPE = 'global'

export function CitySuburbs({ initialData, initialCategories }: CitySuburbsProps) {
  const [, setGlobalData] = useState<Record<string, SuburbRow[]>>(initialData)
  const [data, setData] = useState<Record<string, SuburbRow[]>>(initialData)
  const [categories, setCategories] = useState(() => initialCategories.filter((category) => category.status === 'active'))
  const [activeScope, setActiveScope] = useState(GLOBAL_SCOPE)
  const [customized, setCustomized] = useState(false)
  const [loadingScope, setLoadingScope] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [savingPriorityId, setSavingPriorityId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const loadSequence = useRef(0)
  const activeScopeRef = useRef(GLOBAL_SCOPE)
  const globalDataRef = useRef(initialData)

  const cities = Object.keys(data).sort()
  const [activeCity, setActiveCity] = useState(cities[0] ?? '')
  const [newSuburb, setNewSuburb] = useState('')
  const [adding, setAdding] = useState(false)

  async function refreshCategories() {
    try {
      const response = await fetch('/api/categories')
      const json = await response.json() as { data?: CategoryOption[] }
      if (!response.ok) return
      const activeCategories = (json.data ?? []).filter((category) => category.status === 'active')
      setCategories(activeCategories)
      if (activeScopeRef.current !== GLOBAL_SCOPE && !activeCategories.some((category) => category.id === activeScopeRef.current)) {
        activeScopeRef.current = GLOBAL_SCOPE
        loadSequence.current += 1
        setActiveScope(GLOBAL_SCOPE)
        setLoadingScope(false)
        setCustomized(false)
        setData(globalDataRef.current)
      }
    } catch {
      // Initial server data remains usable if a background category refresh fails.
    }
  }

  useEffect(() => {
    void refreshCategories()
    window.addEventListener('category-readiness-changed', refreshCategories)
    return () => window.removeEventListener('category-readiness-changed', refreshCategories)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadCategory(categoryId: string) {
    const sequence = ++loadSequence.current
    setLoadingScope(true)
    setError('')
    try {
      const response = await fetch(`/api/city-suburbs?categoryId=${encodeURIComponent(categoryId)}`)
      const json = await response.json() as SuburbResponse
      if (!response.ok || !json.data || !json.prioritySet) {
        throw new Error(json.error ?? 'Unable to load category priorities.')
      }
      if (sequence !== loadSequence.current) return
      setData(json.data)
      setCustomized(json.prioritySet.customized)
    } catch (requestError) {
      if (sequence !== loadSequence.current) return
      setError(requestError instanceof Error ? requestError.message : 'Unable to load category priorities.')
    } finally {
      if (sequence === loadSequence.current) setLoadingScope(false)
    }
  }

  function selectScope(scope: string) {
    activeScopeRef.current = scope
    setActiveScope(scope)
    setNewSuburb('')
    setError('')
    if (scope === GLOBAL_SCOPE) {
      loadSequence.current += 1
      setLoadingScope(false)
      setCustomized(false)
      setData(globalDataRef.current)
      return
    }
    void loadCategory(scope)
  }

  async function toggleSuburb(id: string, active: boolean) {
    setError('')
    const response = await fetch('/api/city-suburbs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active }),
    })
    const json = await response.json() as { error?: string }
    if (!response.ok) {
      setError(json.error ?? 'Unable to update suburb.')
      return
    }
    const updateActive = (previous: Record<string, SuburbRow[]>) => ({
      ...previous,
      [activeCity]: (previous[activeCity] ?? []).map((suburb) => suburb.id === id ? { ...suburb, active } : suburb),
    })
    setGlobalData((previous) => {
      const next = updateActive(previous)
      globalDataRef.current = next
      return next
    })
    setData(updateActive)
  }

  async function updatePriority(id: string, priority: number) {
    const clamped = Math.min(10, Math.max(1, Math.round(priority)))
    const categoryId = activeScope === GLOBAL_SCOPE ? null : activeScope
    setSavingPriorityId(id)
    setError('')
    try {
      const response = await fetch('/api/city-suburbs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, priority: clamped, ...(categoryId ? { categoryId } : {}) }),
      })
      const json = await response.json() as { error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Unable to update priority.')

      if (categoryId) {
        setData((previous) => Object.fromEntries(Object.entries(previous).map(([city, rows]) => [
          city,
          rows.map((row) => ({
            ...row,
            priority: row.id === id ? clamped : customized ? row.priority : 1,
          })),
        ])))
        setCustomized(true)
      } else {
        const updateGlobalPriority = (previous: Record<string, SuburbRow[]>) => ({
          ...previous,
          [activeCity]: (previous[activeCity] ?? []).map((row) => row.id === id ? { ...row, priority: clamped } : row),
        })
        setGlobalData((previous) => {
          const next = updateGlobalPriority(previous)
          globalDataRef.current = next
          return next
        })
        setData(updateGlobalPriority)
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to update priority.')
      if (categoryId) await loadCategory(categoryId)
      else setData(globalDataRef.current)
    } finally {
      setSavingPriorityId(null)
    }
  }

  async function resetCategoryPriorities() {
    if (activeScope === GLOBAL_SCOPE) return
    setResetting(true)
    setError('')
    try {
      const response = await fetch('/api/city-suburbs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: activeScope }),
      })
      const json = await response.json() as { error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Unable to reset category priorities.')
      await loadCategory(activeScope)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reset category priorities.')
    } finally {
      setResetting(false)
    }
  }

  async function removeSuburb(id: string) {
    setError('')
    const response = await fetch('/api/city-suburbs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const json = await response.json() as { error?: string }
    if (!response.ok) {
      setError(json.error ?? 'Unable to remove suburb.')
      return
    }
    const remove = (previous: Record<string, SuburbRow[]>) => ({
      ...previous,
      [activeCity]: (previous[activeCity] ?? []).filter((suburb) => suburb.id !== id),
    })
    setGlobalData((previous) => {
      const next = remove(previous)
      globalDataRef.current = next
      return next
    })
    setData(remove)
    if (activeScope !== GLOBAL_SCOPE) await loadCategory(activeScope)
  }

  async function addSuburb() {
    const trimmed = newSuburb.trim()
    if (!trimmed) return
    setAdding(true)
    setError('')
    try {
      const response = await fetch('/api/city-suburbs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: activeCity, suburb: trimmed }),
      })
      const json = await response.json() as { data?: { id: string; suburb: string; active: boolean; priority?: number | null }; error?: string }
      if (!response.ok || !json.data) throw new Error(json.error ?? 'Unable to add suburb.')
      const globalRow = { id: json.data.id, suburb: json.data.suburb, active: true, priority: json.data.priority ?? 1 }
      setGlobalData((previous) => {
        const next = {
          ...previous,
          [activeCity]: [...(previous[activeCity] ?? []), globalRow],
        }
        globalDataRef.current = next
        return next
      })
      setData((previous) => ({
        ...previous,
        [activeCity]: [...(previous[activeCity] ?? []), {
          ...globalRow,
          priority: activeScope !== GLOBAL_SCOPE && customized ? 1 : globalRow.priority,
        }],
      }))
      setNewSuburb('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to add suburb.')
    } finally {
      setAdding(false)
    }
  }

  const suburbs = data[activeCity] ?? []
  const activeCount = suburbs.filter((suburb) => suburb.active).length
  const selectedCategory = categories.find((category) => category.id === activeScope)

  return (
    <section>
      <h3 className="text-base font-semibold text-white mb-1">Cities & Suburbs</h3>
      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Only active suburbs are used by the finder agent when searching for leads. Toggle to pause a suburb without deleting it.
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <label className="text-xs font-medium" style={{ color: '#94a3b8' }}>
          <span className="block mb-1.5">Priority Set</span>
          <select
            value={activeScope}
            onChange={(event) => selectScope(event.target.value)}
            className="min-w-56 px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          >
            <option value={GLOBAL_SCOPE}>Global / Default</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        {activeScope !== GLOBAL_SCOPE && customized && (
          <Button variant="ghost" size="sm" onClick={resetCategoryPriorities} disabled={resetting || loadingScope}>
            <RotateCcw size={13} />
            {resetting ? 'Resetting…' : 'Reset to Global / Default'}
          </Button>
        )}
      </div>

      {activeScope !== GLOBAL_SCOPE && (
        <div
          className="rounded-md px-3 py-2 mb-4 text-xs"
          style={{
            color: customized ? '#7dd3fc' : '#94a3b8',
            background: customized ? 'rgba(2,132,199,0.10)' : '#0f1117',
            border: '1px solid #2a2d3e',
          }}
        >
          {loadingScope
            ? `Loading ${selectedCategory?.name ?? 'category'} priorities…`
            : customized
              ? `${selectedCategory?.name ?? 'This category'} has customised priorities. Unmapped suburbs use priority 1.`
              : 'Using Global / Default priorities'}
        </div>
      )}

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <div className="flex flex-wrap gap-2 mb-4">
        {cities.map((city) => {
          const citySuburbs = data[city] ?? []
          const count = citySuburbs.filter((suburb) => suburb.active).length
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

      <div className="rounded-lg p-4 mb-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
        <p className="text-xs font-medium mb-3" style={{ color: '#64748b' }}>
          {activeCity} — {activeCount} of {suburbs.length} active
        </p>

        {suburbs.length === 0 ? (
          <p className="text-sm" style={{ color: '#475569' }}>No suburbs yet. Add one below.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {suburbs.map((suburb) => (
              <div
                key={suburb.id}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors"
                style={{ background: suburb.active ? '#1e2130' : 'transparent' }}
              >
                <input
                  type="checkbox"
                  checked={suburb.active}
                  onChange={(event) => void toggleSuburb(suburb.id, event.target.checked)}
                  disabled={loadingScope}
                  className="shrink-0 cursor-pointer accent-sky-500"
                  style={{ width: 14, height: 14 }}
                />
                <span className="flex-1 text-sm" style={{ color: suburb.active ? '#e2e8f0' : '#475569' }}>
                  {suburb.suburb}
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={suburb.priority}
                  disabled={loadingScope || savingPriorityId !== null}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    if (!Number.isNaN(value)) {
                      setData((previous) => ({
                        ...previous,
                        [activeCity]: (previous[activeCity] ?? []).map((row) => row.id === suburb.id ? { ...row, priority: value } : row),
                      }))
                    }
                  }}
                  onBlur={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    if (!Number.isNaN(value)) void updatePriority(suburb.id, value)
                  }}
                  className="shrink-0 text-center text-xs rounded outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-60"
                  style={{
                    width: 36,
                    background: '#0f1117',
                    border: '1px solid #2a2d3e',
                    color: '#94a3b8',
                    padding: '2px 4px',
                  }}
                  title={activeScope === GLOBAL_SCOPE ? 'Global priority (1–10)' : 'Category priority (1–10)'}
                />
                <button
                  onClick={() => void removeSuburb(suburb.id)}
                  disabled={loadingScope}
                  className="shrink-0 transition-colors hover:text-red-400 disabled:opacity-50"
                  style={{ color: '#374151' }}
                  aria-label={`Remove ${suburb.suburb}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={newSuburb}
          onChange={(event) => setNewSuburb(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void addSuburb() }}
          placeholder={`Add ${activeCity} suburb…`}
          disabled={loadingScope}
          className="flex-1 px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-60"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        />
        <button
          onClick={() => void addSuburb()}
          disabled={!newSuburb.trim() || adding || loadingScope}
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
