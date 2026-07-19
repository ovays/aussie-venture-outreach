'use client'

import { useState, useEffect } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { STAGE_OPTIONS, type LeadImportStage } from '@/lib/stage-import'

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

interface Category {
  id: string
  name: string
  status: string
}

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

export function AddLeadModal({ open, onClose, onCreated }: Props) {
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [suburb, setSuburb] = useState('')
  const [city, setCity] = useState('')
  const [cities, setCities] = useState<string[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [currentStage, setCurrentStage] = useState<LeadImportStage>('new')
  const [stageCompletedDate, setStageCompletedDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [domainWarning, setDomainWarning] = useState<{ domain: string; existing: { id: string; business_name: string } } | null>(null)

  useEffect(() => {
    if (!open) return
    Promise.all([
      fetch('/api/categories').then((r) => r.json() as Promise<{ data?: Category[] }>),
      fetch('/api/cities').then((r) => r.json() as Promise<{ data?: string[] }>),
    ]).then(([catJson, cityJson]) => {
      const all = catJson.data ?? []
      setCategories(all)
      if (all.length > 0) setCategoryId(all[0].id)
      const cityList = cityJson.data ?? []
      setCities(cityList)
      if (cityList.length > 0) setCity((prev) => prev || cityList[0])
    }).catch(() => {})
  }, [open])

  function reset() {
    setBusinessName('')
    setEmail('')
    setWebsite('')
    setSuburb('')
    setCity(cities[0] ?? '')
    setCategoryId('')
    setCurrentStage('new')
    setStageCompletedDate('')
    setError(null)
    setDraftError(null)
    setDomainWarning(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function submitLead(force = false) {
    setError(null)
    setDraftError(null)
    setDomainWarning(null)
    const selectedCategory = categories.find((c) => c.id === categoryId)
    if (!selectedCategory) {
      setError('Please select a category')
      return
    }

    // Phase 1: create the lead
    setLoading(true)
    let leadId: string | null = null
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_name: businessName,
          email,
          website: website || undefined,
          suburb,
          city,
          category_id: selectedCategory.id,
          category_name: selectedCategory.name,
          current_stage: currentStage,
          ...(currentStage !== 'new' && { stage_completed_date: stageCompletedDate }),
          ...(force && { force: true }),
        }),
      })
      const json = await res.json() as {
        data?: { id: string }
        error?: string
        type?: string
        domain?: string
        existing?: { id: string; business_name: string }
      }
      if (!res.ok) {
        if (res.status === 409 && json.type === 'domain_duplicate' && json.domain && json.existing) {
          setDomainWarning({ domain: json.domain, existing: json.existing })
        } else {
          setError(json.error ?? 'Failed to create lead')
        }
        return
      }
      leadId = json.data?.id ?? null
      onCreated()
    } finally {
      setLoading(false)
    }

    if (!leadId) return

    // Staged leads (current_stage !== 'new') already have their full email
    // history backfilled server-side and are past the draft stage — skip
    // Phase 2 entirely and finish here.
    if (currentStage !== 'new') {
      reset()
      onClose()
      return
    }

    // Phase 2: generate draft immediately
    setDrafting(true)
    try {
      const draftRes = await fetch(`/api/leads/${leadId}/generate-draft`, { method: 'POST' })
      if (!draftRes.ok) {
        const draftJson = await draftRes.json() as { error?: string }
        setDraftError(draftJson.error ?? 'Draft generation failed. The scheduled writer will create a draft later.')
        return
      }
      onCreated() // refresh again — lead is now email_ready
      reset()
      onClose()
    } catch {
      setDraftError('Draft generation failed. The scheduled writer will create a draft later.')
    } finally {
      setDrafting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await submitLead(false)
  }

  const categoryOptions = categories.map((c) => ({ value: c.id, label: c.name }))
  const isValid = Boolean(
    businessName.trim() &&
    email.trim() &&
    suburb.trim() &&
    categoryId &&
    (currentStage === 'new' || stageCompletedDate.trim())
  )

  return (
    <Modal open={open} onClose={handleClose} title="Add Lead">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Business Name *"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="e.g. Bondi Bites Café"
          required
          autoFocus
        />
        <Input
          label="Email *"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="contact@example.com"
          required
        />
        <Input
          label="Website"
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://example.com"
        />
        <Input
          label="Suburb *"
          value={suburb}
          onChange={(e) => setSuburb(e.target.value)}
          placeholder="e.g. Bondi"
          required
        />
        <Select
          label="City *"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          options={cities.map((c) => ({ value: c, label: c }))}
          required
        />
        <Select
          label="Category *"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          options={categoryOptions}
          placeholder={categories.length === 0 ? 'Loading categories…' : undefined}
          required
        />
        <Select
          label="Current Stage *"
          value={currentStage}
          onChange={(e) => {
            const next = e.target.value as LeadImportStage
            setCurrentStage(next)
            if (next === 'new') setStageCompletedDate('')
          }}
          options={STAGE_OPTIONS}
          required
        />
        {currentStage !== 'new' && (
          <Input
            label="Stage Completed Date *"
            type="date"
            value={stageCompletedDate}
            onChange={(e) => setStageCompletedDate(e.target.value)}
            max={todayIsoDate()}
            required
          />
        )}

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {domainWarning && (
          <div className="rounded-lg p-3 text-sm" style={{ background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
            <p className="text-yellow-400 mb-2.5">
              A lead already exists for <span className="font-semibold">{domainWarning.domain}</span>{' '}
              ({domainWarning.existing.business_name}). Add this lead anyway?
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setDomainWarning(null)} disabled={loading || drafting}>
                Cancel
              </Button>
              <Button type="button" onClick={() => submitLead(true)} disabled={loading || drafting}>
                {loading ? 'Adding…' : 'Add Anyway'}
              </Button>
            </div>
          </div>
        )}

        {draftError && (
          <p className="text-sm text-yellow-400">Lead created. {draftError}</p>
        )}

        {!domainWarning && (
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={loading || drafting}>
              Cancel
            </Button>
            {draftError ? (
              <Button type="button" onClick={handleClose}>
                Close
              </Button>
            ) : (
              <Button type="submit" disabled={loading || drafting || !isValid}>
                {loading ? 'Adding…' : drafting ? 'Generating draft…' : 'Add Lead'}
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  )
}
