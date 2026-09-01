import type { SupabaseClient } from '@supabase/supabase-js'
import type { HostingerMessageMetadata, HostingerReportMailboxMessages } from '@/lib/hostinger-mail'
import { isAutomatedInboundEmail, normalizeInboundEmailAddress } from '../../agents/tracker'

export const EMAIL_REPORT_TIME_ZONE = 'Australia/Sydney'
export const EMAIL_REPORT_MAX_DAYS = 366
export const EMAIL_REPORT_PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.com.au',
  'icloud.com',
  'me.com',
  'msn.com',
  'proton.me',
  'protonmail.com',
])

const LEAD_QUERY_BATCH_SIZE = 40
const LEAD_QUERY_PAGE_SIZE = 1_000

export type EmailReportDirection = 'received' | 'sent'
export type EmailReportStatus = 'replied' | 'awaiting_reply' | 'sent_only'

export interface EmailReportDateRange {
  from: string
  to: string
  startInclusive: Date
  endExclusive: Date
}

export interface EmailReportLead {
  id: string
  business_name: string | null
  email: string | null
  status: string | null
}

export interface EmailReportRow {
  email: string
  email_addresses: string[]
  business_name: string | null
  lead_id: string | null
  reachagent_status: string
  received_count: number
  sent_count: number
  first_activity_at: string
  last_activity_at: string
  last_direction: EmailReportDirection
  email_status: EmailReportStatus
  matching_lead_count?: number
}

export interface EmailReportResponse {
  from: string
  to: string
  summary: {
    unique_contacts: number
    replied: number
    awaiting_reply: number
    sent_only: number
    reachagent_status_counts: Record<string, number>
  }
  rows: EmailReportRow[]
}

export class EmailReportValidationError extends Error {}

interface Activity {
  email: string
  direction: EmailReportDirection
  timestamp: number
  at: string
  uid: number
  path: string
  messageId: string
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}

export function emailReportGroupKey(email: string): string {
  const domain = emailDomain(email)
  return EMAIL_REPORT_PUBLIC_DOMAINS.has(domain) ? `email:${email}` : `domain:${domain}`
}

function parseCalendarDate(value: string | null, name: 'from' | 'to'): { year: number; month: number; day: number } {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new EmailReportValidationError(`${name} must use YYYY-MM-DD format`)
  }

  const [year, month, day] = value.split('-').map(Number)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new EmailReportValidationError(`${name} is not a valid calendar date`)
  }

  return { year, month, day }
}

function zonedMidnightUtc(year: number, month: number, day: number): Date {
  const desiredWallClock = Date.UTC(year, month - 1, day)
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: EMAIL_REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  let candidate = desiredWallClock

  // Iteration handles offset changes without assuming Sydney is always +10/+11.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    )
    const representedWallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const correction = desiredWallClock - representedWallClock
    candidate += correction
    if (correction === 0) break
  }

  return new Date(candidate)
}

function nextCalendarDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

export function parseEmailReportDateRange(from: string | null, to: string | null): EmailReportDateRange {
  const fromParts = parseCalendarDate(from, 'from')
  const toParts = parseCalendarDate(to, 'to')
  const fromDay = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day)
  const toDay = Date.UTC(toParts.year, toParts.month - 1, toParts.day)

  if (fromDay > toDay) throw new EmailReportValidationError('from must be on or before to')
  const inclusiveDays = Math.round((toDay - fromDay) / 86_400_000) + 1
  if (inclusiveDays > EMAIL_REPORT_MAX_DAYS) {
    throw new EmailReportValidationError(`Date range cannot exceed ${EMAIL_REPORT_MAX_DAYS} days`)
  }

  const afterTo = nextCalendarDay(toParts.year, toParts.month, toParts.day)
  return {
    from: from!,
    to: to!,
    startInclusive: zonedMidnightUtc(fromParts.year, fromParts.month, fromParts.day),
    endExclusive: zonedMidnightUtc(afterTo.year, afterTo.month, afterTo.day),
  }
}

export function normalizeEmailReportAddress(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = normalizeInboundEmailAddress(value)
  return normalized.includes('@') && !/\s/.test(normalized) ? normalized : null
}

function activityFromMessage(
  message: HostingerMessageMetadata,
  email: string,
  direction: EmailReportDirection,
): Activity | null {
  if (!message.date) return null
  const timestamp = Date.parse(message.date)
  if (!Number.isFinite(timestamp)) return null
  return {
    email,
    direction,
    timestamp,
    at: new Date(timestamp).toISOString(),
    uid: message.uid,
    path: message.path,
    messageId: message.messageId ?? '',
  }
}

function compareActivity(a: Activity, b: Activity): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  // UIDs are the provider's strongest metadata ordering key. Folder path,
  // Message-ID, then direction make exact timestamp/UID ties deterministic;
  // the final direction fallback treats our send as the later event.
  if (a.uid !== b.uid) return a.uid - b.uid
  const pathOrder = a.path.localeCompare(b.path)
  if (pathOrder !== 0) return pathOrder
  const messageOrder = a.messageId.localeCompare(b.messageId)
  if (messageOrder !== 0) return messageOrder
  return a.direction === b.direction ? 0 : a.direction === 'sent' ? 1 : -1
}

