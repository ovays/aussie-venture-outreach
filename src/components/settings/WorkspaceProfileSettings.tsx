'use client'

import { useState } from 'react'
import { Building2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import {
  COUNTRY_OPTIONS,
  INDUSTRY_OPTIONS,
  OUTREACH_GOAL_OPTIONS,
  type OnboardingState,
} from '@/lib/onboarding'

interface Props {
  initialState: OnboardingState
  timezones: Array<{ value: string; label: string }>
  canEdit: boolean
}

export function WorkspaceProfileSettings({ initialState, timezones, canEdit }: Props) {
  const [state, setState] = useState(initialState)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true); setError(''); setSaved(false)
    try {
      const response = await fetch('/api/workspace-profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace: {
            workspaceName: state.workspaceName,
            website: state.website,
            industry: state.industry,
            country: state.country,
            timezone: state.timezone,
          },
          profile: {
            senderName: state.senderName,
            brandName: state.brandName,
            companyDescription: state.companyDescription,
            primaryGoal: state.primaryGoal,
          },
        }),
      })
      const body = await response.json()
      if (!response.ok) { setError(body.error ?? 'Unable to save workspace profile'); return }
      setState(body.data); setSaved(true)
    } catch {
      setError('Unable to save right now. Try again shortly.')
    } finally {
      setSaving(false)
    }
  }

  return <form id="workspace-profile" onSubmit={submit} className="scroll-mt-28">
    <div className="mb-5 flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--primary-muted)] text-[var(--primary)]"><Building2 size={19} /></span><div><h2 className="text-base font-semibold text-[var(--text-primary)]">Workspace profile</h2><p className="mt-0.5 text-sm text-[var(--text-muted)]">Business and outreach details captured during onboarding.</p></div></div>
    <fieldset disabled={!canEdit || saving} className="grid gap-4 sm:grid-cols-2 disabled:opacity-70">
      <div className="sm:col-span-2"><Input label="Workspace / business name" required maxLength={120} value={state.workspaceName} onChange={(e) => setState({ ...state, workspaceName: e.target.value })} /></div>
      <div className="sm:col-span-2"><Input label="Website URL (optional)" type="url" maxLength={300} placeholder="https://example.com" value={state.website} onChange={(e) => setState({ ...state, website: e.target.value })} /></div>
      <Select label="Industry" required placeholder="Select an industry" options={[...INDUSTRY_OPTIONS]} value={state.industry} onChange={(e) => setState({ ...state, industry: e.target.value })} />
      <Select label="Country" required options={[...COUNTRY_OPTIONS]} value={state.country} onChange={(e) => setState({ ...state, country: e.target.value })} />
      <div className="sm:col-span-2"><Select label="Timezone" required options={timezones} value={state.timezone} onChange={(e) => setState({ ...state, timezone: e.target.value })} /></div>
      <Input label="Sender / display name" required maxLength={120} value={state.senderName} onChange={(e) => setState({ ...state, senderName: e.target.value })} />
      <Input label="Brand name used in outreach" required maxLength={120} value={state.brandName} onChange={(e) => setState({ ...state, brandName: e.target.value })} />
      <div className="sm:col-span-2"><label htmlFor="settings-company-description" className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">Short company description (optional)</label><textarea id="settings-company-description" className="control-field min-h-24 w-full resize-y px-3 py-2 text-sm" maxLength={500} value={state.companyDescription} onChange={(e) => setState({ ...state, companyDescription: e.target.value })} /></div>
      <div className="sm:col-span-2"><Select label="Primary outreach goal" required placeholder="Select a goal" options={[...OUTREACH_GOAL_OPTIONS]} value={state.primaryGoal} onChange={(e) => setState({ ...state, primaryGoal: e.target.value })} /></div>
    </fieldset>
    <div className="mt-5 flex flex-col items-start gap-3 border-t border-[var(--border-subtle)] pt-4 sm:flex-row sm:items-center sm:justify-between"><div>{error && <p role="alert" className="text-sm text-[var(--error)]">{error}</p>}{saved && <p role="status" className="flex items-center gap-1.5 text-sm text-[var(--success)]"><CheckCircle2 size={15} />Workspace profile saved</p>}{!canEdit && <p className="text-sm text-[var(--text-muted)]">Workspace admin access is required to edit these details.</p>}</div><Button type="submit" disabled={!canEdit || saving} className="w-full sm:w-auto">{saving ? 'Saving…' : 'Save workspace profile'}</Button></div>
  </form>
}
