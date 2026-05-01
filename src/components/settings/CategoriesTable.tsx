'use client'

import { useState } from 'react'
import { Plus, Edit2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { CategoryModal } from './CategoryModal'

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

interface CategoriesTableProps {
  initialCategories: Category[]
}

export function CategoriesTable({ initialCategories }: CategoriesTableProps) {
  const [categories, setCategories] = useState(initialCategories)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)

  async function toggleStatus(id: string, current: 'active' | 'paused') {
    const newStatus = current === 'active' ? 'paused' : 'active'
    await fetch('/api/categories', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: newStatus }),
    })
    setCategories((prev) => prev.map((c) => c.id === id ? { ...c, status: newStatus } : c))
  }

  async function refreshCategories() {
    const res = await fetch('/api/categories')
    const json = await res.json() as { data: Category[] }
    setCategories(json.data ?? [])
  }

  function openNew() {
    setEditingCategory(null)
    setModalOpen(true)
  }

  function openEdit(cat: Category) {
    setEditingCategory(cat)
    setModalOpen(true)
  }

  const CITIES_LABEL: Record<string, string> = {
    sydney_only: 'Sydney Only',
    all: 'All Cities',
    custom: 'Custom',
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-white">Categories</h3>
          <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Manage which business types to target</p>
        </div>
        <Button onClick={openNew}>
          <Plus size={14} />
          Add Category
        </Button>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #2a2d3e' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e', background: '#0f1117' }}>
              {['Name', 'Cities', 'Content Type', 'Keywords', 'Status', 'Actions'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat.id} className="border-b" style={{ borderColor: '#2a2d3e' }}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{cat.name}</span>
                    {cat.halal_filter && (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#16a34a20', color: '#4ade80' }}>Halal</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: '#94a3b8' }}>{CITIES_LABEL[cat.cities]}</td>
                <td className="px-4 py-3 text-xs capitalize" style={{ color: '#94a3b8' }}>{cat.content_type}</td>
                <td className="px-4 py-3 text-xs" style={{ color: '#94a3b8' }}>
                  {(cat.search_keywords ?? []).length} keyword{(cat.search_keywords ?? []).length !== 1 ? 's' : ''}
                </td>
                <td className="px-4 py-3">
                  <Toggle
                    checked={cat.status === 'active'}
                    onChange={() => toggleStatus(cat.id, cat.status)}
                  />
                </td>
                <td className="px-4 py-3">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(cat)}>
                    <Edit2 size={12} />
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CategoryModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        category={editingCategory}
        onSaved={refreshCategories}
      />
    </div>
  )
}
