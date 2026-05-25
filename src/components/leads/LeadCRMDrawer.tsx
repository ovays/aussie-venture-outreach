'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, Copy, ExternalLink, Phone, Star, Globe, Mail, AtSign,
  Send, MessageSquare, TrendingUp, RotateCcw, Trophy, Skull,
  StickyNote, Zap, Activity, CheckCircle2, AlertTriangle, Clock,
  ChevronDown, ChevronUp, Flame, Eye, EyeOff,
} from 'lucide-react'
import { useLeadDrawer } from '@/lib/lead-drawer-context'
import { timeAgo, formatDate, formatDateTime } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Email {
  id: string
  type: string
  subject: string | null
  status: string | null
  sent_at: string | null
  replied_at: string | null
  created_at: string
}

interface ActivityEvent {
  id: string
  event_type: string
  description: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

interface Deal {
  id: string
  deal_value: number
  deal_type: string
  content_created: boolean
  payment_received: boolean
  notes: string | null
  closed_at: string
}

interface DmQueueItem {
  id: string
  platform: string
  status: string
  sent_at: string | null
  created_at: string
}

interface FullLead {
  id: string
  business_name: string
  category_name: string
  city: string
  suburb: string | null
  email: string | null
  phone: string | null
  website: string | null
  instagram_handle: string | null
  google_rating: number | null
  halal_confidence_score: number | null
  halal_reasons: string[] | null
  status: string
  deal_value: number | null
  deal_type: string | null
  content_created: boolean
  payment_received: boolean
  notes: string | null
  created_at: string
  updated_at: string | null
  halal: boolean
  description: string | null
  services: string | null
  reactivation_sent_at: string | null
  emails: Email[]
  activity_log: ActivityEvent[]
  deals: Deal[]
  dm_queue: DmQueueItem[]
}

interface TimelineItem {
  id: string
  label: string
  detail: string | null
  timestamp: string
  accent: string
  bgColor: string
  icon: React.ReactNode
  isNote?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; color: string; bg: string; ring: string }> = {
  new:           { label: 'New',           color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', ring: 'rgba(148,163,184,0.2)' },
  researched:    { label: 'Researched',    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', ring: 'rgba(167,139,250,0.2)' },
  email_ready:   { label: 'Email Ready',   color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  ring: 'rgba(251,191,36,0.2)'  },
  contacted:     { label: 'Contacted',     color: '#fb923c', bg: 'rgba(251,146,60,0.1)',  ring: 'rgba(251,146,60,0.2)'  },
  replied:       { label: 'Replied',       color: '#4ade80', bg: 'rgba(74,222,128,0.1)',  ring: 'rgba(74,222,128,0.2)'  },
  negotiating:   { label: 'Negotiating',   color: '#22d3ee', bg: 'rgba(34,211,238,0.1)',  ring: 'rgba(34,211,238,0.2)'  },
  interested:    { label: 'Interested',    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', ring: 'rgba(167,139,250,0.2)' },
  closed:        { label: 'Closed Won',    color: '#34d399', bg: 'rgba(52,211,153,0.1)',  ring: 'rgba(52,211,153,0.2)'  },
  closed_manual: { label: 'Closed',        color: '#34d399', bg: 'rgba(52,211,153,0.1)',  ring: 'rgba(52,211,153,0.2)'  },
  dead:          { label: 'Dead',          color: '#f87171', bg: 'rgba(248,113,113,0.1)', ring: 'rgba(248,113,113,0.2)' },
}

const EMAIL_TYPE_LABELS: Record<string, string> = {
  initial_pitch: 'Initial pitch sent',
  follow_up_1:   'Follow-up 1 sent',
  follow_up_2:   'Follow-up 2 sent',
  follow_up_3:   'Follow-up 3 sent',
}

const EVENT_LABELS: Record<string, { label: string; accent: string; bg: string; icon: React.ReactNode }> = {
  email_sent:        { label: 'Email sent',            accent: '#38bdf8', bg: 'rgba(56,189,248,0.1)',  icon: <Send size={11} /> },
  lead_replied:      { label: 'Lead replied',          accent: '#4ade80', bg: 'rgba(74,222,128,0.1)',  icon: <MessageSquare size={11} /> },
  lead_marked_dead:  { label: 'Lead marked dead',      accent: '#f87171', bg: 'rgba(248,113,113,0.1)', icon: <Skull size={11} /> },
  status_changed:    { label: 'Status changed',        accent: '#a78bfa', bg: 'rgba(167,139,250,0.1)', icon: <Activity size={11} /> },
  note_added:        { label: 'Note',                  accent: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  icon: <StickyNote size={11} /> },
  reactivation_sent: { label: 'Reactivation email sent', accent: '#fb923c', bg: 'rgba(251,146,60,0.1)', icon: <RotateCcw size={11} /> },
  dm_sent:           { label: 'DM sent',               accent: '#ec4899', bg: 'rgba(236,72,153,0.1)',  icon: <AtSign size={11} /> },
  deal_created:      { label: 'Deal created',          accent: '#34d399', bg: 'rgba(52,211,153,0.1)',  icon: <Trophy size={11} /> },
}

// ── Timeline builder ──────────────────────────────────────────────────────────

function buildTimeline(emails: Email[], events: ActivityEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []

  for (const email of emails) {
    if (email.sent_at) {
      const meta = EVENT_LABELS.email_sent
      items.push({
        id: `email-sent-${email.id}`,
        label: EMAIL_TYPE_LABELS[email.type] ?? 'Email sent',
        detail: email.subject,
        timestamp: email.sent_at,
        accent: meta.accent,
        bgColor: meta.bg,
        icon: meta.icon,
      })
    }
    if (email.replied_at) {
      const meta = EVENT_LABELS.lead_replied
      items.push({
        id: `email-replied-${email.id}`,
        label: 'Reply received',
        detail: email.subject ? `Re: ${email.subject}` : null,
        timestamp: email.replied_at,
        accent: meta.accent,
        bgColor: meta.bg,
        icon: meta.icon,
      })
    }
  }

  for (const event of events) {
    const meta = EVENT_LABELS[event.event_type]
    items.push({
      id: `event-${event.id}`,
      label: meta?.label ?? event.event_type.replace(/_/g, ' '),
      detail: event.description,
      timestamp: event.created_at,
      accent: meta?.accent ?? '#64748b',
      bgColor: meta?.bg ?? 'rgba(100,116,139,0.1)',
      icon: meta?.icon ?? <Zap size={11} />,
      isNote: event.event_type === 'note_added',
    })
  }

  return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

// ── Health badges ─────────────────────────────────────────────────────────────

function HealthBadges({ lead }: { lead: FullLead }) {
  const badges: { label: string; color: string; bg: string; ring: string; pulse?: boolean; icon: React.ReactNode }[] = []

  if (['replied', 'negotiating', 'interested'].includes(lead.status)) {
    badges.push({ label: 'Hot Lead', color: '#fb923c', bg: 'rgba(251,146,60,0.12)', ring: 'rgba(251,146,60,0.3)', pulse: true, icon: <Flame size={10} /> })
  }
  if (lead.status === 'replied') {
    badges.push({ label: 'Awaiting Response', color: '#38bdf8', bg: 'rgba(56,189,248,0.1)', ring: 'rgba(56,189,248,0.25)', icon: <MessageSquare size={10} /> })
  }
  if (lead.status === 'negotiating') {
    badges.push({ label: 'Negotiating', color: '#22d3ee', bg: 'rgba(34,211,238,0.1)', ring: 'rgba(34,211,238,0.25)', icon: <TrendingUp size={10} /> })
  }
  if (lead.status === 'interested') {
    badges.push({ label: 'Interested', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', ring: 'rgba(167,139,250,0.25)', icon: <Zap size={10} /> })
  }

  const latestEmail = lead.emails.filter((e) => e.sent_at).sort((a, b) =>
    new Date(b.sent_at!).getTime() - new Date(a.sent_at!).getTime()
  )[0]
  if (latestEmail?.sent_at) {
    const daysSince = Math.floor((Date.now() - new Date(latestEmail.sent_at).getTime()) / 86_400_000)
    if (daysSince > 7 && lead.status === 'contacted') {
      badges.push({ label: 'Overdue', color: '#f87171', bg: 'rgba(248,113,113,0.1)', ring: 'rgba(248,113,113,0.25)', pulse: true, icon: <AlertTriangle size={10} /> })
    }
  }

  if (lead.status === 'dead') {
    badges.push({ label: 'Inactive', color: '#64748b', bg: 'rgba(100,116,139,0.08)', ring: 'rgba(100,116,139,0.2)', icon: <Clock size={10} /> })
  }
  if (['closed', 'closed_manual'].includes(lead.status)) {
    badges.push({ label: 'Closed Won', color: '#34d399', bg: 'rgba(52,211,153,0.1)', ring: 'rgba(52,211,153,0.25)', icon: <Trophy size={10} /> })
  }

  if (badges.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {badges.map((b) => (
        <span
          key={b.label}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.625rem] font-bold uppercase tracking-wide"
          style={{ color: b.color, background: b.bg, border: `1px solid ${b.ring}` }}
        >
          <span className="relative flex items-center justify-center">
            {b.pulse && (
              <span
                className="absolute w-2 h-2 rounded-full animate-ping"
                style={{ background: b.color, opacity: 0.4 }}
              />
            )}
            <span className="relative">{b.icon}</span>
          </span>
          {b.label}
        </span>
      ))}
    </div>
  )
}

// ── Quick Actions ─────────────────────────────────────────────────────────────

interface ActionDef {
  label: string
  icon: React.ReactNode
  accent: string
  bg: string
  action: 'status' | 'resend' | 'reactivate'
  value?: string
  confirm?: boolean
  variant?: 'danger'
}

function getQuickActions(status: string): ActionDef[] {
  const actions: ActionDef[] = []

  if (['new', 'researched', 'email_ready'].includes(status)) {
    actions.push({ label: 'Send Initial Email', icon: <Send size={12} />, accent: '#38bdf8', bg: 'rgba(56,189,248,0.1)', action: 'resend' })
    actions.push({ label: 'Mark Contacted', icon: <Mail size={12} />, accent: '#fb923c', bg: 'rgba(251,146,60,0.1)', action: 'status', value: 'contacted' })
  }

  if (status === 'contacted') {
    actions.push({ label: 'Send Follow-up', icon: <Send size={12} />, accent: '#38bdf8', bg: 'rgba(56,189,248,0.1)', action: 'resend' })
    actions.push({ label: 'Mark Replied', icon: <MessageSquare size={12} />, accent: '#4ade80', bg: 'rgba(74,222,128,0.1)', action: 'status', value: 'replied' })
    actions.push({ label: 'Mark Interested', icon: <Zap size={12} />, accent: '#a78bfa', bg: 'rgba(167,139,250,0.1)', action: 'status', value: 'interested' })
    actions.push({ label: 'Mark Dead', icon: <Skull size={12} />, accent: '#f87171', bg: 'rgba(248,113,113,0.1)', action: 'status', value: 'dead', confirm: true, variant: 'danger' })
  }

  if (status === 'replied') {
    actions.push({ label: 'Move to Negotiation', icon: <TrendingUp size={12} />, accent: '#22d3ee', bg: 'rgba(34,211,238,0.1)', action: 'status', value: 'negotiating' })
    actions.push({ label: 'Mark Interested', icon: <Zap size={12} />, accent: '#a78bfa', bg: 'rgba(167,139,250,0.1)', action: 'status', value: 'interested' })
    actions.push({ label: 'Mark Dead', icon: <Skull size={12} />, accent: '#f87171', bg: 'rgba(248,113,113,0.1)', action: 'status', value: 'dead', confirm: true, variant: 'danger' })
  }

  if (status === 'interested') {
    actions.push({ label: 'Move to Negotiation', icon: <TrendingUp size={12} />, accent: '#22d3ee', bg: 'rgba(34,211,238,0.1)', action: 'status', value: 'negotiating' })
    actions.push({ label: 'Mark Closed Won', icon: <Trophy size={12} />, accent: '#34d399', bg: 'rgba(52,211,153,0.1)', action: 'status', value: 'closed_manual' })
    actions.push({ label: 'Mark Dead', icon: <Skull size={12} />, accent: '#f87171', bg: 'rgba(248,113,113,0.1)', action: 'status', value: 'dead', confirm: true, variant: 'danger' })
  }

  if (status === 'negotiating') {
    actions.push({ label: 'Mark Closed Won', icon: <Trophy size={12} />, accent: '#34d399', bg: 'rgba(52,211,153,0.1)', action: 'status', value: 'closed_manual' })
    actions.push({ label: 'Mark Dead', icon: <Skull size={12} />, accent: '#f87171', bg: 'rgba(248,113,113,0.1)', action: 'status', value: 'dead', confirm: true, variant: 'danger' })
  }

  if (status === 'dead') {
    actions.push({ label: 'Reactivate Lead', icon: <RotateCcw size={12} />, accent: '#fb923c', bg: 'rgba(251,146,60,0.1)', action: 'reactivate' })
    actions.push({ label: 'Mark Contacted', icon: <Mail size={12} />, accent: '#38bdf8', bg: 'rgba(56,189,248,0.1)', action: 'status', value: 'contacted' })
  }

  return actions
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ label, icon, collapsed, onToggle }: {
  label: string
  icon: React.ReactNode
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-5 py-3 transition-colors hover:bg-white/[0.02]"
      style={{ borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.04)' }}
    >
      <span style={{ color: '#475569' }}>{icon}</span>
      <span className="text-[0.6875rem] font-bold uppercase tracking-widest" style={{ color: '#334155' }}>
        {label}
      </span>
      <div className="flex-1 h-px mx-2" style={{ background: 'rgba(255,255,255,0.04)' }} />
      {collapsed
        ? <ChevronDown size={12} style={{ color: '#334155' }} />
        : <ChevronUp size={12} style={{ color: '#334155' }} />}
    </button>
  )
}

// ── Skeleton loader ────────────────────────────────────────────────────────────

function DrawerSkeleton() {
  return (
    <div className="p-5 space-y-4 animate-pulse">
      <div className="h-6 w-3/4 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)' }} />
      <div className="h-4 w-1/2 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
      <div className="h-4 w-2/3 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
      <div className="flex gap-2 mt-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-7 w-24 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)' }} />
        ))}
      </div>
      <div className="space-y-3 mt-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3 items-start">
            <div className="w-6 h-6 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.05)' }} />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-3/4 rounded" style={{ background: 'rgba(255,255,255,0.05)' }} />
              <div className="h-3 w-1/2 rounded" style={{ background: 'rgba(255,255,255,0.03)' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main drawer ────────────────────────────────────────────────────────────────

export function LeadCRMDrawer() {
  const { leadId, closeDrawer, triggerRefresh } = useLeadDrawer()
  const [lead, setLead] = useState<FullLead | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Section collapse states
  const [actionsCollapsed, setActionsCollapsed] = useState(false)
  const [timelineCollapsed, setTimelineCollapsed] = useState(false)
  const [emailsCollapsed, setEmailsCollapsed] = useState(true)
  const [detailsCollapsed, setDetailsCollapsed] = useState(true)

  // Interaction states
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<ActionDef | null>(null)
  const [copied, setCopied] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [noteAdded, setNoteAdded] = useState(false)

  // Edit states
  const [editingEmail, setEditingEmail] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const isOpen = !!leadId

  const fetchLead = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/leads/${id}`)
      const json = await res.json() as { data?: FullLead; error?: string }
      if (!res.ok || !json.data) { setError('Lead not found'); return }
      setLead(json.data)
      setEmailInput(json.data.email ?? '')
      setNoteText('')
    } catch {
      setError('Failed to load lead')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (leadId) {
      fetchLead(leadId)
      setActionsCollapsed(false)
      setTimelineCollapsed(false)
      setEmailsCollapsed(true)
      setDetailsCollapsed(true)
      setConfirmAction(null)
      setEditingEmail(false)
      scrollRef.current?.scrollTo(0, 0)
    } else {
      setLead(null)
    }
  }, [leadId, fetchLead])

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeDrawer() }
    if (isOpen) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeDrawer])

  // Body scroll lock on mobile
  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  async function runAction(action: ActionDef) {
    if (!lead) return
    if (action.confirm && !confirmAction) { setConfirmAction(action); return }
    setConfirmAction(null)
    setActionLoading(action.label)
    try {
      if (action.action === 'status' && action.value) {
        await fetch(`/api/leads/${lead.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action.value }),
        })
        setLead((prev) => prev ? { ...prev, status: action.value! } : prev)
        triggerRefresh()
      } else if (action.action === 'resend' || action.action === 'reactivate') {
        const res = await fetch(`/api/leads/${lead.id}/resend`, { method: 'POST' })
        const json = await res.json() as { success?: boolean }
        if (json.success) {
          setLead((prev) => prev ? { ...prev, status: 'contacted' } : prev)
          triggerRefresh()
          await fetchLead(lead.id)
        }
      }
    } finally {
      setActionLoading(null)
    }
  }

  async function addNote() {
    if (!lead || !noteText.trim()) return
    setAddingNote(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: noteText }),
      })
      if (res.ok) {
        setNoteText('')
        setNoteAdded(true)
        setTimeout(() => setNoteAdded(false), 3000)
        await fetchLead(lead.id)
      }
    } finally {
      setAddingNote(false)
    }
  }

  async function saveEmail() {
    if (!lead) return
    setSavingEmail(true)
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, email: emailInput || null }),
    })
    setLead((prev) => prev ? { ...prev, email: emailInput || null } : prev)
    setSavingEmail(false)
    setEditingEmail(false)
    triggerRefresh()
  }

  async function changeStatus(status: string) {
    if (!lead) return
    await fetch(`/api/leads/${lead.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setLead((prev) => prev ? { ...prev, status } : prev)
    triggerRefresh()
  }

  async function toggleField(field: 'content_created' | 'payment_received', value: boolean) {
    if (!lead) return
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: lead.id, [field]: value }),
    })
    setLead((prev) => prev ? { ...prev, [field]: value } : prev)
  }

  function copyEmail() {
    if (!lead?.email) return
    navigator.clipboard.writeText(lead.email)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const statusMeta = lead ? (STATUS_META[lead.status] ?? STATUS_META.new) : null
  const timeline = lead ? buildTimeline(lead.emails, lead.activity_log) : []
  const quickActions = lead ? getQuickActions(lead.status) : []
  const emailCount = lead?.emails.length ?? 0
  const replyCount = lead?.emails.filter((e) => e.replied_at).length ?? 0
  const latestEmail = lead?.emails
    .filter((e) => e.sent_at)
    .sort((a, b) => new Date(b.sent_at!).getTime() - new Date(a.sent_at!).getTime())[0] ?? null

  const STATUS_OPTIONS = ['new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_manual', 'dead']

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-all duration-300"
        style={{
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: isOpen ? 'blur(2px)' : 'none',
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
        onClick={closeDrawer}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col"
        style={{
          width: 'min(580px, 100vw)',
          background: '#0d0f18',
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '-24px 0 80px rgba(0,0,0,0.6)',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* ── Sticky header ── */}
        <div
          className="flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          {lead && !loading ? (
            <div className="px-5 pt-4 pb-4">
              {/* Top row: back arrow + close */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  {statusMeta && (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[0.625rem] font-bold uppercase tracking-wide"
                      style={{ color: statusMeta.color, background: statusMeta.bg, border: `1px solid ${statusMeta.ring}` }}
                    >
                      {statusMeta.label}
                    </span>
                  )}
                  {lead.halal && (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[0.625rem] font-bold uppercase tracking-wide"
                      style={{ color: '#4ade80', background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)' }}
                    >
                      Halal
                    </span>
                  )}
                </div>
                <button
                  onClick={closeDrawer}
                  className="p-1.5 rounded-lg transition-colors hover:bg-white/[0.06]"
                  style={{ color: '#475569' }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Business name */}
              <h2 className="text-lg font-bold leading-tight" style={{ color: '#f1f5f9' }}>
                {lead.business_name}
              </h2>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                <span className="text-xs" style={{ color: '#475569' }}>{lead.category_name}</span>
                {(lead.suburb || lead.city) && (
                  <>
                    <span style={{ color: '#1e293b' }}>·</span>
                    <span className="text-xs" style={{ color: '#475569' }}>
                      {[lead.suburb, lead.city].filter(Boolean).join(', ')}
                    </span>
                  </>
                )}
                {lead.google_rating && (
                  <>
                    <span style={{ color: '#1e293b' }}>·</span>
                    <span className="flex items-center gap-0.5 text-xs" style={{ color: '#fbbf24' }}>
                      <Star size={10} fill="#fbbf24" />
                      {lead.google_rating}
                    </span>
                  </>
                )}
              </div>

              {/* Contact row */}
              <div className="flex flex-wrap items-center gap-2 mt-2.5">
                {lead.email && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-mono" style={{ color: '#64748b' }}>{lead.email}</span>
                    <button
                      onClick={copyEmail}
                      className="p-0.5 rounded transition-colors hover:text-white"
                      style={{ color: copied ? '#4ade80' : '#334155' }}
                      title="Copy email"
                    >
                      {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
                    </button>
                  </div>
                )}
                {lead.website && (
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs transition-colors hover:opacity-80"
                    style={{ color: '#38bdf8' }}
                  >
                    <Globe size={11} />
                    Website
                    <ExternalLink size={9} />
                  </a>
                )}
                {lead.phone && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: '#64748b' }}>
                    <Phone size={10} />
                    {lead.phone}
                  </span>
                )}
                {lead.instagram_handle && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: '#ec4899' }}>
                    <AtSign size={10} />
                    {lead.instagram_handle}
                  </span>
                )}
              </div>

              {/* Health badges */}
              <HealthBadges lead={lead} />

              {/* Quick stats row */}
              <div className="flex items-center gap-3 mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                <div className="text-center">
                  <p className="text-sm font-bold" style={{ color: '#f1f5f9' }}>{emailCount}</p>
                  <p className="text-[0.625rem] uppercase tracking-wide" style={{ color: '#334155' }}>Emails</p>
                </div>
                <div className="w-px h-6" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="text-center">
                  <p className="text-sm font-bold" style={{ color: replyCount > 0 ? '#4ade80' : '#f1f5f9' }}>{replyCount}</p>
                  <p className="text-[0.625rem] uppercase tracking-wide" style={{ color: '#334155' }}>Replies</p>
                </div>
                <div className="w-px h-6" style={{ background: 'rgba(255,255,255,0.06)' }} />
                <div className="text-center">
                  <p className="text-sm font-bold" style={{ color: '#f1f5f9' }}>
                    {Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86_400_000)}d
                  </p>
                  <p className="text-[0.625rem] uppercase tracking-wide" style={{ color: '#334155' }}>In Pipeline</p>
                </div>
                {latestEmail?.sent_at && (
                  <>
                    <div className="w-px h-6" style={{ background: 'rgba(255,255,255,0.06)' }} />
                    <div className="text-center min-w-0">
                      <p className="text-[0.6875rem] font-semibold tabular-nums" style={{ color: '#64748b' }}>
                        {timeAgo(latestEmail.sent_at)}
                      </p>
                      <p className="text-[0.625rem] uppercase tracking-wide" style={{ color: '#334155' }}>Last Email</p>
                    </div>
                  </>
                )}
                <div className="ml-auto text-[0.6875rem]" style={{ color: '#334155' }}>
                  Added {formatDate(lead.created_at)}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between px-5 py-4">
              <div className="h-5 w-40 rounded animate-pulse" style={{ background: 'rgba(255,255,255,0.06)' }} />
              <button onClick={closeDrawer} className="p-1.5 rounded-lg" style={{ color: '#475569' }}>
                <X size={16} />
              </button>
            </div>
          )}
        </div>

        {/* ── Scrollable body ── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#1e2130 transparent' }}>
          {loading && <DrawerSkeleton />}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 text-center px-5">
              <AlertTriangle size={28} style={{ color: '#f87171', opacity: 0.5 }} className="mb-3" />
              <p className="text-sm" style={{ color: '#64748b' }}>{error}</p>
              <button
                onClick={() => leadId && fetchLead(leadId)}
                className="mt-3 text-xs px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: '#38bdf8', border: '1px solid rgba(56,189,248,0.2)' }}
              >
                Retry
              </button>
            </div>
          )}

          {lead && !loading && (
            <>
              {/* ── Quick Actions ── */}
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <SectionHeader
                  label="Quick Actions"
                  icon={<Zap size={12} />}
                  collapsed={actionsCollapsed}
                  onToggle={() => setActionsCollapsed((v) => !v)}
                />

                {!actionsCollapsed && (
                  <div className="px-5 pb-4">
                    {confirmAction && (
                      <div
                        className="mb-3 px-3 py-2.5 rounded-xl flex items-center justify-between gap-3"
                        style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}
                      >
                        <p className="text-xs" style={{ color: '#fca5a5' }}>
                          Confirm: <span className="font-semibold">{confirmAction.label}?</span>
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => runAction(confirmAction)}
                            className="text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
                            style={{ background: 'rgba(248,113,113,0.2)', color: '#f87171' }}
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmAction(null)}
                            className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                            style={{ color: '#64748b' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {quickActions.map((action) => (
                        <button
                          key={action.label}
                          onClick={() => runAction(action)}
                          disabled={!!actionLoading}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-all duration-150 disabled:opacity-50"
                          style={{
                            color: action.accent,
                            background: actionLoading === action.label ? `${action.accent}20` : action.bg,
                            border: `1px solid ${action.accent}25`,
                          }}
                        >
                          {actionLoading === action.label ? (
                            <span className="w-3 h-3 rounded-full border border-current border-t-transparent animate-spin" />
                          ) : action.icon}
                          {action.label}
                        </button>
                      ))}
                    </div>

                    {/* Full status selector */}
                    <div className="mt-3">
                      <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#1e293b' }}>
                        Change Status
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {STATUS_OPTIONS.map((s) => {
                          const sm = STATUS_META[s]
                          const active = lead.status === s
                          return (
                            <button
                              key={s}
                              onClick={() => !active && changeStatus(s)}
                              className="px-2 py-0.5 rounded-full text-[0.625rem] font-medium transition-all duration-150"
                              style={{
                                color: active ? sm?.color : '#475569',
                                background: active ? sm?.bg : 'rgba(255,255,255,0.03)',
                                border: `1px solid ${active ? sm?.ring : 'rgba(255,255,255,0.06)'}`,
                                cursor: active ? 'default' : 'pointer',
                              }}
                            >
                              {sm?.label ?? s}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ── CRM Timeline + Notes ── */}
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <SectionHeader
                  label={`Activity Timeline${timeline.length > 0 ? ` · ${timeline.length}` : ''}`}
                  icon={<Activity size={12} />}
                  collapsed={timelineCollapsed}
                  onToggle={() => setTimelineCollapsed((v) => !v)}
                />

                {!timelineCollapsed && (
                  <div className="px-5 pb-5">
                    {/* Add note */}
                    <div
                      className="mb-4 p-3 rounded-xl"
                      style={{ background: '#161927', border: '1px solid rgba(255,255,255,0.05)' }}
                    >
                      <textarea
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Add a note to the timeline…"
                        rows={2}
                        className="w-full bg-transparent text-sm placeholder-gray-600 outline-none resize-none"
                        style={{ color: '#cbd5e1' }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote()
                        }}
                      />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[0.625rem]" style={{ color: '#1e293b' }}>⌘↵ to save</span>
                        <div className="flex items-center gap-2">
                          {noteAdded && (
                            <span className="text-xs flex items-center gap-1" style={{ color: '#4ade80' }}>
                              <CheckCircle2 size={11} /> Saved
                            </span>
                          )}
                          <button
                            onClick={addNote}
                            disabled={addingNote || !noteText.trim()}
                            className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg transition-all disabled:opacity-40"
                            style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}
                          >
                            {addingNote ? (
                              <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin" />
                            ) : <StickyNote size={11} />}
                            Add Note
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Timeline items */}
                    {timeline.length === 0 ? (
                      <p className="text-xs text-center py-4" style={{ color: '#334155' }}>
                        No activity yet
                      </p>
                    ) : (
                      <div className="relative">
                        {/* Vertical line */}
                        <div
                          className="absolute left-[11px] top-2 bottom-2 w-px"
                          style={{ background: 'rgba(255,255,255,0.05)' }}
                        />

                        <div className="space-y-0">
                          {timeline.map((item, i) => (
                            <div key={item.id} className="flex gap-3 relative" style={{ paddingBottom: i < timeline.length - 1 ? '14px' : '0' }}>
                              {/* Icon dot */}
                              <div
                                className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 relative z-10"
                                style={{ background: item.bgColor, border: `1px solid ${item.accent}30`, color: item.accent }}
                              >
                                {item.icon}
                              </div>

                              {/* Content */}
                              <div className="flex-1 min-w-0 pt-0.5">
                                {item.isNote ? (
                                  <div
                                    className="rounded-xl p-2.5"
                                    style={{ background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.1)' }}
                                  >
                                    <p className="text-[0.6875rem] font-semibold mb-1" style={{ color: '#fbbf24' }}>
                                      Note
                                    </p>
                                    <p className="text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
                                      {item.detail}
                                    </p>
                                    <p className="text-[0.625rem] mt-1.5 font-mono" style={{ color: '#334155' }}>
                                      {timeAgo(item.timestamp)}
                                    </p>
                                  </div>
                                ) : (
                                  <>
                                    <p className="text-[0.8125rem] font-semibold leading-snug" style={{ color: '#cbd5e1' }}>
                                      {item.label}
                                    </p>
                                    {item.detail && (
                                      <p className="text-xs mt-0.5 truncate" style={{ color: '#475569' }} title={item.detail}>
                                        {item.detail}
                                      </p>
                                    )}
                                    <p className="text-[0.625rem] mt-0.5 font-mono" style={{ color: '#334155' }}>
                                      {formatDateTime(item.timestamp)} · {timeAgo(item.timestamp)}
                                    </p>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Email History ── */}
              {lead.emails.length > 0 && (
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <SectionHeader
                    label={`Email History · ${lead.emails.length}`}
                    icon={<Mail size={12} />}
                    collapsed={emailsCollapsed}
                    onToggle={() => setEmailsCollapsed((v) => !v)}
                  />

                  {!emailsCollapsed && (
                    <div className="px-5 pb-4 space-y-2">
                      {[...lead.emails]
                        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                        .map((email) => {
                          const isExpanded = expandedEmailId === email.id
                          const hasReply = !!email.replied_at
                          return (
                            <div
                              key={email.id}
                              className="rounded-xl overflow-hidden"
                              style={{ background: '#161927', border: '1px solid rgba(255,255,255,0.05)' }}
                            >
                              <button
                                onClick={() => setExpandedEmailId(isExpanded ? null : email.id)}
                                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
                              >
                                <div
                                  className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                                  style={{
                                    background: hasReply ? 'rgba(74,222,128,0.1)' : 'rgba(56,189,248,0.1)',
                                    color: hasReply ? '#4ade80' : '#38bdf8',
                                  }}
                                >
                                  {hasReply ? <MessageSquare size={11} /> : <Send size={11} />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-semibold leading-snug truncate" style={{ color: '#cbd5e1' }}>
                                    {EMAIL_TYPE_LABELS[email.type] ?? email.type}
                                  </p>
                                  {email.subject && (
                                    <p className="text-[0.625rem] truncate" style={{ color: '#475569' }}>{email.subject}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  {hasReply && (
                                    <span
                                      className="text-[0.5625rem] font-bold px-1.5 py-0.5 rounded"
                                      style={{ background: 'rgba(74,222,128,0.1)', color: '#4ade80' }}
                                    >
                                      Replied
                                    </span>
                                  )}
                                  <span className="text-[0.625rem] font-mono" style={{ color: '#334155' }}>
                                    {email.sent_at ? timeAgo(email.sent_at) : '—'}
                                  </span>
                                  {isExpanded
                                    ? <EyeOff size={10} style={{ color: '#334155' }} />
                                    : <Eye size={10} style={{ color: '#334155' }} />}
                                </div>
                              </button>

                              {isExpanded && (
                                <div
                                  className="px-3 pb-3 pt-0 space-y-1.5 text-xs"
                                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)', color: '#475569' }}
                                >
                                  {email.sent_at && (
                                    <p className="pt-2"><span style={{ color: '#334155' }}>Sent:</span> {formatDateTime(email.sent_at)}</p>
                                  )}
                                  {email.replied_at && (
                                    <p><span style={{ color: '#4ade80' }}>Replied:</span> {formatDateTime(email.replied_at)}</p>
                                  )}
                                  {email.status && (
                                    <p><span style={{ color: '#334155' }}>Status:</span> <span style={{ color: '#64748b' }}>{email.status}</span></p>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Lead Details (editable) ── */}
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <SectionHeader
                  label="Lead Details"
                  icon={<Activity size={12} />}
                  collapsed={detailsCollapsed}
                  onToggle={() => setDetailsCollapsed((v) => !v)}
                />

                {!detailsCollapsed && (
                  <div className="px-5 pb-5 space-y-4">
                    {/* Edit email */}
                    <div>
                      <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#1e293b' }}>Email</p>
                      {editingEmail ? (
                        <div className="space-y-2">
                          <input
                            type="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveEmail(); if (e.key === 'Escape') setEditingEmail(false) }}
                            autoFocus
                            className="w-full px-3 py-1.5 rounded-lg text-sm outline-none"
                            style={{ background: '#0f1117', border: '1px solid #38bdf8', color: '#f1f5f9' }}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={saveEmail}
                              disabled={savingEmail}
                              className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg disabled:opacity-50"
                              style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}
                            >
                              <CheckCircle2 size={11} /> {savingEmail ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              onClick={() => setEditingEmail(false)}
                              className="text-xs px-2.5 py-1 rounded-lg"
                              style={{ color: '#64748b' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEmailInput(lead.email ?? ''); setEditingEmail(true) }}
                          className="flex items-center gap-1.5 text-xs group"
                          style={{ color: '#64748b' }}
                        >
                          <span style={{ color: '#94a3b8' }}>{lead.email ?? '—'}</span>
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[0.625rem] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: '#475569' }}>
                            Edit
                          </span>
                        </button>
                      )}
                    </div>

                    {/* Halal confidence */}
                    {lead.halal_confidence_score != null && (
                      <div>
                        <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-1.5" style={{ color: '#1e293b' }}>Halal Confidence</p>
                        <div className="flex items-center gap-2">
                          <div
                            className="flex-1 h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'rgba(255,255,255,0.06)' }}
                          >
                            <div
                              style={{
                                height: '100%',
                                width: `${lead.halal_confidence_score}%`,
                                background: lead.halal_confidence_score >= 80 ? '#4ade80'
                                  : lead.halal_confidence_score >= 40 ? '#fbbf24'
                                  : '#f87171',
                                borderRadius: '9999px',
                              }}
                            />
                          </div>
                          <span
                            className="text-xs font-bold"
                            style={{
                              color: lead.halal_confidence_score >= 80 ? '#4ade80'
                                : lead.halal_confidence_score >= 40 ? '#fbbf24'
                                : '#f87171',
                            }}
                          >
                            {lead.halal_confidence_score}%
                          </span>
                        </div>
                        {lead.halal_reasons && lead.halal_reasons.length > 0 && (
                          <p className="text-[0.6875rem] mt-1.5 leading-relaxed" style={{ color: '#475569' }}>
                            {lead.halal_reasons.slice(0, 3).join(' · ')}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Description */}
                    {lead.description && (
                      <div>
                        <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-1" style={{ color: '#1e293b' }}>Description</p>
                        <p className="text-xs leading-relaxed" style={{ color: '#64748b' }}>{lead.description}</p>
                      </div>
                    )}

                    {/* Deal section */}
                    {(lead.status === 'closed' || lead.status === 'closed_manual') && (
                      <div
                        className="rounded-xl p-3.5 space-y-3"
                        style={{ background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.12)' }}
                      >
                        <p className="text-[0.625rem] font-bold uppercase tracking-widest" style={{ color: '#34d399' }}>Deal</p>
                        {lead.deal_value && (
                          <div className="flex justify-between text-sm">
                            <span style={{ color: '#64748b' }}>Value</span>
                            <span className="font-bold" style={{ color: '#34d399' }}>${lead.deal_value.toLocaleString()}</span>
                          </div>
                        )}
                        {lead.deal_type && (
                          <div className="flex justify-between text-xs">
                            <span style={{ color: '#64748b' }}>Type</span>
                            <span style={{ color: '#94a3b8' }}>{lead.deal_type.replace(/_/g, ' ')}</span>
                          </div>
                        )}
                        <div className="flex gap-3">
                          <button
                            onClick={() => toggleField('content_created', !lead.content_created)}
                            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all"
                            style={{
                              background: lead.content_created ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.04)',
                              color: lead.content_created ? '#34d399' : '#475569',
                              border: `1px solid ${lead.content_created ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.06)'}`,
                            }}
                          >
                            <CheckCircle2 size={11} />
                            Content Created
                          </button>
                          <button
                            onClick={() => toggleField('payment_received', !lead.payment_received)}
                            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-all"
                            style={{
                              background: lead.payment_received ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.04)',
                              color: lead.payment_received ? '#34d399' : '#475569',
                              border: `1px solid ${lead.payment_received ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.06)'}`,
                            }}
                          >
                            <CheckCircle2 size={11} />
                            Payment Received
                          </button>
                        </div>
                      </div>
                    )}

                    {/* DM Queue */}
                    {lead.dm_queue.length > 0 && (
                      <div>
                        <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-2" style={{ color: '#1e293b' }}>DM Queue</p>
                        {lead.dm_queue.slice(0, 3).map((dm) => (
                          <div key={dm.id} className="flex items-center justify-between py-1.5 text-xs">
                            <span className="flex items-center gap-1.5" style={{ color: '#64748b' }}>
                              <AtSign size={10} style={{ color: '#ec4899' }} />
                              {dm.platform}
                            </span>
                            <div className="flex items-center gap-2">
                              <span
                                className="px-1.5 py-0.5 rounded text-[0.5625rem] font-bold"
                                style={{
                                  background: dm.status === 'sent' ? 'rgba(74,222,128,0.1)' : 'rgba(251,191,36,0.1)',
                                  color: dm.status === 'sent' ? '#4ade80' : '#fbbf24',
                                }}
                              >
                                {dm.status}
                              </span>
                              <span style={{ color: '#334155' }}>{dm.sent_at ? timeAgo(dm.sent_at) : timeAgo(dm.created_at)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Deals history */}
                    {lead.deals.length > 0 && (
                      <div>
                        <p className="text-[0.625rem] font-bold uppercase tracking-widest mb-2" style={{ color: '#1e293b' }}>Deals History</p>
                        {lead.deals.map((deal) => (
                          <div
                            key={deal.id}
                            className="flex items-center justify-between py-2 text-xs border-b"
                            style={{ borderColor: 'rgba(255,255,255,0.04)' }}
                          >
                            <div>
                              <span className="font-semibold" style={{ color: '#f1f5f9' }}>${deal.deal_value.toLocaleString()}</span>
                              <span className="ml-2" style={{ color: '#475569' }}>{deal.deal_type?.replace(/_/g, ' ')}</span>
                            </div>
                            <span style={{ color: '#334155' }}>{formatDate(deal.closed_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bottom padding */}
              <div className="h-6" />
            </>
          )}
        </div>
      </div>
    </>
  )
}
