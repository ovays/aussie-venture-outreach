'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'

interface Category {
  id: string
  name: string
  halal_filter: boolean
  cities: 'sydney_only' | 'all' | 'custom'
  custom_cities: string[] | null
  content_type: 'visit' | 'remote' | 'both'
  pitch_template: string | null
  dm_template: string | null
  search_keywords: string[] | null
  status: 'active' | 'paused'
}

type CategoryDraft = Omit<Category, 'id' | 'status'>

interface CategoryModalProps {
  open: boolean
  onClose: () => void
  category: Category | null
  onSaved: () => void
}

const CITY_OPTIONS = ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide']

export function CategoryModal({ open, onClose, category, onSaved }: CategoryModalProps) {
  const isNew = !category

  const [form, setForm] = useState<CategoryDraft>({
    name: category?.name ?? '',
    halal_filter: category?.halal_filter ?? false,
    cities: category?.cities ?? 'all',
    custom_cities: category?.custom_cities ?? [],
    content_type: category?.content_type ?? 'remote',
    pitch_template: category?.pitch_template ?? '',
    dm_template: category?.dm_template ?? '',
    search_keywords: category?.search_keywords ?? [],
  })
  const [keywordInput, setKeywordInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set<K extends keyof CategoryDraft>(key: K, value: CategoryDraft[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function addKeyword() {
    const kw = keywordInput.trim()
    if (!kw) return
    set('search_keywords', [...(form.search_keywords ?? []), kw])
    setKeywordInput('')
  }

  function removeKeyword(kw: string) {
    set('search_keywords', (form.search_keywords ?? []).filter((k) => k !== kw))
  }

  function toggleCity(city: string) {
    const current = form.custom_cities ?? []
    if (current.includes(city)) {
      set('custom_cities', current.filter((c) => c !== city))
    } else {
      set('custom_cities', [...current, city])
    }
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')

    const payload = { ...form }

    if (isNew) {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) setError('Failed to create category')
    } else {
      const res = await fetch('/api/categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: category!.id, ...payload }),
      })
      if (!res.ok) setError('Failed to update category')
    }

    setSaving(false)
    if (!error) { onSaved(); onClose() }
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'Add Category' : `Edit — ${category?.name}`} wide>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <Input
          label="Category Name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Halal Restaurants"
        />

        <Toggle
          checked={form.halal_filter}
          onChange={(v) => set('halal_filter', v)}
          label="Halal filter (only show halal businesses)"
        />

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#94a3b8' }}>Cities</label>
          <div className="flex gap-2">
            {(['sydney_only', 'all', 'custom'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => set('cities', opt)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: form.cities === opt ? '#0284c7' : '#2a2d3e',
                  color: form.cities === opt ? 'white' : '#94a3b8',
                }}
              >
                {opt === 'sydney_only' ? 'Sydney Only' : opt === 'all' ? 'All Cities' : 'Custom'}
              </button>
            ))}
          </div>
          {form.cities === 'custom' && (
            <div className="flex flex-wrap gap-2 mt-3">
              {CITY_OPTIONS.map((city) => (
                <button
                  key={city}
                  onClick={() => toggleCity(city)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
                  style={{
                    background: (form.custom_cities ?? []).includes(city) ? '#0284c7' : '#2a2d3e',
                    color: (form.custom_cities ?? []).includes(city) ? 'white' : '#94a3b8',
                  }}
                >
                  {city}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#94a3b8' }}>Content Type</label>
          <div className="flex gap-2">
            {(['visit', 'remote', 'both'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => set('content_type', opt)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: form.content_type === opt ? '#0284c7' : '#2a2d3e',
                  color: form.content_type === opt ? 'white' : '#94a3b8',
                }}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#94a3b8' }}>Search Keywords</label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
              placeholder='e.g. "halal restaurant {suburb} {city}"'
              className="flex-1 px-3 py-2 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
            <Button size="sm" onClick={addKeyword}>Add</Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(form.search_keywords ?? []).map((kw) => (
              <span
                key={kw}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs"
                style={{ background: '#1e2130', color: '#94a3b8', border: '1px solid #2a2d3e' }}
              >
                {kw}
                <button
                  onClick={() => removeKeyword(kw)}
                  className="hover:text-red-400 ml-0.5"
                >×</button>
              </span>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>Email Pitch Template</label>
          <textarea
            value={form.pitch_template ?? ''}
            onChange={(e) => set('pitch_template', e.target.value)}
            rows={5}
            placeholder="Base template — Claude personalises this per business"
            className="w-full px-3 py-2 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500 resize-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>DM Template</label>
          <textarea
            value={form.dm_template ?? ''}
            onChange={(e) => set('dm_template', e.target.value)}
            rows={3}
            placeholder="Base DM template"
            className="w-full px-3 py-2 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500 resize-none"
            style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
          />
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 px-4 py-2.5 rounded-lg">{error}</p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : isNew ? 'Add Category' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
