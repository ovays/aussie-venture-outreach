'use client'

import { useMemo, useState } from 'react'
import { Check, CircleAlert, Loader2, PlugZap, Save, Shield, X } from 'lucide-react'
import type { AISettingsSnapshot, AIWorkflowSetting } from '@/ai/settings-types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'

interface AISettingsProps {
  initialSettings: AISettingsSnapshot
  canEdit: boolean
}

interface WorkflowDraft {
  providerId: string
  modelId: string
}

interface TestResult {
  state: 'testing' | 'connected' | 'error'
  message?: string
}

const WORKFLOW_NAMES: Record<string, string> = {
  website_extraction: 'Website Extraction',
  contact_email_extraction: 'Contact Email Extraction',
  agentic_email_search: 'Agentic Email Search',
  outreach_email_generation: 'Email Generation',
  outreach_dm_generation: 'DM Generation',
  reactivation_email_generation: 'Reactivation',
}

function workflowName(key: string): string {
  return WORKFLOW_NAMES[key] ?? key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function makeDrafts(workflows: AIWorkflowSetting[]): Record<string, WorkflowDraft> {
  return Object.fromEntries(workflows.map((workflow) => [workflow.id, {
    providerId: workflow.providerId,
    modelId: workflow.modelId,
  }]))
}

export function AISettings({ initialSettings, canEdit }: AISettingsProps) {
  const [settings, setSettings] = useState(initialSettings)
  const [selectedProviderId, setSelectedProviderId] = useState(initialSettings.providers[0]?.id ?? '')
  const [drafts, setDrafts] = useState<Record<string, WorkflowDraft>>(() => makeDrafts(initialSettings.workflows))
  const [saving, setSaving] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, TestResult>>({})
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId)
  const modelsById = useMemo(() => new Map(
    settings.providers.flatMap((provider) => provider.models.map((model) => [model.id, model] as const))
  ), [settings.providers])

  async function patchSettings(body: Record<string, unknown>): Promise<AISettingsSnapshot> {
    const response = await fetch('/api/ai-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await response.json() as { data?: AISettingsSnapshot; error?: string }
    if (!response.ok || !json.data) throw new Error(json.error ?? 'Unable to update AI settings')
    return json.data
  }

  function applySnapshot(snapshot: AISettingsSnapshot) {
    setSettings(snapshot)
    setDrafts((current) => Object.fromEntries(snapshot.workflows.map((workflow) => [
      workflow.id,
      current[workflow.id] ?? { providerId: workflow.providerId, modelId: workflow.modelId },
    ])))
  }

  async function toggleProvider(id: string, enabled: boolean) {
    setSaving(`provider:${id}`)
    setNotice(null)
    try {
      applySnapshot(await patchSettings({ resource: 'provider', id, enabled }))
      setNotice({ type: 'success', message: `Provider ${enabled ? 'enabled' : 'disabled'}.` })
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Unable to update provider' })
    } finally {
      setSaving(null)
    }
  }

  async function toggleModel(id: string, enabled: boolean) {
    setSaving(`model:${id}`)
    setNotice(null)
    try {
      applySnapshot(await patchSettings({ resource: 'model', id, enabled }))
      setNotice({ type: 'success', message: `Model ${enabled ? 'enabled' : 'disabled'}.` })
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Unable to update model' })
    } finally {
      setSaving(null)
    }
  }

  async function testConnection(providerId: string) {
    setTests((current) => ({ ...current, [providerId]: { state: 'testing' } }))
    try {
      const response = await fetch('/api/ai-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      })
      const json = await response.json() as { connected?: boolean; error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Connection test failed')
      setTests((current) => ({
        ...current,
        [providerId]: json.connected
          ? { state: 'connected' }
          : { state: 'error', message: json.error ?? 'Connection test failed' },
      }))
    } catch (error) {
      setTests((current) => ({
        ...current,
        [providerId]: { state: 'error', message: error instanceof Error ? error.message : 'Connection test failed' },
      }))
    }
  }

  function selectWorkflowProvider(workflowId: string, providerId: string) {
    const provider = settings.providers.find((item) => item.id === providerId)
    const firstEnabledModel = provider?.models.find((model) => model.enabled)
    setDrafts((current) => ({
      ...current,
      [workflowId]: { providerId, modelId: firstEnabledModel?.id ?? '' },
    }))
  }

  async function saveWorkflow(workflow: AIWorkflowSetting) {
    const draft = drafts[workflow.id]
    if (!draft) return

    setSaving(`workflow:${workflow.id}`)
    setNotice(null)
    try {
      const snapshot = await patchSettings({
        resource: 'workflow',
        id: workflow.id,
        providerId: draft.providerId,
        modelId: draft.modelId,
      })
      setSettings(snapshot)
      const savedWorkflow = snapshot.workflows.find((item) => item.id === workflow.id)
      if (savedWorkflow) {
        setDrafts((current) => ({
          ...current,
          [workflow.id]: { providerId: savedWorkflow.providerId, modelId: savedWorkflow.modelId },
        }))
      }
      setNotice({ type: 'success', message: `${workflowName(workflow.workflowKey)} updated. The configuration cache was invalidated.` })
    } catch (error) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Unable to update workflow' })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">AI providers and workflows</h1>
          <p className="mt-1 text-sm" style={{ color: '#94a3b8' }}>
            Manage the database configuration used by the next AI request. No restart is required.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: '#2a2d3e', color: canEdit ? '#7dd3fc' : '#94a3b8' }}>
          <Shield size={14} />
          {canEdit ? 'Administrator access' : 'Read-only access'}
        </div>
      </div>

      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          aria-live={notice.type === 'error' ? 'assertive' : 'polite'}
          className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
          style={{
            borderColor: notice.type === 'success' ? 'rgba(34,197,94,.35)' : 'rgba(248,113,113,.35)',
            background: notice.type === 'success' ? 'rgba(34,197,94,.08)' : 'rgba(248,113,113,.08)',
            color: notice.type === 'success' ? '#86efac' : '#fca5a5',
          }}
        >
          {notice.type === 'success' ? <Check size={16} className="mt-0.5 shrink-0" /> : <CircleAlert size={16} className="mt-0.5 shrink-0" />}
          <span>{notice.message}</span>
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-white">Providers</h2>
          <p className="mt-0.5 text-xs" style={{ color: '#64748b' }}>Disabled providers remain visible but cannot receive new workflow assignments.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {settings.providers.map((provider) => {
            const result = tests[provider.id]
            const busy = saving === `provider:${provider.id}`
            return (
              <Card key={provider.id} className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-white">{provider.displayName}</h3>
                    <p className="mt-1 text-xs" style={{ color: '#64748b' }}>{provider.models.length} configured model{provider.models.length === 1 ? '' : 's'}</p>
                  </div>
                  <span
                    className="rounded-full px-2.5 py-1 text-xs font-medium"
                    style={{ background: provider.enabled ? 'rgba(34,197,94,.12)' : 'rgba(100,116,139,.15)', color: provider.enabled ? '#86efac' : '#94a3b8' }}
                  >
                    {provider.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: '#2a2d3e' }}>
                  <Toggle
                    checked={provider.enabled}
                    onChange={(enabled) => void toggleProvider(provider.id, enabled)}
                    label={busy ? 'Saving…' : provider.enabled ? 'Enabled' : 'Disabled'}
                    disabled={!canEdit || saving !== null}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void testConnection(provider.id)}
                    disabled={!canEdit || result?.state === 'testing'}
                  >
                    {result?.state === 'testing' ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
                    Test Connection
                  </Button>
                </div>

                {result?.state === 'connected' && (
                  <p className="flex items-center gap-1.5 text-xs text-green-300"><Check size={13} /> Connected</p>
                )}
                {result?.state === 'error' && (
                  <p className="flex items-start gap-1.5 text-xs text-red-300"><X size={13} className="mt-0.5 shrink-0" /> <span className="break-words">{result.message}</span></p>
                )}
              </Card>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-white">Models</h2>
          <p className="mt-0.5 text-xs" style={{ color: '#64748b' }}>Choose a provider to manage its model catalog.</p>
        </div>
        <Card>
          <div className="mb-4 max-w-sm">
            <Select
              label="Provider"
              aria-label="Provider model filter"
              value={selectedProviderId}
              onChange={(event) => setSelectedProviderId(event.target.value)}
              options={settings.providers.map((provider) => ({ value: provider.id, label: provider.displayName }))}
            />
          </div>
          {selectedProvider ? (
            <div className="divide-y" style={{ borderColor: '#2a2d3e' }}>
              {selectedProvider.models.map((model) => {
                const busy = saving === `model:${model.id}`
                return (
                  <div key={model.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div>
                      <p className="text-sm font-medium text-white">{model.displayName}</p>
                      <p className="mt-0.5 font-mono text-xs" style={{ color: '#64748b' }}>{model.modelKey}</p>
                    </div>
                    <Toggle
                      checked={model.enabled}
                      onChange={(enabled) => void toggleModel(model.id, enabled)}
                      label={busy ? 'Saving…' : model.enabled ? 'Enabled' : 'Disabled'}
                      disabled={!canEdit || saving !== null}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm" style={{ color: '#94a3b8' }}>No providers configured.</p>
          )}
        </Card>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-white">Workflow assignments</h2>
          <p className="mt-0.5 text-xs" style={{ color: '#64748b' }}>Model choices are limited to the selected provider. Each save invalidates the live configuration cache.</p>
        </div>
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide" style={{ borderColor: '#2a2d3e', color: '#64748b' }}>
                  <th className="px-5 py-3 font-medium">Workflow</th>
                  <th className="px-3 py-3 font-medium">Provider</th>
                  <th className="px-3 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: '#2a2d3e' }}>
                {settings.workflows.map((workflow) => {
                  const draft = drafts[workflow.id] ?? { providerId: workflow.providerId, modelId: workflow.modelId }
                  const draftProvider = settings.providers.find((provider) => provider.id === draft.providerId)
                  const currentProvider = settings.providers.find((provider) => provider.id === workflow.providerId)
                  const providerOptions = settings.providers.filter((provider) => provider.enabled || provider.id === workflow.providerId)
                  const modelOptions = draftProvider?.models.filter((model) => model.enabled || model.id === workflow.modelId) ?? []
                  const selectedModel = modelsById.get(draft.modelId)
                  const valid = Boolean(draftProvider?.enabled && selectedModel?.enabled && selectedModel.providerId === draft.providerId)
                  const changed = draft.providerId !== workflow.providerId || draft.modelId !== workflow.modelId
                  const busy = saving === `workflow:${workflow.id}`

                  return (
                    <tr key={workflow.id}>
                      <td className="px-5 py-4">
                        <p className="text-sm font-medium text-white">{workflowName(workflow.workflowKey)}</p>
                        {(!currentProvider?.enabled || !modelsById.get(workflow.modelId)?.enabled) && (
                          <p className="mt-1 text-xs text-amber-300">Current assignment is disabled but remains recorded.</p>
                        )}
                      </td>
                      <td className="px-3 py-4">
                        <Select
                          aria-label={`${workflowName(workflow.workflowKey)} provider`}
                          value={draft.providerId}
                          onChange={(event) => selectWorkflowProvider(workflow.id, event.target.value)}
                          options={providerOptions.map((provider) => ({
                            value: provider.id,
                            label: `${provider.displayName}${provider.enabled ? '' : ' (disabled)'}`,
                          }))}
                          disabled={!canEdit || busy}
                        />
                      </td>
                      <td className="px-3 py-4">
                        <Select
                          aria-label={`${workflowName(workflow.workflowKey)} model`}
                          value={draft.modelId}
                          onChange={(event) => setDrafts((current) => ({
                            ...current,
                            [workflow.id]: { ...draft, modelId: event.target.value },
                          }))}
                          options={modelOptions.map((model) => ({
                            value: model.id,
                            label: `${model.displayName}${model.enabled ? '' : ' (disabled)'}`,
                          }))}
                          placeholder={modelOptions.length === 0 ? 'No enabled models' : undefined}
                          disabled={!canEdit || busy || modelOptions.length === 0}
                        />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <Button
                          size="sm"
                          onClick={() => void saveWorkflow(workflow)}
                          disabled={!canEdit || !changed || !valid || saving !== null}
                        >
                          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                          {busy ? 'Saving…' : 'Save'}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  )
}
