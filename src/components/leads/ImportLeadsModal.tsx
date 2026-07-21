'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { Download, Upload, FileText, X as XIcon } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { parseCsv, isBlankRow, downloadCsv } from '@/lib/csv'
import { STAGE_OPTIONS, STAGE_VALUES, STAGE_LABELS, type LeadImportStage } from '@/lib/stage-import'

interface Category {
  id: string
  name: string
  status: string
}

interface Props {
  open: boolean
  onClose: () => void
  onImported: () => void
}

interface ReadyRow {
  rowNum: number
  business_name: string
  email: string
  website?: string
  suburb?: string
  city: string
  category_name: string
  current_stage: LeadImportStage
  stage_completed_date?: string
}

interface RowIssue {
  rowNum: number
  business_name: string
  email: string
  reason: string
}

interface ImportSummary {
  totalRowsProcessed: number
  imported: number
  duplicates: number
  invalidEmails: number
  failed: RowIssue[]
}

function buildTemplateRows(): string[][] {
  return [
    ['Business Name', 'Email', 'Website', 'Suburb', 'City', 'Category', 'Current Stage', 'Stage Completed Date'],
    ['Elude Games', 'info@eludegames.com.au', 'https://eludegames.com.au', '', 'Sydney', 'Escape Rooms', STAGE_LABELS.initial_sent, todayIsoDate()],
  ]
}

