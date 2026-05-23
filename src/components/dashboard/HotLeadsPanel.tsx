import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { timeAgo } from '@/lib/utils'

export interface HotLeadEmail {
  id: string
  type: string
  sent_at: string | null
  replied_at: string | null
  subject: string | null
}

export interface HotLead {
  id: string
  business_name: string
  city: string
  status: string
  notes: string | null
  created_at: string
  emails: HotLeadEmail[] | null
}

const STATUS_META: Record<string, { label: string; color: string; bg: string; ring: string }> = {
  replied:     { label: 'Replied',     color: '#4ade80', bg: 'rgba(74,222,128,0.1)',   ring: 'rgba(74,222,128,0.25)' },
  negotiating: { label: 'Negotiating', color: '#22d3ee', bg: 'rgba(34,211,238,0.1)',   ring: 'rgba(34,211,238,0.25)' },
  interested:  { label: 'Interested',  color: '#a78bfa', bg: 'rgba(167,139,250,0.1)',  ring: 'rgba(167,139,250,0.25)' },
  contacted:   { label: 'Contacted',   color: '#fb923c', bg: 'rgba(251,146,60,0.1)',   ring: 'rgba(251,146,60,0.25)' },
}

const EMAIL_TYPE_LABEL: Record<string, string> = {
  initial_pitch: 'Initial pitch sent',
  follow_up_1:   'Follow-up 1 sent',
  follow_up_2:   'Follow-up 2 sent',
  follow_up_3:   'Follow-up 3 sent',
}

function getInteraction(emails: HotLeadEmail[] | null): { label: string; time: string | null } {
  if (!emails || emails.length === 0) return { label: 'No emails sent', time: null }

  const withReply = emails
    .filter((e) => e.replied_at)
    .sort((a, b) => (b.replied_at ?? '').localeCompare(a.replied_at ?? ''))
  if (withReply.length > 0) return { label: 'Replied to pitch', time: withReply[0].replied_at }

  const bySent = [...emails].sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''))
  const latest = bySent[0]
  return { label: EMAIL_TYPE_LABEL[latest.type] ?? 'Email sent', time: latest.sent_at }
}

function getPreviewText(emails: HotLeadEmail[] | null, status: string): string {
  if (!emails || emails.length === 0) return 'No outreach yet'
  const withReply = emails.filter((e) => e.replied_at)
  if (withReply.length > 0 && withReply[0].subject) return withReply[0].subject
  const bySent = [...emails].sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''))
  if (bySent[0]?.subject) return bySent[0].subject
  if (status === 'negotiating') return 'Active negotiation underway'
  if (status === 'interested') return 'Expressed interest'
  return EMAIL_TYPE_LABEL[bySent[0]?.type] ?? 'Email sent'
}

const STATUS_PRIORITY = ['replied', 'negotiating', 'interested', 'contacted']

interface HotLeadsPanelProps {
  leads: HotLead[]
}

export function HotLeadsPanel({ leads }: HotLeadsPanelProps) {
  const sorted = [...leads].sort(
    (a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status)
  )

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <span className="text-3xl mb-3 opacity-40">🔥</span>
        <p className="text-sm font-medium" style={{ color: '#64748b' }}>No hot leads right now</p>
        <p className="text-xs mt-1" style={{ color: '#334155' }}>
          Replied, negotiating, and interested leads appear here
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
      {sorted.map((lead) => {
        const meta = STATUS_META[lead.status] ?? STATUS_META.contacted
        const interaction = getInteraction(lead.emails)
        const preview = getPreviewText(lead.emails, lead.status)

        return (
          <div
            key={lead.id}
            className="group flex items-center gap-3.5 py-3.5 px-3 transition-colors duration-150 hover:bg-white/[0.025] rounded-xl cursor-default"
          >
            {/* Status accent bar */}
            <div
              className="w-0.5 h-9 rounded-full flex-shrink-0 self-center"
              style={{ background: meta.color, opacity: 0.65 }}
            />

            {/* Status dot */}
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0 self-start mt-2"
              style={{ background: meta.color, boxShadow: `0 0 6px ${meta.color}` }}
            />

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold leading-none truncate" style={{ color: '#f1f5f9' }}>
                  {lead.business_name}
                </span>
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.6875rem] font-semibold flex-shrink-0 leading-none"
                  style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.ring}` }}
                >
                  {meta.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="text-xs truncate max-w-[200px] sm:max-w-xs"
                  style={{ color: '#475569' }}
                  title={preview}
                >
                  {preview}
                </span>
                {lead.city && (
                  <>
                    <span style={{ color: '#1e293b' }} className="flex-shrink-0">·</span>
                    <span className="text-xs flex-shrink-0" style={{ color: '#334155' }}>
                      {lead.city}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Right side: timestamp + CTA */}
            <div className="flex items-center gap-2.5 flex-shrink-0">
              {interaction.time && (
                <span className="text-xs hidden md:block font-mono" style={{ color: '#334155' }}>
                  {timeAgo(interaction.time)}
                </span>
              )}
              <Link
                href={`/dashboard/leads`}
                className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150"
                style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.ring}` }}
              >
                <ExternalLink size={10} strokeWidth={2.2} />
                <span>Open</span>
              </Link>
            </div>
          </div>
        )
      })}
    </div>
  )
}
