'use client'

import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import {
  ALLOWED_PLACEHOLDERS,
  SAMPLE_TEMPLATE_VALUES,
  SYSTEM_PLACEHOLDERS,
  TEMPLATE_STAGE_LABELS,
  USER_PLACEHOLDERS,
  emptyTemplateDrafts,
  getInitialTemplateReadiness,
  renderTemplate,
  validateTemplate,
} from '@/lib/category-email-templates'
import { EMAIL_TEMPLATE_TYPES, type EmailTemplateType, type ManagedCategory, type TemplateValidationError } from '@/lib/email-template-types'

type CategoryDraft = Omit<ManagedCategory, 'id' | 'initialTemplateReadiness' | 'templateValidation' | 'templateCompleteness'>

interface CategoryModalProps {
  open: boolean
  onClose: () => void
  category: ManagedCategory | null
  onSaved: () => void
}

function initialDraft(category: ManagedCategory | null): CategoryDraft {
  return {
    name: category?.name ?? '',
    halal_filter: category?.halal_filter ?? false,
    cities: category?.cities ?? 'all',
    custom_cities: category?.custom_cities ?? [],
    content_type: category?.content_type ?? 'remote',
    city_content_types: category?.city_content_types ?? {},
    pitch_template: category?.pitch_template ?? '',
    dm_template: category?.dm_template ?? '',
    search_keywords: category?.search_keywords ?? [],
    use_priority_suburbs: category?.use_priority_suburbs ?? false,
    status: category?.status ?? 'paused',
    templates: category?.templates ?? emptyTemplateDrafts(),
  }
}

