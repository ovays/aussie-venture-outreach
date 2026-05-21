'use client'

import { useState } from 'react'
import { X } from 'lucide-react'

interface LeadFilteringProps {
  initialEnabled: boolean
  initialKeywords: string[]
}

export function LeadFiltering({ initialEnabled, initialKeywords }: LeadFilteringProps) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [keywords, setKeywords] = useState<string[]>(initialKeywords)
  const [keywordInput, setKeywordInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function addKeyword() {
    const val = keywordInput.trim().toLowerCase()
    if (!val || keywords.includes(val)) {
      setKeywordInput('')
      return
    }
    setKeywords((prev) => [...prev, val])
    setKeywordInput('')
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    await Promise.all([
      fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'enable_lead_filtering', value: String(enabled) }),
      }),
      fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'blocked_business_keywords', value: JSON.stringify(keywords) }),
      }),
    ])
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <section>
      <h3 className="text-base font-semibold text-white mb-1">Lead Filtering</h3>
      <p className="text-xs mb-4" style={{ color: '#64748b' }}>
        Skip businesses before any website scraping if their name contains a blocked keyword.
        Applies globally to all categories.
      </p>

      {/* Enable toggle */}
      <div className="flex items-center gap-3 mb-5">
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className="relative shrink-0 rounded-full transition-colors"
          style={{ width: 36, height: 20, background: enabled ? '#0284c7' : '#2a2d3e' }}
          aria-label="Toggle lead filtering"
        >
          <span
            className="absolute top-0.5 left-0.5 rounded-full transition-transform"
            style={{
              width: 16,
              height: 16,
              background: 'white',
              transform: enabled ? 'translateX(16px)' : 'translateX(0)',
            }}
          />
        </button>
        <span className="text-sm" style={{ color: enabled ? '#e2e8f0' : '#64748b' }}>
          Enable Lead Filtering
        </span>
      </div>

      {/* Blocked Business Name Keywords */}
      <div className="mb-5">
        <p className="text-xs font-medium mb-2" style={{ color: '#94a3b8' }}>Blocked Business Name Keywords</p>
        <div
          className="rounded-lg p-3 mb-2"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e', minHeight: 48 }}
        >
          <div className="flex flex-wrap gap-1.5">
            {keywords.length === 0 ? (
              <span className="text-xs" style={{ color: '#374151' }}>No keywords added yet</span>
            ) : (
              keywords.map((kw) => (
                <span
                  key={kw}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium"
                  style={{ background: '#1e2130', color: '#94a3b8', border: '1px solid #2a2d3e' }}
                >
                  {kw}
                  <button
                    type="button"
                    onClick={() => setKeywords((prev) => prev.filter((k) => k !== kw))}
                    className="hover:text-red-400 transition-colors"
                    aria-label={`Remove ${kw}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
        <input
          type="text"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addKeyword()
            }
          }}
          placeholder="Type keyword and press Enter…"
          className="w-full px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
          style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        />
        <p className="text-xs mt-1.5" style={{ color: '#374151' }}>
          e.g. bar, wine, pub, brewery — stored lowercase, matched by inclusion in business name
        </p>
      </div>

      {/* Save button */}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        style={{ background: saved ? '#16a34a' : '#0284c7', color: 'white' }}
      >
        {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
      </button>
    </section>
  )
}