export function buildEmailReportActivityRows(
  mailbox: HostingerReportMailboxMessages,
): EmailReportRow[] {
  const ownAddress = normalizeEmailReportAddress(mailbox.mailboxAddress)
  const activities: Activity[] = []

  for (const message of mailbox.received) {
    const email = normalizeEmailReportAddress(message.from?.address)
    if (!email || email === ownAddress) continue
    if (isAutomatedInboundEmail({
      from: email,
      subject: message.subject ?? undefined,
      headers: null,
    })) continue
    const activity = activityFromMessage(message, email, 'received')
    if (activity) activities.push(activity)
  }

  for (const message of mailbox.sent) {
    const recipients = new Set(
      [...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])]
        .map((recipient) => normalizeEmailReportAddress(recipient.address))
        .filter((email): email is string => !!email && email !== ownAddress),
    )
    for (const email of recipients) {
      const activity = activityFromMessage(message, email, 'sent')
      if (activity) activities.push(activity)
    }
  }

  const grouped = new Map<string, Activity[]>()
  for (const activity of activities) {
    const key = emailReportGroupKey(activity.email)
    const group = grouped.get(key) ?? []
    group.push(activity)
    grouped.set(key, group)
  }

  return [...grouped.values()].map((group) => {
    group.sort(compareActivity)
    const emailAddresses = [...new Set(group.map((activity) => activity.email))].sort()
    const receivedCount = group.filter((activity) => activity.direction === 'received').length
    const sentCount = group.length - receivedCount
    const first = group[0]
    const last = group[group.length - 1]
    const emailStatus: EmailReportStatus = receivedCount === 0
      ? 'sent_only'
      : last.direction === 'sent' ? 'replied' : 'awaiting_reply'

    return {
      email: emailAddresses[0],
      email_addresses: emailAddresses,
      business_name: null,
      lead_id: null,
      reachagent_status: 'not_found',
      received_count: receivedCount,
      sent_count: sentCount,
      first_activity_at: first.at,
      last_activity_at: last.at,
      last_direction: last.direction,
      email_status: emailStatus,
    }
  })
}

function escapePostgrestLikeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&').replace(/"/g, '\\"')
}

export async function fetchEmailReportLeads(
  supabase: SupabaseClient,
  addresses: string[],
): Promise<EmailReportLead[]> {
  const uniqueAddresses = [...new Set(addresses.map(normalizeEmailReportAddress).filter((item): item is string => !!item))]
  const leads: EmailReportLead[] = []

  for (let batchStart = 0; batchStart < uniqueAddresses.length; batchStart += LEAD_QUERY_BATCH_SIZE) {
    const batch = uniqueAddresses.slice(batchStart, batchStart + LEAD_QUERY_BATCH_SIZE)
    const filter = batch.map((email) => `email.ilike."${escapePostgrestLikeLiteral(email)}"`).join(',')

    for (let pageStart = 0; ; pageStart += LEAD_QUERY_PAGE_SIZE) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, business_name, email, status')
        .or(filter)
        .range(pageStart, pageStart + LEAD_QUERY_PAGE_SIZE - 1)
      if (error) throw new Error(`Failed to match ReachAgent leads: ${error.message}`)

      const page = (data ?? []) as EmailReportLead[]
      leads.push(...page)
      if (page.length < LEAD_QUERY_PAGE_SIZE) break
    }
  }

  return leads
}

export function completeEmailReport(
  range: Pick<EmailReportDateRange, 'from' | 'to'>,
  activityRows: EmailReportRow[],
  leads: EmailReportLead[],
): EmailReportResponse {
  const leadsByEmail = new Map<string, EmailReportLead[]>()
  for (const lead of leads) {
    const email = normalizeEmailReportAddress(lead.email)
    if (!email) continue
    const matches = leadsByEmail.get(email) ?? []
    matches.push(lead)
    leadsByEmail.set(email, matches)
  }

  const rows = activityRows.map((row) => {
    const associatedAddresses = row.email_addresses?.length ? row.email_addresses : [row.email]
    const matches = associatedAddresses.flatMap((email) => leadsByEmail.get(email) ?? [])
    const uniqueMatches = [...new Map(matches.map((lead) => [lead.id, lead])).values()]
    if (uniqueMatches.length === 0) return { ...row, email_addresses: associatedAddresses }
    if (uniqueMatches.length > 1) {
      return {
        ...row,
        email_addresses: associatedAddresses,
        business_name: row.business_name,
        lead_id: null,
        reachagent_status: 'ambiguous',
        matching_lead_count: uniqueMatches.length,
      }
    }

    const lead = uniqueMatches[0]
    return {
      ...row,
      email_addresses: associatedAddresses,
      business_name: lead.business_name,
      lead_id: lead.id,
      reachagent_status: lead.status ?? 'unknown',
    }
  }).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.email.localeCompare(b.email))

  const reachagentStatusCounts: Record<string, number> = {}
  for (const row of rows) {
    reachagentStatusCounts[row.reachagent_status] = (reachagentStatusCounts[row.reachagent_status] ?? 0) + 1
  }

  return {
    from: range.from,
    to: range.to,
    summary: {
      unique_contacts: rows.length,
      replied: rows.filter((row) => row.email_status === 'replied').length,
      awaiting_reply: rows.filter((row) => row.email_status === 'awaiting_reply').length,
      sent_only: rows.filter((row) => row.email_status === 'sent_only').length,
      reachagent_status_counts: reachagentStatusCounts,
    },
    rows,
  }
}