export function CategoryModal({ open, onClose, category, onSaved }: CategoryModalProps) {
  const isNew = !category
  const original = useMemo(() => initialDraft(category), [category])
  const [form, setForm] = useState<CategoryDraft>(original)
  const [stage, setStage] = useState<EmailTemplateType>('initial_pitch')
  const [cityOptions, setCityOptions] = useState<string[]>([])
  const [keywordInput, setKeywordInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [serverReasons, setServerReasons] = useState<string[]>([])
  const dirty = JSON.stringify(form) !== JSON.stringify(original)

  useEffect(() => {
    fetch('/api/cities')
      .then((response) => response.json() as Promise<{ data?: string[] }>)
      .then((json) => setCityOptions(json.data ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function close() {
    if (dirty && !window.confirm('Discard unsaved category and template changes?')) return
    onClose()
  }

  function set<K extends keyof CategoryDraft>(key: K, value: CategoryDraft[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function setTemplate(field: 'subject_template' | 'body_template', value: string) {
    setForm((current) => ({
      ...current,
      templates: { ...current.templates, [stage]: { ...current.templates[stage], [field]: value } },
    }))
  }

  function addKeyword() {
    const keyword = keywordInput.trim()
    if (!keyword) return
    set('search_keywords', [...(form.search_keywords ?? []), keyword])
    setKeywordInput('')
  }

  function toggleCity(city: string) {
    const current = form.custom_cities ?? []
    set('custom_cities', current.includes(city) ? current.filter((item) => item !== city) : [...current, city])
  }

  function setCityContentType(city: string, value: 'visit' | 'remote' | 'default') {
    const next = { ...(form.city_content_types ?? {}) }
    if (value === 'default') delete next[city]
    else next[city] = value
    set('city_content_types', next)
  }

  const selectedTemplate = form.templates[stage]
  const validationErrors = stage === 'initial_pitch'
    ? getInitialTemplateReadiness(selectedTemplate).errors
    : validateTemplate(selectedTemplate)
  const preview = validationErrors.length === 0 ? renderTemplate(selectedTemplate, SAMPLE_TEMPLATE_VALUES) : null
  const errorsFor = (field: 'subject_template' | 'body_template'): TemplateValidationError[] => validationErrors.filter((item) => item.field === field)

  async function handleSave() {
    if (!form.name.trim()) { setError('Category name is required.'); return }
    setSaving(true)
    setError('')
    setServerReasons([])
    const { templates, ...categoryFields } = form
    const response = await fetch('/api/categories', {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(isNew ? {} : { id: category!.id }), ...categoryFields, templates }),
    })
    const json = await response.json() as { error?: string; reasons?: string[] }
    setSaving(false)
    if (!response.ok) {
      setError(json.error ?? `Unable to ${isNew ? 'create' : 'update'} category.`)
      setServerReasons(json.reasons ?? [])
      return
    }
    await onSaved()
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title={isNew ? 'Add Category' : `Edit — ${category?.name}`} wide>
      <div className="space-y-5 max-h-[78vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Category Name" value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="e.g. Escape Rooms" />
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#94a3b8' }}>Category Status</label>
            <div className="flex items-center gap-3 h-10">
              <Toggle checked={form.status === 'active'} onChange={(active) => set('status', active ? 'active' : 'paused')} />
              <span className="text-sm text-white">{form.status === 'active' ? 'Active' : 'Inactive'}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Toggle checked={form.halal_filter} onChange={(value) => set('halal_filter', value)} label="Halal filter (only show halal businesses)" />
          <Toggle checked={form.use_priority_suburbs} onChange={(value) => set('use_priority_suburbs', value)} label="Use Priority Suburbs" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: '#94a3b8' }}>Cities</label>
          <div className="flex gap-2">
            {(['sydney_only', 'all', 'custom'] as const).map((option) => (
              <button type="button" key={option} onClick={() => set('cities', option)} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: form.cities === option ? '#0284c7' : '#2a2d3e', color: form.cities === option ? 'white' : '#94a3b8' }}>
                {option === 'sydney_only' ? 'Sydney Only' : option === 'all' ? 'All Cities' : 'Custom'}
              </button>
            ))}
          </div>
          {form.cities === 'custom' && <div className="flex flex-wrap gap-2 mt-3">{cityOptions.map((city) => <button type="button" key={city} onClick={() => toggleCity(city)} className="px-3 py-1.5 rounded-full text-xs" style={{ background: (form.custom_cities ?? []).includes(city) ? '#0284c7' : '#2a2d3e', color: 'white' }}>{city}</button>)}</div>}
        </div>

        <details>
          <summary className="text-sm font-medium cursor-pointer" style={{ color: '#94a3b8' }}>City content types and search keywords</summary>
          <div className="mt-3 space-y-4">
            {cityOptions.map((city) => {
              const current = form.city_content_types?.[city] ?? 'default'
              return <div key={city} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}><span className="text-sm text-white">{city}</span><div className="flex gap-2">{(['visit', 'remote', 'default'] as const).map((option) => <button type="button" key={option} onClick={() => setCityContentType(city, option)} className="px-2 py-1 rounded text-xs" style={{ background: current === option ? '#0284c7' : '#2a2d3e', color: 'white' }}>{option}</button>)}</div></div>
            })}
            <div className="flex gap-2"><input value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addKeyword() } }} placeholder="Search keyword" className="flex-1 px-3 py-2 rounded-lg text-sm text-white" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} /><Button size="sm" onClick={addKeyword}>Add</Button></div>
            <div className="flex flex-wrap gap-2">{(form.search_keywords ?? []).map((keyword) => <button type="button" key={keyword} onClick={() => set('search_keywords', (form.search_keywords ?? []).filter((item) => item !== keyword))} className="px-2 py-1 rounded-full text-xs" style={{ background: '#1e2130', color: '#94a3b8' }}>{keyword} ×</button>)}</div>
          </div>
        </details>

        <details>
          <summary className="text-sm font-medium cursor-pointer" style={{ color: '#94a3b8' }}>Existing AI pitch and DM templates</summary>
          <div className="mt-3 grid gap-4">
            <textarea value={form.pitch_template ?? ''} onChange={(event) => set('pitch_template', event.target.value)} rows={4} aria-label="Email Pitch Template" placeholder="Existing AI pitch template" className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
            <textarea value={form.dm_template ?? ''} onChange={(event) => set('dm_template', event.target.value)} rows={3} aria-label="DM Template" placeholder="Existing DM template" className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }} />
          </div>
        </details>

        <section className="rounded-xl p-4" style={{ border: '1px solid #2a2d3e', background: '#11131c' }}>
          <div className="flex flex-wrap gap-2 mb-4">
            {EMAIL_TEMPLATE_TYPES.map((type) => (
              <button type="button" key={type} onClick={() => setStage(type)} className="px-3 py-2 rounded-lg text-xs font-medium" style={{ background: stage === type ? '#0284c7' : '#2a2d3e', color: stage === type ? 'white' : '#94a3b8' }}>
                {TEMPLATE_STAGE_LABELS[type]} {form.templates[type].subject_template?.trim() && form.templates[type].body_template?.trim() && validateTemplate(form.templates[type]).length === 0 ? '✓' : '•'}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>Subject</label>
              <input value={selectedTemplate.subject_template ?? ''} onChange={(event) => setTemplate('subject_template', event.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: '#0f1117', border: `1px solid ${errorsFor('subject_template').length ? '#dc2626' : '#2a2d3e'}` }} />
              {errorsFor('subject_template').map((item, index) => <p key={`${item.code}-${index}`} className="text-xs text-red-400 mt-1">{item.message}</p>)}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>Body</label>
              <textarea value={selectedTemplate.body_template ?? ''} onChange={(event) => setTemplate('body_template', event.target.value)} rows={9} className="w-full px-3 py-2 rounded-lg text-sm text-white resize-y" style={{ background: '#0f1117', border: `1px solid ${errorsFor('body_template').length ? '#dc2626' : '#2a2d3e'}` }} />
              {errorsFor('body_template').map((item, index) => <p key={`${item.code}-${index}`} className="text-xs text-red-400 mt-1">{item.message}</p>)}
            </div>

            <div className="text-xs space-y-2" style={{ color: '#94a3b8' }}>
              {(['subject_template', 'body_template'] as const).map((field) => {
                const names = ALLOWED_PLACEHOLDERS[stage][field]
                const publicNames = names.filter((name) => USER_PLACEHOLDERS.includes(name as typeof USER_PLACEHOLDERS[number]))
                const systemNames = names.filter((name) => SYSTEM_PLACEHOLDERS.includes(name as typeof SYSTEM_PLACEHOLDERS[number]))
                return <div key={field}><span className="text-white">{field === 'subject_template' ? 'Subject' : 'Body'}:</span>{publicNames.length > 0 && <span className="ml-2"><span className="text-sky-300">Lead/category</span> {publicNames.map((name) => `{{${name}}}`).join(' ')}</span>}{systemNames.length > 0 && <span className="ml-2"><span className="text-amber-300">System</span> {systemNames.map((name) => `{{${name}}}`).join(' ')}</span>}{names.length === 0 && <span className="ml-2">No placeholders</span>}</div>
              })}
            </div>

            <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #2a2d3e' }}>
              <div className="px-3 py-2 text-xs font-medium" style={{ background: '#1a1d2e', color: '#94a3b8' }}>Deterministic preview — sample data only</div>
              {validationErrors.length > 0 || (preview && !preview.ok) ? (
                <div className="p-3 text-sm text-red-400">Fix the validation errors above before previewing.</div>
              ) : preview?.ok ? (
                <div className="p-3 space-y-3" style={{ background: '#0f1117' }}><div><span className="text-xs" style={{ color: '#64748b' }}>Subject</span><p className="text-sm text-white">{preview.value.subject || '(empty)'}</p></div><div><span className="text-xs" style={{ color: '#64748b' }}>Body</span><pre className="text-sm whitespace-pre-wrap text-white" style={{ fontFamily: 'inherit' }}>{preview.value.body || '(empty)'}</pre></div></div>
              ) : null}
            </div>
          </div>
        </section>

        <p className="text-xs" style={{ color: '#64748b' }}>Template edits do not regenerate existing emails. They apply only when future generation or regeneration is connected to templates in Prompt 3.</p>
        {error && <div className="text-sm text-red-400 bg-red-500/10 px-4 py-3 rounded-lg"><p>{error}</p>{serverReasons.length > 0 && <ul className="list-disc ml-5 mt-1">{serverReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>}
        <div className="flex gap-2 justify-end"><Button variant="ghost" onClick={close}>Cancel</Button><Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add Category' : 'Save Changes'}</Button></div>
      </div>
    </Modal>
  )
}
