'use client'

import { useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { OutscraperUsageData } from '@/app/dashboard/settings/page'

interface Setting {
  key: string
  value: string
  description: string | null
}

interface SystemSettingsProps {
  initialSettings: Setting[]
  usageData: OutscraperUsageData
  hasGoogleMapsKey: boolean
  searchCacheCount: number
}

const CITIES = ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide']

export function SystemSettings({ initialSettings, usageData, hasGoogleMapsKey, searchCacheCount }: SystemSettingsProps) {
  const [settings, setSettings] = useState<Record<string, string>>(
    Object.fromEntries(initialSettings.map((s) => [s.key, s.value]))
  )
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Danger Zone — reset state
  const [showResetModal, setShowResetModal] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Danger Zone — delete by date state
  const todayStr = new Date().toISOString().slice(0, 10)
  const [deleteDate, setDeleteDate] = useState(todayStr)
  const [deleteCount, setDeleteCount] = useState<number | null>(null)
  const [checkingDelete, setCheckingDelete] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteResult, setDeleteResult] = useState<{ text: string; ok: boolean } | null>(null)

  // Pipeline state
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineTriggered, setPipelineTriggered] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)

  // Test email state
  const [testCategory, setTestCategory] = useState('Halal Restaurants')
  const [testCity, setTestCity] = useState('Sydney')
  const [testBusinessName, setTestBusinessName] = useState('Test Business')
  const [testSuburb, setTestSuburb] = useState('CBD')
  const [testGenerating, setTestGenerating] = useState(false)
  const [testPreview, setTestPreview] = useState<{ subject: string; body: string; content_type: string } | null>(null)
  const [testSending, setTestSending] = useState(false)
  const [testSent, setTestSent] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  async function updateSetting(key: string, value: string) {
    setSaving(key)
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSaving(null)
    setSaved(key)
    setTimeout(() => setSaved(null), 2000)
  }

  function getNum(key: string): number {
    return parseInt(settings[key] ?? '0', 10)
  }

  const activeCities = (settings['active_cities'] ?? '').split(',').map((c) => c.trim()).filter(Boolean)

  function toggleCity(city: string) {
    const current = activeCities
    const next = current.includes(city) ? current.filter((c) => c !== city) : [...current, city]
    updateSetting('active_cities', next.join(', '))
  }

  async function runPipeline() {
    setPipelineRunning(true)
    setPipelineTriggered(false)
    setPipelineError(null)
    try {
      const res = await fetch('/api/pipeline/run', { method: 'POST' })
      let data: Record<string, unknown> = {}
      try {
        data = await res.json()
      } catch {
        // Response wasn't JSON (e.g. framework-level HTML error page)
      }
      if (!res.ok) {
        const msg = typeof data.error === 'string' ? data.error : `Pipeline failed (HTTP ${res.status})`
        throw new Error(msg)
      }
      setPipelineTriggered(true)
    } catch (err) {
      setPipelineError(err instanceof Error ? err.message : String(err))
    } finally {
      setPipelineRunning(false)
    }
  }

  async function generateTestEmail() {
    setTestGenerating(true)
    setTestPreview(null)
    setTestError(null)
    setTestSent(false)
    try {
      const res = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          business_name: testBusinessName,
          category: testCategory,
          city: testCity,
          suburb: testSuburb,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generation failed')
      setTestPreview(data)
    } catch (err) {
      setTestError(String(err))
    } finally {
      setTestGenerating(false)
    }
  }

  async function sendTestEmail() {
    if (!testPreview) return
    setTestSending(true)
    setTestError(null)
    try {
      const res = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          subject: testPreview.subject,
          body: testPreview.body,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Send failed')
      setTestSent(true)
    } catch (err) {
      setTestError(String(err))
    } finally {
      setTestSending(false)
    }
  }

  async function checkDeleteCount() {
    if (!deleteDate) return
    setCheckingDelete(true)
    setDeleteResult(null)
    setDeleteCount(null)
    const res = await fetch(`/api/leads/delete-by-date?date=${deleteDate}`)
    const json = await res.json() as { count?: number; error?: string }
    setCheckingDelete(false)
    if (json.error) { setDeleteResult({ text: json.error, ok: false }); return }
    setDeleteCount(json.count ?? 0)
    setShowDeleteModal(true)
  }

  async function confirmDelete() {
    setDeleting(true)
    const res = await fetch('/api/leads/delete-by-date', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: deleteDate }),
    })
    const json = await res.json() as { deleted?: number; error?: string }
    setDeleting(false)
    setShowDeleteModal(false)
    if (json.error) {
      setDeleteResult({ text: `Error: ${json.error}`, ok: false })
    } else {
      setDeleteResult({ text: `Deleted ${json.deleted ?? 0} leads from ${deleteDate}`, ok: true })
      setDeleteCount(null)
    }
  }

  async function resetAllData() {
    setResetting(true)
    setResetError(null)
    try {
      const res = await fetch('/api/reset', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Reset failed')
      setResetDone(true)
      setShowResetModal(false)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetting(false)
    }
  }

  function SaveIndicator({ k }: { k: string }) {
    if (saving === k) return <span className="text-xs text-sky-400 ml-2">Saving…</span>
    if (saved === k) return <span className="text-xs text-green-400 ml-2">Saved ✓</span>
    return null
  }

  return (
    <div className="space-y-8">
      {/* System toggle */}
      <section>
        <h3 className="text-base font-semibold text-white mb-4">System Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">System Active</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Master on/off switch — pauses all agents</p>
            </div>
            <div className="flex items-center gap-2">
              <Toggle
                checked={settings['system_active'] === 'true'}
                onChange={(v) => updateSetting('system_active', v ? 'true' : 'false')}
              />
              <SaveIndicator k="system_active" />
            </div>
          </div>

          {/* Lead limit */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Daily Lead Limit</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Max new leads to find per day</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={getNum('daily_lead_limit')}
                onChange={(e) => setSettings((p) => ({ ...p, daily_lead_limit: e.target.value }))}
                onBlur={(e) => updateSetting('daily_lead_limit', e.target.value)}
                min={1}
                max={500}
                className="w-full sm:w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_lead_limit" />
            </div>
          </div>

          {/* Email limit */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Daily Email Limit</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Max emails to send per day</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={getNum('daily_email_limit')}
                onChange={(e) => setSettings((p) => ({ ...p, daily_email_limit: e.target.value }))}
                onBlur={(e) => updateSetting('daily_email_limit', e.target.value)}
                min={1}
                max={500}
                className="w-full sm:w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_email_limit" />
            </div>
          </div>

          {/* Email orchestration limits */}
          {[
            {
              key: 'daily_followup1_limit',
              label: 'Daily Follow-up 1 Limit',
              description: 'Max first follow-up emails to send per day',
              max: 500,
            },
            {
              key: 'daily_followup2_limit',
              label: 'Daily Follow-up 2 Limit',
              description: 'Max second follow-up emails to send per day',
              max: 500,
            },
            {
              key: 'daily_followup3_limit',
              label: 'Daily Follow-up 3 Limit',
              description: 'Max final follow-up emails to send per day',
              max: 500,
            },
          ].map(({ key, label, description, max }) => (
            <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
              <div>
                <p className="text-sm text-white">{label}</p>
                <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>{description}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={getNum(key)}
                  onChange={(e) => setSettings((p) => ({ ...p, [key]: e.target.value }))}
                  onBlur={(e) => updateSetting(key, e.target.value)}
                  min={0}
                  max={max}
                  className="w-full sm:w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                  style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
                />
                <SaveIndicator k={key} />
              </div>
            </div>
          ))}

          {/* DM limit */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Daily DM Limit</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Max DMs to queue per day (Instagram + Facebook)</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={getNum('daily_dm_limit')}
                onChange={(e) => setSettings((p) => ({ ...p, daily_dm_limit: e.target.value }))}
                onBlur={(e) => updateSetting('daily_dm_limit', e.target.value)}
                min={1}
                max={200}
                className="w-full sm:w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_dm_limit" />
            </div>
          </div>

          {/* Daily Outscraper Limit */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Daily Outscraper Limit ($)</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Maximum Outscraper spend per day in USD. Pipeline stops when reached. Normal daily cost is ~$0.50. Set to $2.00 for safety margin.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm" style={{ color: '#64748b' }}>$</span>
                <input
                  type="number"
                  value={settings['daily_outscraper_limit'] ?? '2.00'}
                  onChange={(e) => setSettings((p) => ({ ...p, daily_outscraper_limit: e.target.value }))}
                  onBlur={(e) => updateSetting('daily_outscraper_limit', e.target.value)}
                  min={0.10}
                  max={50}
                  step={0.10}
                  className="w-full sm:w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                  style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
                />
              </div>
              <SaveIndicator k="daily_outscraper_limit" />
            </div>
          </div>

          {/* Digest email */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Digest Email</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Where to send the daily summary</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={settings['digest_email'] ?? ''}
                onChange={(e) => setSettings((p) => ({ ...p, digest_email: e.target.value }))}
                onBlur={(e) => updateSetting('digest_email', e.target.value)}
                className="w-full sm:w-56 px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="digest_email" />
            </div>
          </div>

          {/* Active cities */}
          <div className="py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm text-white">Active Cities</p>
                <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Which cities to target for non-Sydney categories</p>
              </div>
              <SaveIndicator k="active_cities" />
            </div>
            <div className="flex flex-wrap gap-2">
              {CITIES.map((city) => (
                <button
                  key={city}
                  onClick={() => toggleCity(city)}
                  className="px-3 py-2 rounded-full text-sm font-medium transition-colors min-h-[36px]"
                  style={{
                    background: activeCities.includes(city) ? '#0284c7' : '#1e2130',
                    color: activeCities.includes(city) ? 'white' : '#94a3b8',
                    border: '1px solid #2a2d3e',
                  }}
                >
                  {city}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Follow-up settings */}
      <section>
        <h3 className="text-base font-semibold text-white mb-4">Follow-up Settings</h3>
        <div className="space-y-4">
          {[
            { key: 'follow_up_1_days', label: 'Follow-up 1 delay', description: 'Days before sending first follow-up' },
            { key: 'follow_up_2_days', label: 'Follow-up 2 delay', description: 'Days before sending second follow-up' },
            { key: 'dead_lead_days', label: 'Mark dead after', description: 'Days of no reply before marking lead as dead' },
          ].map(({ key, label, description }) => (
            <div key={key} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
              <div>
                <p className="text-sm text-white">{label}</p>
                <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>{description}</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={getNum(key)}
                    onChange={(e) => setSettings((p) => ({ ...p, [key]: e.target.value }))}
                    onBlur={(e) => updateSetting(key, e.target.value)}
                    min={1}
                    max={90}
                    className="w-full sm:w-20 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                    style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
                  />
                  <span className="text-sm" style={{ color: '#64748b' }}>days</span>
                </div>
                <SaveIndicator k={key} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Search API */}
      <section>
        <h3 className="text-base font-semibold text-white mb-4">Search API</h3>
        <div className="space-y-4">
          {/* Primary API selector */}
          <div className="py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
            <p className="text-sm text-white mb-1">Primary API</p>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>Which API to use for finding businesses. Google Maps is more accurate and cheaper; falls back to Outscraper automatically.</p>
            <div className="flex gap-4">
              {['google_maps', 'outscraper'].map((api) => (
                <label key={api} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="primary_search_api"
                    value={api}
                    checked={settings['primary_search_api'] === api}
                    onChange={() => updateSetting('primary_search_api', api)}
                    className="accent-sky-500"
                  />
                  <span className="text-sm text-white">{api === 'google_maps' ? 'Google Maps' : 'Outscraper'}</span>
                </label>
              ))}
              <SaveIndicator k="primary_search_api" />
            </div>
          </div>

          {/* Google Maps spend */}
          <div className="py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
            <p className="text-sm text-white mb-1">Google Maps this month</p>
            {(() => {
              const spend = parseFloat(settings['google_maps_spend_this_month'] ?? '0')
              const limit = parseFloat(settings['google_maps_monthly_limit'] ?? '180')
              const pct = Math.min(100, limit > 0 ? (spend / limit) * 100 : 0)
              return (
                <div className="space-y-2">
                  <p className="text-xs" style={{ color: '#94a3b8' }}>${spend.toFixed(4)} / ${limit.toFixed(2)} limit</p>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: '#1e2130' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${pct}%`,
                        background: pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#0284c7',
                      }}
                    />
                  </div>
                  <p className="text-xs" style={{ color: '#64748b' }}>{pct.toFixed(1)}% of monthly budget used</p>
                </div>
              )
            })()}
          </div>

          {/* Cost per request */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Cost per Google request ($)</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Configurable — update if Google changes pricing</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm" style={{ color: '#64748b' }}>$</span>
              <input
                type="number"
                value={settings['google_maps_cost_per_request'] ?? '0.032'}
                onChange={(e) => setSettings((p) => ({ ...p, google_maps_cost_per_request: e.target.value }))}
                onBlur={(e) => updateSetting('google_maps_cost_per_request', e.target.value)}
                step={0.001}
                min={0}
                className="w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="google_maps_cost_per_request" />
            </div>
          </div>

          {/* Monthly limit */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-2" style={{ borderColor: '#2a2d3e' }}>
            <div>
              <p className="text-sm text-white">Google Maps monthly limit ($)</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Switch to Outscraper when spend exceeds this</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm" style={{ color: '#64748b' }}>$</span>
              <input
                type="number"
                value={settings['google_maps_monthly_limit'] ?? '180'}
                onChange={(e) => setSettings((p) => ({ ...p, google_maps_monthly_limit: e.target.value }))}
                onBlur={(e) => updateSetting('google_maps_monthly_limit', e.target.value)}
                min={0}
                step={10}
                className="w-24 px-3 py-2 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="google_maps_monthly_limit" />
            </div>
          </div>

          {/* Current status */}
          <div className="py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
            <p className="text-sm text-white mb-2">Current status</p>
            {(() => {
              const primary = settings['primary_search_api'] ?? 'outscraper'
              const spend = parseFloat(settings['google_maps_spend_this_month'] ?? '0')
              const limit = parseFloat(settings['google_maps_monthly_limit'] ?? '180')
              const overBudget = spend >= limit

              if (primary === 'outscraper') {
                return <p className="text-sm" style={{ color: '#94a3b8' }}>🔵 Outscraper active (manually selected)</p>
              }
              if (!hasGoogleMapsKey) {
                return <p className="text-sm" style={{ color: '#f87171' }}>🔴 Google Maps key not configured — using Outscraper</p>
              }
              if (overBudget) {
                return <p className="text-sm" style={{ color: '#fbbf24' }}>🟡 Outscraper fallback (Google Maps budget reached)</p>
              }
              return <p className="text-sm" style={{ color: '#4ade80' }}>🟢 Google Maps active</p>
            })()}
          </div>

          {/* Cache info */}
          <div className="py-3">
            <p className="text-sm text-white mb-1">Search cache</p>
            <p className="text-xs" style={{ color: '#94a3b8' }}>
              {searchCacheCount} active {searchCacheCount === 1 ? 'entry' : 'entries'} — repeated searches reuse cached results for 7 days, saving API calls.
            </p>
          </div>
        </div>
      </section>

      {/* Run Pipeline */}
      <section>
        <h3 className="text-base font-semibold text-white mb-1">Run Pipeline Manually</h3>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Runs Finder → Researcher → Writer → Sender in sequence. System must be active for leads to be processed.
        </p>

        <div className="flex items-center gap-4 flex-wrap">
          <Button onClick={runPipeline} disabled={pipelineRunning}>
            {pipelineRunning ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Running…
              </>
            ) : 'Run Pipeline Now'}
          </Button>

          {pipelineTriggered && (
            <span className="text-sm text-green-400">
              Pipeline triggered! Check your Leads and Email Log pages in 15-20 minutes.
            </span>
          )}

          {pipelineError && (
            <span className="text-sm text-red-400">{pipelineError}</span>
          )}
        </div>
      </section>

      {/* Test Email */}
      <section>
        <h3 className="text-base font-semibold text-white mb-1">Test Email</h3>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Generate and preview a real outreach email for any business type and city, then send it to hello@aussieventure.com.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs mb-1.5" style={{ color: '#94a3b8' }}>Business Type</label>
            <select
              value={testCategory}
              onChange={(e) => { setTestCategory(e.target.value); setTestPreview(null); setTestSent(false) }}
              className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            >
              <option value="Halal Restaurants">Halal Restaurant</option>
              <option value="Halal Cafes">Halal Cafe</option>
              <option value="Nail Salons">Nail Salon</option>
              <option value="Hair Salons">Hair Salon</option>
              <option value="Beauty / Lash Studios">Beauty / Lash Studio</option>
              <option value="Spas / Massage Studios">Spa / Massage Studio</option>
              <option value="Travel Agents">Travel Agent</option>
              <option value="Tour Operators">Tour Operator</option>
              <option value="Hotels / Resorts">Hotel / Resort</option>
            </select>
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: '#94a3b8' }}>City</label>
            <select
              value={testCity}
              onChange={(e) => { setTestCity(e.target.value); setTestPreview(null); setTestSent(false) }}
              className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            >
              {['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: '#94a3b8' }}>Business Name</label>
            <input
              type="text"
              value={testBusinessName}
              onChange={(e) => { setTestBusinessName(e.target.value); setTestPreview(null); setTestSent(false) }}
              placeholder="Test Business"
              className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>

          <div>
            <label className="block text-xs mb-1.5" style={{ color: '#94a3b8' }}>Suburb</label>
            <input
              type="text"
              value={testSuburb}
              onChange={(e) => { setTestSuburb(e.target.value); setTestPreview(null); setTestSent(false) }}
              placeholder="CBD"
              className="w-full px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>
        </div>

        <Button onClick={generateTestEmail} disabled={testGenerating || !testBusinessName.trim()}>
          {testGenerating ? 'Generating…' : 'Generate & Preview'}
        </Button>

        {testPreview && (
          <div className="mt-4 rounded-lg overflow-hidden" style={{ border: '1px solid #2a2d3e' }}>
            {/* Subject row */}
            <div className="flex items-start gap-3 px-4 py-3 border-b" style={{ borderColor: '#2a2d3e', background: '#0f1117' }}>
              <span className="text-xs mt-0.5 shrink-0" style={{ color: '#64748b' }}>Subject</span>
              <span className="text-sm text-white font-medium">{testPreview.subject}</span>
            </div>

            {/* Visit / remote badge */}
            <div className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: '#2a2d3e', background: '#1a1d2e' }}>
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={testPreview.content_type === 'visit'
                  ? { background: '#0284c720', color: '#38bdf8' }
                  : { background: '#7c3aed20', color: '#a78bfa' }
                }
              >
                {testPreview.content_type === 'visit' ? 'Visit — Sydney in-person' : 'Remote — assets from business'}
              </span>
            </div>

            {/* Body */}
            <div className="p-4" style={{ background: '#0f1117' }}>
              <p className="text-xs mb-2" style={{ color: '#64748b' }}>Body</p>
              <pre
                className="text-sm whitespace-pre-wrap"
                style={{ color: '#e2e8f0', fontFamily: 'inherit', lineHeight: '1.75', margin: 0 }}
              >
                {testPreview.body}
              </pre>
            </div>

            {/* Action bar */}
            <div className="flex items-center gap-3 px-4 py-3 border-t" style={{ borderColor: '#2a2d3e', background: '#1a1d2e' }}>
              {testSent ? (
                <span className="text-sm text-green-400">Email sent to hello@aussieventure.com ✓</span>
              ) : (
                <>
                  <Button
                    onClick={sendTestEmail}
                    disabled={testSending}
                    className="bg-emerald-600 hover:bg-emerald-500"
                  >
                    {testSending ? 'Sending…' : 'Confirm Send'}
                  </Button>
                  <button
                    onClick={() => { setTestPreview(null); setTestSent(false); setTestError(null) }}
                    className="text-sm transition-colors hover:text-white"
                    style={{ color: '#64748b' }}
                  >
                    Reset
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {testError && (
          <p className="mt-3 text-sm text-red-400">{testError}</p>
        )}
      </section>

      {/* API Keys status */}
      <section>
        <h3 className="text-base font-semibold text-white mb-4">API Keys Status</h3>
        <div className="space-y-3">
          {[
            { label: 'Supabase', key: 'NEXT_PUBLIC_SUPABASE_URL' },
            { label: 'Claude (Anthropic)', key: 'ANTHROPIC_API_KEY' },
            { label: 'Resend', key: 'RESEND_API_KEY' },
            { label: 'Outscraper', key: 'OUTSCRAPER_API_KEY' },
            { label: 'Trigger.dev', key: 'TRIGGER_SECRET_KEY' },
          ].map(({ label }) => (
            <div key={label} className="flex items-center justify-between py-2.5 px-4 rounded-lg" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
              <span className="text-sm" style={{ color: '#94a3b8' }}>{label}</span>
              <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: '#2a2d3e', color: '#64748b' }}>
                Configure in .env.local
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs mt-3" style={{ color: '#475569' }}>
          API keys are stored in .env.local and are never exposed in the UI.
        </p>
      </section>

      {/* API Usage & Costs */}
      <section>
        <h3 className="text-base font-semibold text-white mb-1">API Usage & Costs</h3>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Outscraper usage from pipeline runs. Each search costs ~$0.002.
        </p>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Today',           calls: usageData.todayCalls,  cost: usageData.todayCost  },
            { label: 'This week',        calls: usageData.weekCalls,   cost: usageData.weekCost   },
            { label: 'This month',       calls: usageData.monthCalls,  cost: usageData.monthCost  },
            { label: 'Avg per run',      calls: usageData.avgCallsPerRun, cost: usageData.avgCallsPerRun * 0.002 },
          ].map(({ label, calls, cost }) => (
            <div key={label} className="rounded-lg p-3" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
              <p className="text-xs mb-1" style={{ color: '#64748b' }}>{label}</p>
              <p className="text-base font-semibold text-white">{calls} calls</p>
              <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>${cost.toFixed(3)}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg p-3 mb-4 flex items-center justify-between" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
          <span className="text-sm" style={{ color: '#94a3b8' }}>Estimated monthly cost (at current pace)</span>
          <span className="text-sm font-semibold text-white">${usageData.estimatedMonthlyCost.toFixed(2)}</span>
        </div>

        {/* Last 7 days table */}
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #2a2d3e' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#0f1117', borderBottom: '1px solid #2a2d3e' }}>
                {['Date', 'Runs', 'Outscraper Calls', 'Cost'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider" style={{ color: '#64748b' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usageData.last7Days.map((row) => (
                <tr key={row.date} style={{ borderBottom: '1px solid #1e2130' }}>
                  <td className="px-4 py-2.5 text-white">{row.label}</td>
                  <td className="px-4 py-2.5" style={{ color: row.runs > 0 ? '#94a3b8' : '#475569' }}>{row.runs}</td>
                  <td className="px-4 py-2.5" style={{ color: row.calls > 0 ? '#38bdf8' : '#475569' }}>{row.calls}</td>
                  <td className="px-4 py-2.5" style={{ color: row.cost > 0 ? '#94a3b8' : '#475569' }}>
                    {row.cost > 0 ? `$${row.cost.toFixed(3)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Danger Zone */}
      <section>
        <h3 className="text-base font-semibold mb-1" style={{ color: '#f87171' }}>⚠️ Danger Zone</h3>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Irreversible actions. Use with caution.
        </p>

        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #7f1d1d', background: '#1a0a0a' }}>
          {/* Delete by date */}
          <div className="p-4 border-b" style={{ borderColor: '#7f1d1d' }}>
            <p className="text-sm text-white mb-0.5">Delete Leads by Date</p>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>
              Permanently delete all leads added on a specific date, along with related emails, DMs, follow-ups, and activity log entries.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                value={deleteDate}
                max={todayStr}
                onChange={(e) => { setDeleteDate(e.target.value); setDeleteResult(null); setDeleteCount(null) }}
                className="px-3 py-1.5 rounded-lg text-sm text-white outline-none"
                style={{ background: '#0f1117', border: '1px solid #7f1d1d', colorScheme: 'dark' }}
              />
              <button
                onClick={checkDeleteCount}
                disabled={!deleteDate || checkingDelete}
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #991b1b' }}
              >
                {checkingDelete ? 'Checking…' : 'Delete Leads on This Date'}
              </button>
              {deleteResult && (
                <span className="text-xs" style={{ color: deleteResult.ok ? '#4ade80' : '#f87171' }}>
                  {deleteResult.text}
                </span>
              )}
            </div>
          </div>

          {/* Reset all */}
          <div className="p-4">
            <p className="text-sm text-white mb-0.5">Reset All Data</p>
            <p className="text-xs mb-3" style={{ color: '#64748b' }}>
              Delete all leads, emails, DMs, deals, and activity logs.
            </p>
            <button
              onClick={() => { setShowResetModal(true); setResetDone(false); setResetError(null) }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #991b1b' }}
            >
              Reset Everything
            </button>
            {resetDone && (
              <p className="mt-2 text-sm" style={{ color: '#4ade80' }}>All data cleared successfully.</p>
            )}
            {resetError && (
              <p className="mt-2 text-sm text-red-400">{resetError}</p>
            )}
          </div>
        </div>
      </section>

      {/* Delete by date confirmation modal */}
      <Modal
        open={showDeleteModal}
        onClose={() => !deleting && setShowDeleteModal(false)}
        title="Confirm Deletion"
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            This will permanently delete{' '}
            <span className="font-semibold text-white">{deleteCount} lead{deleteCount !== 1 ? 's' : ''}</span>{' '}
            added on <span className="font-semibold text-white">{deleteDate}</span>, along with all
            related emails, DMs, follow-ups, and activity log entries.
          </p>
          {deleteCount === 0 && (
            <p className="text-sm" style={{ color: '#fbbf24' }}>No leads found for this date.</p>
          )}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setShowDeleteModal(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={confirmDelete} disabled={deleting || deleteCount === 0}>
              {deleting ? 'Deleting…' : `Delete ${deleteCount} lead${deleteCount !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reset confirmation modal */}
      {showResetModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => !resetting && setShowResetModal(false)}
        >
          <div
            className="rounded-xl p-6 max-w-sm w-full mx-4"
            style={{ background: '#1a1d2e', border: '1px solid #2a2d3e' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white mb-2">Are you sure?</h3>
            <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
              This will permanently delete all leads, emails, DMs, deals, and activity logs.
              This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={resetAllData}
                disabled={resetting}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: '#dc2626', color: 'white' }}
              >
                {resetting ? 'Deleting…' : 'Yes, delete everything'}
              </button>
              <button
                onClick={() => setShowResetModal(false)}
                disabled={resetting}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: '#2a2d3e', color: '#94a3b8' }}
              >
                Cancel
              </button>
            </div>
            {resetError && (
              <p className="mt-3 text-sm text-red-400">{resetError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
