// Single source of truth for lead status definitions.
// ALL pages — Dashboard, Pipeline, Leads, Analytics — import from here.
// Do not duplicate these definitions elsewhere.

export const ALL_STATUSES = [
  'new', 'researched', 'email_ready',
  'contacted', 'replied', 'negotiating', 'interested',
  'closed', 'closed_won', 'closed_manual', 'dead',
] as const

export type LeadStatus = typeof ALL_STATUSES[number]

// Pre-contact statuses: leads not yet pitched
export const PRE_CONTACT_STATUSES: readonly LeadStatus[] = ['new', 'researched', 'email_ready']

// All statuses where an initial pitch was sent
export const PITCHED_STATUSES: readonly LeadStatus[] = [
  'contacted', 'replied', 'negotiating', 'interested',
  'closed', 'closed_won', 'closed_manual', 'dead',
]

// Positive-response statuses (used for reply-rate / engagement metrics)
export const POSITIVE_RESPONSE_STATUSES: readonly LeadStatus[] = [
  'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual',
]

// ─── Canonical pipeline stages ──────────────────────────────────────────────
// Each stage groups one or more raw database statuses.
// Dashboard cards, Pipeline Kanban, and Leads filters all use these groupings.
//
// Rule: negotiating includes "interested" (they're both active-deal stages)
//       closed includes closed_won and closed_manual (all closed-deal variants)

export const STAGE_STATUSES = {
  contacted:   ['contacted']                              as readonly LeadStatus[],
  replied:     ['replied']                               as readonly LeadStatus[],
  negotiating: ['negotiating', 'interested']             as readonly LeadStatus[],
  closed:      ['closed', 'closed_won', 'closed_manual'] as readonly LeadStatus[],
  dead:        ['dead']                                  as readonly LeadStatus[],
}

export type LeadStage = keyof typeof STAGE_STATUSES

// Ordered for funnel/pipeline display
export const STAGE_ORDER: readonly LeadStage[] = ['contacted', 'replied', 'negotiating', 'closed', 'dead']

// Visual metadata per stage (label, color, subtitle)
export const STAGE_META: Record<LeadStage, { label: string; color: string; sub: string }> = {
  contacted:   { label: 'Contacted',   color: '#fb923c', sub: 'Pitch sent'  },
  replied:     { label: 'Replied',     color: '#4ade80', sub: 'Responded'   },
  negotiating: { label: 'Negotiating', color: '#2dd4bf', sub: 'Active deal' },
  closed:      { label: 'Closed',      color: '#34d399', sub: 'Deal closed' },
  dead:        { label: 'Dead',        color: '#6b7280', sub: 'No response' },
}

// Human-readable labels for every raw status value
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new:           'New',
  researched:    'Researched',
  email_ready:   'Email Ready',
  contacted:     'Contacted',
  replied:       'Replied',
  negotiating:   'Negotiating',
  interested:    'Interested',
  closed:        'Closed',
  closed_won:    'Closed Won',
  closed_manual: 'Closed (Manual)',
  dead:          'Dead',
}

// Tailwind color classes for every raw status value (used by StatusBadge)
export const STATUS_COLORS: Record<LeadStatus, string> = {
  new:           'bg-blue-500/20 text-blue-400',
  researched:    'bg-purple-500/20 text-purple-400',
  email_ready:   'bg-yellow-500/20 text-yellow-400',
  contacted:     'bg-orange-500/20 text-orange-400',
  replied:       'bg-green-500/20 text-green-400',
  negotiating:   'bg-teal-500/20 text-teal-400',
  interested:    'bg-violet-500/20 text-violet-400',
  closed:        'bg-emerald-500/20 text-emerald-400',
  closed_won:    'bg-emerald-600/20 text-emerald-300',
  closed_manual: 'bg-orange-600/20 text-orange-300',
  dead:          'bg-gray-500/20 text-gray-400',
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Sum counts for a single stage from a raw statusMap
export function stageCount(stage: LeadStage, statusMap: Record<string, number>): number {
  return (STAGE_STATUSES[stage] as readonly string[]).reduce(
    (sum, s) => sum + (statusMap[s] ?? 0), 0,
  )
}

// Build all stage counts at once from a raw statusMap
export function buildStageCounts(statusMap: Record<string, number>): Record<LeadStage, number> {
  return Object.fromEntries(
    STAGE_ORDER.map((stage) => [stage, stageCount(stage, statusMap)]),
  ) as Record<LeadStage, number>
}

// Return the canonical stage for a raw status value (null = pre-contact)
export function rawStatusToStage(status: string): LeadStage | null {
  for (const [stage, statuses] of Object.entries(STAGE_STATUSES) as [LeadStage, readonly LeadStatus[]][]) {
    if ((statuses as readonly string[]).includes(status)) return stage
  }
  return null
}

// Build a Supabase .in() string for a stage: '("negotiating","interested")'
export function stageInFilter(stage: LeadStage): string {
  return `(${STAGE_STATUSES[stage].map((s) => `"${s}"`).join(',')})`
}
