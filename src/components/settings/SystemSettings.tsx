'use client'

import { useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'

interface Setting {
  key: string
  value: string
  description: string | null
}

interface SystemSettingsProps {
  initialSettings: Setting[]
}

const CITIES = ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide']

export function SystemSettings({ initialSettings }: SystemSettingsProps) {
  const [settings, setSettings] = useState<Record<string, string>>(
    Object.fromEntries(initialSettings.map((s) => [s.key, s.value]))
  )
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Danger Zone state
  const [showResetModal, setShowResetModal] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

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
          <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
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
                className="w-24 px-3 py-1.5 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_lead_limit" />
            </div>
          </div>

          {/* Email limit */}
          <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
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
                className="w-24 px-3 py-1.5 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_email_limit" />
            </div>
          </div>

          {/* DM limit */}
          <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
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
                className="w-24 px-3 py-1.5 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
              />
              <SaveIndicator k="daily_dm_limit" />
            </div>
          </div>

          {/* Digest email */}
          <div className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
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
                className="px-3 py-1.5 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500"
                style={{ background: '#0f1117', border: '1px solid #2a2d3e', width: '220px' }}
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
                  className="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
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
            <div key={key} className="flex items-center justify-between py-3 border-b" style={{ borderColor: '#2a2d3e' }}>
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
                    className="w-20 px-3 py-1.5 rounded-lg text-sm text-white text-right outline-none focus:ring-2 focus:ring-sky-500"
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

        <div className="grid grid-cols-2 gap-3 mb-4">
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

      {/* Danger Zone */}
      <section>
        <h3 className="text-base font-semibold mb-1" style={{ color: '#f87171' }}>Danger Zone</h3>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Irreversible actions. Use with caution.
        </p>

        <div className="rounded-lg p-4" style={{ border: '1px solid #7f1d1d', background: '#1a0a0a' }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Reset All Data</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>
                Delete all leads, emails, DMs, deals, and activity logs
              </p>
            </div>
            <button
              onClick={() => { setShowResetModal(true); setResetDone(false); setResetError(null) }}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #991b1b' }}
            >
              Reset All Data
            </button>
          </div>

          {resetDone && (
            <p className="mt-3 text-sm" style={{ color: '#4ade80' }}>All data cleared successfully.</p>
          )}
          {resetError && (
            <p className="mt-3 text-sm text-red-400">{resetError}</p>
          )}
        </div>
      </section>

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
