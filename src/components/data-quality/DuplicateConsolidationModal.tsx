'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { StatusBadge } from '@/components/ui/Badge'
import type { DataQualityLeadDetail, DataQualityOwnership } from '@/lib/data-quality-report'
import type { DuplicateConsolidationPreview } from '@/lib/duplicate-consolidation'

interface DuplicateGroup {
  normalized_email: string | null
  preferred_lead_id: string | null
  suggested_redundant_lead_ids: string[]
  leads: DataQualityLeadDetail[]
  ownership: DataQualityOwnership | null
}

interface Props {
  group: DuplicateGroup | null
  onClose: () => void
  onOpenLead: (id: string) => void
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function labelField(field: string): string {
  return field.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

export function DuplicateConsolidationModal({ group, onClose, onOpenLead }: Props) {
  const [keepLeadId, setKeepLeadId] = useState<string | null>(null)
  const [preview, setPreview] = useState<DuplicateConsolidationPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmationOpen, setConfirmationOpen] = useState(false)

  function close() {
    if (loading) return
    setKeepLeadId(null); setPreview(null); setError(null); setConfirmationOpen(false); onClose()
  }

  async function requestPreview() {
    if (!group?.normalized_email || !keepLeadId) return
    setLoading(true); setError(null); setPreview(null)
    try {
      const response = await fetch('/api/data-quality/consolidate/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          normalized_email: group.normalized_email,
          keep_lead_id: keepLeadId,
          redundant_lead_ids: group.leads.filter((lead) => lead.id !== keepLeadId).map((lead) => lead.id),
        }),
      })
      const json = await response.json() as DuplicateConsolidationPreview & { error?: string }
      if (!response.ok) throw new Error(json.error ?? 'Unable to build consolidation preview.')
      setPreview(json)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to build consolidation preview.')
    } finally { setLoading(false) }
  }

  const ownerDiffers = Boolean(group?.ownership?.owner_lead_id && keepLeadId && group.ownership.owner_lead_id !== keepLeadId)
  const preferredDiffersFromOwner = Boolean(group?.preferred_lead_id && group.ownership?.owner_lead_id && group.preferred_lead_id !== group.ownership.owner_lead_id)

  return <>
    <Modal open={!!group} onClose={close} title="Consolidate Duplicate — supervised review" wide>
      {group && <div className="space-y-5">
        <div className="rounded-lg p-3 text-sm" style={{ color: '#fde68a', background: '#78350f22', border: '1px solid #92400e' }}>
          Preview only. Select the lead to keep explicitly. No lead, email, deal, follow-up, flag, or ownership row will be changed.
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full px-2.5 py-1 bg-slate-500/15 text-slate-300">Recipient: {group.normalized_email}</span>
          {preferredDiffersFromOwner && <span className="rounded-full px-2.5 py-1 bg-amber-500/15 text-amber-300">Calculated preferred differs from current owner</span>}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {group.leads.map((lead) => {
            const selected = keepLeadId === lead.id
            const preferred = group.preferred_lead_id === lead.id
            const owner = group.ownership?.state === 'active' && group.ownership.owner_lead_id === lead.id
            return <label key={lead.id} className="block rounded-xl p-4 cursor-pointer" style={{ background: '#11141d', border: selected ? '2px solid #38bdf8' : '1px solid #2a2d3e' }}>
              <div className="flex items-start gap-3">
                <input type="radio" name="keep-lead" checked={selected} onChange={() => { setKeepLeadId(lead.id); setPreview(null); setError(null) }} className="mt-1 accent-sky-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-white">{lead.business_name}</span>
                    {selected && <span className="rounded-full px-2 py-0.5 text-[10px] bg-sky-500/20 text-sky-300">Keep</span>}
                    {owner && <span className="rounded-full px-2 py-0.5 text-[10px] bg-violet-500/20 text-violet-300">Current Owner</span>}
                    {preferred && <span className="rounded-full px-2 py-0.5 text-[10px] bg-amber-500/20 text-amber-300">Calculated Preferred</span>}
                  </div>
                  <div className="mt-1 text-[10px] font-mono break-all" style={{ color: '#64748b' }}>{lead.id}</div>
                  <div className="mt-3"><StatusBadge status={lead.status} /></div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 mt-3 text-xs">
                    <Detail label="Created" value={formatDate(lead.created_at)} />
                    <Detail label="Updated" value={formatDate(lead.updated_at)} />
                    <Detail label="Email history" value={String(lead.email_history_count)} />
                    <Detail label="Verified replies" value={String(lead.reply_count)} />
                    <Detail label="Latest replied_at" value={formatDate(lead.latest_replied_at)} />
                    <Detail label="Reply activity" value={formatDate(lead.latest_reply_activity_at)} />
                    <Detail label="Reply lifecycle" value={lead.reply_lifecycle_state.replaceAll('_', ' ')} />
                    <Detail label="Deals" value={String(lead.deal_count)} />
                    <Detail label="Website" value={lead.website} />
                    <Detail label="Phone" value={lead.phone} />
                    <Detail label="Address" value={[lead.address, lead.suburb, lead.city, lead.state].filter(Boolean).join(', ')} />
                    <Detail label="Category" value={lead.category} />
                    <Detail label="Instagram" value={lead.instagram} />
                    <Detail label="Facebook" value={lead.facebook} />
                  </dl>
                  {lead.notes && <div className="mt-3 rounded p-2 text-xs whitespace-pre-wrap" style={{ color: '#cbd5e1', background: '#0f1117' }}><span style={{ color: '#64748b' }}>Notes: </span>{lead.notes}</div>}
                  {lead.deals.length > 0 && <div className="mt-3 space-y-1">{lead.deals.map((deal) => <div key={deal.id} className="text-xs text-emerald-300">Deal: ${deal.deal_value ?? '—'} · {deal.deal_type ?? 'type unavailable'} · {formatDate(deal.closed_at ?? deal.created_at)}</div>)}</div>}
                  <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={(event) => { event.preventDefault(); onOpenLead(lead.id) }}>Open Lead</Button>
                </div>
              </div>
            </label>
          })}
        </div>

        {ownerDiffers && <div role="alert" className="rounded-lg p-3 text-sm flex gap-2" style={{ color: '#fca5a5', background: '#7f1d1d22', border: '1px solid #991b1b' }}>
          <AlertTriangle size={17} className="shrink-0" /> <strong>Recipient ownership must be transferred before consolidation.</strong>
        </div>}
        {error && <div role="alert" className="rounded-lg p-3 text-sm text-red-300 bg-red-950/30">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={loading} onClick={close}>Cancel</Button>
          <Button disabled={!keepLeadId || loading} onClick={() => void requestPreview()}>{loading ? 'Building preview…' : 'Preview Consolidation'}</Button>
        </div>

        {preview && <PreviewPlan preview={preview} onReviewConfirmation={() => setConfirmationOpen(true)} />}
      </div>}
    </Modal>

    <Modal open={confirmationOpen} onClose={() => setConfirmationOpen(false)} title="Final consolidation confirmation">
      <div className="space-y-4">
        <div className="flex gap-2 rounded-lg p-3 text-sm" style={{ color: '#fde68a', background: '#78350f22', border: '1px solid #92400e' }}>
          <ShieldAlert size={18} className="shrink-0" /> Confirmation is intentionally disabled in this preview-first rollout. No mutation endpoint or database RPC has been installed.
        </div>
        <p className="text-sm" style={{ color: '#cbd5e1' }}>A later atomic RPC must lock the group, verify preview token <span className="font-mono text-xs">{preview?.version_token.slice(0, 12)}…</span>, transfer ownership, preserve history, cancel duplicate future sends, archive redundant leads, and write the audit record in one transaction.</p>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setConfirmationOpen(false)}>Close</Button><Button disabled>Confirm Consolidation (disabled)</Button></div>
      </div>
    </Modal>
  </>
}