const HEADER_ALIASES: Record<string, string> = {
  'business name': 'business_name',
  'email': 'email',
  'website': 'website',
  'suburb': 'suburb',
  'city': 'city',
  'category': 'category_name',
  'current stage': 'current_stage',
  'stage completed date': 'stage_completed_date',
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

const STAGE_LABEL_LOOKUP = new Map<string, LeadImportStage>()
for (const opt of STAGE_OPTIONS) STAGE_LABEL_LOOKUP.set(opt.label.toLowerCase(), opt.value)
for (const v of STAGE_VALUES) STAGE_LABEL_LOOKUP.set(v.toLowerCase(), v)

function resolveStage(raw: string): LeadImportStage | undefined {
  return STAGE_LABEL_LOOKUP.get(raw.trim().toLowerCase())
}

function parseDateLoose(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

function downloadTemplateCsv() {
  downloadCsv('lead-import-template.csv', buildTemplateRows())
}

export function ImportLeadsModal({ open, onClose, onImported }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [headerKeys, setHeaderKeys] = useState<Set<string>>(new Set())
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([])

  const [cities, setCities] = useState<string[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [defaultCity, setDefaultCity] = useState('')
  const [defaultCategoryName, setDefaultCategoryName] = useState('')

  const [importing, setImporting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportSummary | null>(null)

  useEffect(() => {
    if (!open) return
    Promise.all([
      fetch('/api/categories').then((r) => r.json() as Promise<{ data?: Category[] }>),
      fetch('/api/cities').then((r) => r.json() as Promise<{ data?: string[] }>),
    ]).then(([catJson, cityJson]) => {
      setCategories(catJson.data ?? [])
      setCities(cityJson.data ?? [])
    }).catch(() => {})
  }, [open])

  function reset() {
    setFileName('')
    setParseError(null)
    setHeaderKeys(new Set())
    setParsedRows([])
    setDefaultCity('')
    setDefaultCategoryName('')
    setImporting(false)
    setServerError(null)
    setResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setParseError(null)
    setResult(null)
    setServerError(null)

    const text = await file.text()
    const table = parseCsv(text)

    if (table.length === 0) {
      setParseError('The file is empty')
      setParsedRows([])
      setHeaderKeys(new Set())
      return
    }

    const [headerRow, ...dataRows] = table
    const normalizedHeaders = headerRow.map(normalizeHeader)
    const keys = normalizedHeaders.map((h) => HEADER_ALIASES[h] ?? null)

    if (!keys.includes('business_name') || !keys.includes('email')) {
      setParseError('CSV must include "Business Name" and "Email" columns')
      setParsedRows([])
      setHeaderKeys(new Set())
      return
    }

    setHeaderKeys(new Set(keys.filter((k): k is string => Boolean(k))))

    const rows: Record<string, string>[] = []
    for (const raw of dataRows) {
      if (isBlankRow(raw)) continue
      const obj: Record<string, string> = {}
      keys.forEach((k, idx) => { if (k) obj[k] = raw[idx] ?? '' })
      rows.push(obj)
    }
    setParsedRows(rows)
  }

  const hasCityColumn = headerKeys.has('city')
  const hasCategoryColumn = headerKeys.has('category_name')

  const summary = useMemo(() => {
    const ready: ReadyRow[] = []
    const invalidEmail: RowIssue[] = []
    const duplicateInFile: RowIssue[] = []
    const failed: RowIssue[] = []
    const seen = new Set<string>()

    parsedRows.forEach((row, idx) => {
      const rowNum = idx + 2 // +1 for header, +1 for 1-indexing
      const business_name = (row.business_name ?? '').trim()
      const emailRaw = (row.email ?? '').trim()

      if (!business_name) {
        failed.push({ rowNum, business_name: '(blank)', email: emailRaw, reason: 'Missing business name' })
        return
      }
      if (!emailRaw) {
        failed.push({ rowNum, business_name, email: '', reason: 'Missing email' })
        return
      }
      if (!z.string().email().safeParse(emailRaw).success) {
        invalidEmail.push({ rowNum, business_name, email: emailRaw, reason: 'Invalid email address' })
        return
      }

      const normalizedEmail = emailRaw.toLowerCase()
      if (seen.has(normalizedEmail)) {
        duplicateInFile.push({ rowNum, business_name, email: emailRaw, reason: 'Duplicate email within file' })
        return
      }
      seen.add(normalizedEmail)

      const city = (row.city ?? '').trim() || defaultCity
      if (!city) {
        failed.push({ rowNum, business_name, email: emailRaw, reason: 'Missing city' })
        return
      }

      const category_name = (row.category_name ?? '').trim() || defaultCategoryName
      if (!category_name) {
        failed.push({ rowNum, business_name, email: emailRaw, reason: 'Missing category' })
        return
      }

      let current_stage: LeadImportStage = 'initial_sent'
      const stageRaw = (row.current_stage ?? '').trim()
      if (stageRaw) {
        const resolved = resolveStage(stageRaw)
        if (!resolved) {
          failed.push({ rowNum, business_name, email: emailRaw, reason: `Unrecognized Current Stage "${stageRaw}"` })
          return
        }
        current_stage = resolved
      }

      let stage_completed_date: string | undefined
      if (current_stage !== 'new') {
        const dateRaw = (row.stage_completed_date ?? '').trim()
        stage_completed_date = (dateRaw && parseDateLoose(dateRaw)) || todayIsoDate()
      }

      ready.push({
        rowNum,
        business_name,
        email: emailRaw,
        website: (row.website ?? '').trim() || undefined,
        suburb: (row.suburb ?? '').trim() || undefined,
        city,
        category_name,
        current_stage,
        stage_completed_date,
      })
    })

    return { totalNonBlank: parsedRows.length, ready, invalidEmail, duplicateInFile, failed }
  }, [parsedRows, defaultCity, defaultCategoryName])

  const needsCityDefault = parsedRows.length > 0 && !hasCityColumn && !defaultCity
  const needsCategoryDefault = parsedRows.length > 0 && !hasCategoryColumn && !defaultCategoryName
  const canImport = parsedRows.length > 0 && !parseError && !needsCityDefault && !needsCategoryDefault && summary.ready.length > 0 && !importing

  async function handleImport() {
    if (!canImport) return
    setImporting(true)
    setServerError(null)
    try {
      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: summary.ready.map((r) => ({
            row_num: r.rowNum,
            business_name: r.business_name,
            email: r.email,
            website: r.website,
            suburb: r.suburb,
            city: r.city,
            category_name: r.category_name,
            current_stage: r.current_stage,
            stage_completed_date: r.stage_completed_date,
          })),
        }),
      })
      const json = await res.json() as {
        imported?: number
        duplicates?: number
        failed?: Array<{ row_num: number; business_name: string; email: string; reason: string }>
        error?: string
      }
      if (!res.ok) {
        setServerError(json.error ?? 'Import failed')
        return
      }
      const serverFailed: RowIssue[] = (json.failed ?? []).map((f) => ({
        rowNum: f.row_num,
        business_name: f.business_name,
        email: f.email,
        reason: f.reason,
      }))
      setResult({
        totalRowsProcessed: summary.totalNonBlank,
        imported: json.imported ?? 0,
        duplicates: (json.duplicates ?? 0) + summary.duplicateInFile.length,
        invalidEmails: summary.invalidEmail.length,
        failed: [...summary.failed, ...serverFailed].sort((a, b) => a.rowNum - b.rowNum),
      })
      onImported()
    } catch {
      setServerError('Network error — please try again')
    } finally {
      setImporting(false)
    }
  }

  function handleDone() {
    reset()
    onClose()
  }

  const categoryOptions = categories.map((c) => ({ value: c.name, label: c.name }))
  const cityOptions = cities.map((c) => ({ value: c, label: c }))

  return (
    <Modal open={open} onClose={handleClose} title="Import Leads" wide>
      {result ? (
        <div>
          <p className="text-sm mb-3" style={{ color: '#94a3b8' }}>
            Processed {result.totalRowsProcessed} row{result.totalRowsProcessed === 1 ? '' : 's'}.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <SummaryTile label="Imported" value={result.imported} color="#4ade80" />
            <SummaryTile label="Duplicates skipped" value={result.duplicates} color="#fbbf24" />
            <SummaryTile label="Invalid emails" value={result.invalidEmails} color="#fb923c" />
            <SummaryTile label="Failed" value={result.failed.length} color="#f87171" />
          </div>

          {result.failed.length > 0 && (
            <div className="mb-4">
              <p className="text-sm mb-2" style={{ color: '#f87171' }}>Failed rows:</p>
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {result.failed.map((f, i) => (
                  <li key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(248,113,113,0.08)', color: '#fca5a5' }}>
                    <span className="font-medium">Row {f.rowNum} — {f.business_name || f.email}</span>{' — '}{f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button onClick={handleDone}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: '#94a3b8' }}>
              Upload a CSV of leads to import. Required columns: Business Name, Email.
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={downloadTemplateCsv}>
              <Download size={13} />
              Download CSV Template
            </Button>
          </div>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="hidden"
              id="import-leads-file"
            />
            <label
              htmlFor="import-leads-file"
              className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm cursor-pointer w-full"
              style={{ background: '#0f1117', border: '1px dashed #2a2d3e', color: fileName ? '#f1f5f9' : '#64748b' }}
            >
              {fileName ? <FileText size={15} /> : <Upload size={15} />}
              {fileName || 'Choose a CSV file…'}
              {fileName && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); reset() }}
                  className="ml-auto"
                  style={{ color: '#64748b' }}
                >
                  <XIcon size={14} />
                </button>
              )}
            </label>
          </div>

          {parseError && <p className="text-sm text-red-400">{parseError}</p>}
          {serverError && <p className="text-sm text-red-400">{serverError}</p>}

          {parsedRows.length > 0 && !parseError && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SummaryTile label="Rows found" value={summary.totalNonBlank} color="#94a3b8" />
                <SummaryTile label="Ready to import" value={summary.ready.length} color="#4ade80" />
                <SummaryTile label="Invalid / duplicate" value={summary.invalidEmail.length + summary.duplicateInFile.length} color="#fbbf24" />
                <SummaryTile label="Other issues" value={summary.failed.length} color="#f87171" />
              </div>

              {(!hasCityColumn || !hasCategoryColumn) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {!hasCityColumn && (
                    <Select
                      label="City * (no City column found)"
                      value={defaultCity}
                      onChange={(e) => setDefaultCity(e.target.value)}
                      options={cityOptions}
                      placeholder={cities.length === 0 ? 'Loading cities…' : 'Select a city for all rows'}
                      required
                    />
                  )}
                  {!hasCategoryColumn && (
                    <Select
                      label="Category * (no Category column found)"
                      value={defaultCategoryName}
                      onChange={(e) => setDefaultCategoryName(e.target.value)}
                      options={categoryOptions}
                      placeholder={categories.length === 0 ? 'Loading categories…' : 'Select a category for all rows'}
                      required
                    />
                  )}
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={importing}>
              Cancel
            </Button>
            <Button type="button" onClick={handleImport} disabled={!canImport}>
              {importing ? 'Importing…' : `Import${summary.ready.length ? ` ${summary.ready.length} Lead${summary.ready.length === 1 ? '' : 's'}` : ''}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function SummaryTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}>
      <div className="text-lg font-semibold" style={{ color }}>{value}</div>
      <div className="text-xs" style={{ color: '#64748b' }}>{label}</div>
    </div>
  )
}
