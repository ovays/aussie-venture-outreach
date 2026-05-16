import { timeAgo } from '@/lib/utils'

interface ActivityEvent {
  id: string
  event_type: string
  description: string
  created_at: string
  lead_id: string | null
}

const EVENT_META: Record<string, { icon: string; color: string }> = {
  lead_found:           { icon: '🔍', color: '#60a5fa' },
  lead_researched:      { icon: '📋', color: '#a78bfa' },
  email_written:        { icon: '✍️', color: '#94a3b8' },
  email_sent:           { icon: '📧', color: '#38bdf8' },
  email_failed:         { icon: '❌', color: '#f87171' },
  email_bounced:        { icon: '↩️', color: '#fb923c' },
  reply_received:       { icon: '🔥', color: '#4ade80' },
  follow_up_1_sent:     { icon: '📬', color: '#a78bfa' },
  follow_up_2_sent:     { icon: '📬', color: '#c084fc' },
  follow_up_3_sent:     { icon: '📬', color: '#d8b4fe' },
  lead_marked_dead:     { icon: '💀', color: '#6b7280' },
  deal_closed:          { icon: '✅', color: '#34d399' },
  digest_sent:          { icon: '📰', color: '#94a3b8' },
  finder_complete:      { icon: '🔍', color: '#60a5fa' },
  researcher_complete:  { icon: '📋', color: '#a78bfa' },
  writer_complete:      { icon: '✍️', color: '#94a3b8' },
  sender_complete:      { icon: '📧', color: '#38bdf8' },
  followup_complete:    { icon: '📬', color: '#a78bfa' },
}

interface ActivityFeedProps {
  events: ActivityEvent[]
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  if (!events.length) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm" style={{ color: '#475569' }}>No activity yet. Events will appear here once the system runs.</p>
      </div>
    )
  }

  return (
    <div className="space-y-0 -mx-1">
      {events.map((event) => {
        const meta = EVENT_META[event.event_type] ?? { icon: '📌', color: '#94a3b8' }
        return (
          <div
            key={event.id}
            className="flex items-start gap-3 px-1 py-2.5 rounded-lg hover:bg-white/3 transition-colors"
          >
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm mt-0.5"
              style={{ background: `${meta.color}15` }}
            >
              {meta.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug" style={{ color: '#cbd5e1' }}>{event.description}</p>
            </div>
            <span className="text-xs shrink-0 mt-0.5" style={{ color: '#475569' }}>
              {timeAgo(event.created_at)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