function PreviewPlan({ preview, onReviewConfirmation }: { preview: DuplicateConsolidationPreview; onReviewConfirmation: () => void }) {
  const relevantFields = preview.fields.filter((field) => field.action === 'possible_fill' || field.action === 'conflict')
  return <div className="space-y-4 border-t pt-5" style={{ borderColor: '#2a2d3e' }}>
    <div className="flex items-center gap-2">
      {preview.safe ? <CheckCircle2 size={18} className="text-emerald-400" /> : <ShieldAlert size={18} className="text-red-400" />}
      <h3 className="font-semibold text-white">Read-only plan: {preview.safe ? 'no blockers found' : `${preview.blocking_reasons.length} blocker(s)`}</h3>
    </div>
    {preview.blocking_reasons.length > 0 && <PlanList title="Blocking reasons" items={preview.blocking_reasons.map((reason) => reason.message)} tone="red" />}
    {preview.warnings.length > 0 && <PlanList title="Warnings" items={preview.warnings.map((reason) => reason.message)} tone="amber" />}

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
      <PlanMetric label="Emails that would move" value={preview.emails.would_move.length} detail={`${preview.emails.replied_email_count} verified replied email(s) in group`} />
      <PlanMetric label="Deals that would move" value={preview.deals.would_move.length} detail="Every deal retained" />
      <PlanMetric label="Resulting status" value={preview.statuses.resulting_status} detail={preview.statuses.involved.map((entry) => entry.status).join(' · ')} />
      <PlanMetric label="Ownership" value={preview.ownership_impact.transfer_required ? 'Transfer required' : 'Unchanged'} detail={`Owner after: ${preview.ownership_impact.resulting_owner_lead_id}`} />
      <PlanMetric label="Future follow-ups cancelled" value={preview.followups.future_redundant_to_cancel.length} detail={`${preview.followups.historical_preserved.length} historical preserved`} />
      <PlanMetric label="Data Quality flags" value={preview.data_quality_flags.affected.length} detail="Resolved, not deleted, on confirmation" />
    </div>

    {relevantFields.length > 0 && <div>
      <h4 className="text-sm font-medium text-white mb-2">Field preservation and conflicts</h4>
      <div className="space-y-2">{relevantFields.map((field) => <div key={field.field} className="rounded-lg p-3 text-xs" style={{ background: '#11141d', border: `1px solid ${field.action === 'conflict' ? '#92400e' : '#166534'}` }}>
        <div className="font-medium" style={{ color: field.action === 'conflict' ? '#fde68a' : '#86efac' }}>{labelField(field.field)} · {field.action === 'conflict' ? 'conflict — keep value not overwritten' : 'possible fill'}</div>
        <div className="mt-1" style={{ color: '#cbd5e1' }}>Keep: {String(field.keep_value ?? 'empty')}</div>
        <div className="mt-1" style={{ color: '#94a3b8' }}>Other: {field.redundant_values.map((entry) => String(entry.value)).join(' | ') || 'empty'}</div>
      </div>)}</div>
    </div>}

    <div className="rounded-lg p-3 text-xs" style={{ color: '#cbd5e1', background: '#0f1117', border: '1px solid #2a2d3e' }}>
      <div>Optimistic concurrency token: <span className="font-mono break-all">{preview.version_token}</span></div>
      <div className="mt-1">Archive plan: {preview.archival_plan}</div>
    </div>
    <div className="flex justify-end"><Button variant="secondary" onClick={onReviewConfirmation}>Review Final Confirmation</Button></div>
  </div>
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><dt style={{ color: '#64748b' }}>{label}</dt><dd className="mt-0.5 text-slate-300 break-words">{value || '—'}</dd></div>
}

function PlanMetric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className="rounded-lg p-3" style={{ background: '#11141d', border: '1px solid #2a2d3e' }}><div className="text-xs" style={{ color: '#64748b' }}>{label}</div><div className="font-medium text-white mt-1 break-all">{value}</div><div className="text-xs mt-1" style={{ color: '#94a3b8' }}>{detail}</div></div>
}

function PlanList({ title, items, tone }: { title: string; items: string[]; tone: 'red' | 'amber' }) {
  return <div className="rounded-lg p-3" style={{ color: tone === 'red' ? '#fca5a5' : '#fde68a', background: tone === 'red' ? '#7f1d1d22' : '#78350f22', border: `1px solid ${tone === 'red' ? '#991b1b' : '#92400e'}` }}><div className="text-sm font-medium">{title}</div><ul className="mt-2 pl-5 list-disc space-y-1 text-xs">{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>
}
