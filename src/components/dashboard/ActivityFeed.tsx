import { timeAgo } from '@/lib/utils'

interface ActivityEvent {
  id: string
  event_type: string
  description: string
  created_at: string
  lead_id: string | null
}

const EVENT_ICONS: Record<string, string> = {
  lead_found: '🔍',
  lead_researched: '📋',
  email_written: '✍️',
  email_sent: '📧',
  email_failed: '❌',
  email_bounced: '↩️',
  reply_received: '🔥',
  follow_up_1_sent: '📬',
  follow_up_2_sent: '📬',
  follow_up_3_sent: '📬',
  lead_marked_dead: '💀',
  deal_closed: '✅',
  digest_sent: '📰',
  finder_complete: '🔍',
  researcher_complete: '📋',
  writer_complete: '✍️',
  sender_complete: '📧',
  followup_complete: '📬',
}

interface ActivityFeedProps {
  events: ActivityEvent[]
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  if (!events.length) {
    return (
      <div className="py-8 text-center text-sm" style={{ color: '#64748b' }}>
        No activity yet. The system will log events here once running.
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-start gap-3 py-3 border-b"
          style={{ borderColor: '#2a2d3e' }}
        >
          <span className="text-base leading-none mt-0.5">
            {EVENT_ICONS[event.event_type] ?? '📌'}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm" style={{ color: '#e2e8f0' }}>{event.description}</p>
          </div>
          <span className="text-xs shrink-0" style={{ color: '#64748b' }}>
            {timeAgo(event.created_at)}
          </span>
        </div>
      ))}
    </div>
  )
}
