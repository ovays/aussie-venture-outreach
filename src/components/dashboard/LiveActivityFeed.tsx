import { timeAgo } from '@/lib/utils'

interface ActivityEvent {
  id: string
  event_type: string
  description: string
  created_at: string
  lead_id: string | null
}

interface EventConfig {
  icon: string
  color: string
}

const EVENT_CONFIG: Record<string, EventConfig> = {
  reply_received:      { icon: '💬', color: '#4ade80' },
  email_sent:          { icon: '📧', color: '#38bdf8' },
  follow_up_1_sent:    { icon: '📬', color: '#a78bfa' },
  follow_up_2_sent:    { icon: '📬', color: '#c084fc' },
  follow_up_3_sent:    { icon: '📬', color: '#d8b4fe' },
  lead_found:          { icon: '🔍', color: '#60a5fa' },
  lead_researched:     { icon: '📋', color: '#a78bfa' },
  email_written:       { icon: '✍️', color: '#94a3b8' },
  lead_marked_dead:    { icon: '💀', color: '#475569' },
  deal_closed:         { icon: '✅', color: '#34d399' },
  email_bounced:       { icon: '↩️', color: '#fb923c' },
  email_failed:        { icon: '❌', color: '#f87171' },
  digest_sent:         { icon: '📰', color: '#94a3b8' },
  finder_complete:     { icon: '🔍', color: '#60a5fa' },
  researcher_complete: { icon: '📋', color: '#a78bfa' },
  writer_complete:     { icon: '✍️', color: '#94a3b8' },
  sender_complete:     { icon: '📧', color: '#38bdf8' },
  followup_complete:   { icon: '📬', color: '#a78bfa' },
}

const MAX_VISIBLE = 14

interface LiveActivityFeedProps {
  events: ActivityEvent[]
}

export function LiveActivityFeed({ events }: LiveActivityFeedProps) {
  const visible = events.slice(0, MAX_VISIBLE)

  if (visible.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-xs" style={{ color: '#334155' }}>
          No activity yet. Events will appear once the system runs.
        </p>
      </div>
    )
  }

  return (
    <div>
      {visible.map((event, index) => {
        const cfg = EVENT_CONFIG[event.event_type] ?? { icon: '📌', color: '#475569' }
        const isLast = index === visible.length - 1

        return (
          <div key={event.id} className="flex gap-3">
            {/* Timeline column */}
            <div className="flex flex-col items-center flex-shrink-0">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[0.6875rem] flex-shrink-0 relative z-10"
                style={{
                  background: `${cfg.color}15`,
                  border: `1px solid ${cfg.color}28`,
                  boxShadow: `0 0 8px ${cfg.color}18`,
                }}
              >
                {cfg.icon}
              </div>
              {!isLast && (
                <div
                  className="w-px flex-1 min-h-[18px]"
                  style={{ background: 'linear-gradient(to bottom, rgba(255,255,255,0.04) 0%, transparent 100%)' }}
                />
              )}
            </div>

            {/* Text column */}
            <div className="flex-1 min-w-0 pb-3.5">
              <p
                className="text-[0.75rem] leading-snug"
                style={{ color: '#94a3b8' }}
              >
                {event.description}
              </p>
              <span
                className="text-[0.625rem] mt-0.5 block font-mono tracking-wide"
                style={{ color: '#334155' }}
              >
                {timeAgo(event.created_at)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
