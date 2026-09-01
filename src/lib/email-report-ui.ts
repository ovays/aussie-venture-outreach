import type { EmailReportRow, EmailReportStatus } from '@/lib/email-report'

export const EMAIL_REPORT_DISPLAY_TIME_ZONE = 'Australia/Sydney'

export type EmailReportPreset = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month'

export interface EmailReportUiRange {
  from: string
  to: string
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function datePartsAtSydney(instant: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: EMAIL_REPORT_DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return { year: values.year, month: values.month, day: values.day }
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function shiftCalendarDate(value: string, days: number): string {
  const match = DATE_PATTERN.exec(value)
  if (!match) throw new Error('Invalid calendar date')
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return formatCalendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

export function getSydneyCalendarDate(instant: Date = new Date()): string {
  const { year, month, day } = datePartsAtSydney(instant)
  return formatCalendarDate(year, month, day)
}

export function getEmailReportPresetRange(
  preset: EmailReportPreset,
  instant: Date = new Date(),
): EmailReportUiRange {
  const today = getSydneyCalendarDate(instant)
  if (preset === 'today') return { from: today, to: today }
  if (preset === 'yesterday') {
    const yesterday = shiftCalendarDate(today, -1)
    return { from: yesterday, to: yesterday }
  }
  if (preset === 'last_7_days') return { from: shiftCalendarDate(today, -6), to: today }
  if (preset === 'this_month') return { from: `${today.slice(0, 8)}01`, to: today }
  return { from: shiftCalendarDate(today, -29), to: today }
}

function parseValidCalendarDate(value: string): number | null {
  const match = DATE_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ordinal = Date.UTC(year, month - 1, day)
  const check = new Date(ordinal)
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? ordinal
    : null
}

export function validateEmailReportUiRange(range: EmailReportUiRange): string | null {
  const from = parseValidCalendarDate(range.from)
  const to = parseValidCalendarDate(range.to)
  if (from === null || to === null) return 'Enter valid From and To dates.'
  if (from > to) return 'From date must be on or before To date.'
  const inclusiveDays = Math.round((to - from) / 86_400_000) + 1
  if (inclusiveDays > 366) return 'Date range cannot exceed 366 days.'
  return null
}

export function formatSydneyTimestamp(value: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: EMAIL_REPORT_DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(value))
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(values.month) - 1]
  return `${Number(values.day)} ${month} ${values.year}, ${values.hour}:${values.minute} ${values.dayPeriod.toLocaleLowerCase('en-AU')}`
}

export function emailStatusLabel(status: EmailReportStatus): string {
  return status === 'replied' ? 'Replied' : status === 'awaiting_reply' ? 'Awaiting Reply' : 'Sent Only'
}

export function reachAgentStatusLabel(status: string, matchingLeadCount?: number): string {
  if (status === 'not_found') return 'Not in ReachAgent'
  if (status === 'ambiguous') return `Multiple Leads${matchingLeadCount ? ` (${matchingLeadCount})` : ''}`
  return status
    .split('_')
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(' ')
}

export function filterEmailReportRows(
  rows: EmailReportRow[],
  search: string,
  emailStatus: string,
  reachagentStatus: string,
): EmailReportRow[] {
  const query = search.trim().toLocaleLowerCase('en-AU')
  return rows
    .filter((row) => !query
      || row.email.toLocaleLowerCase('en-AU').includes(query)
      || (row.business_name ?? '').toLocaleLowerCase('en-AU').includes(query))
    .filter((row) => !emailStatus || row.email_status === emailStatus)
    .filter((row) => !reachagentStatus || row.reachagent_status === reachagentStatus)
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.email.localeCompare(b.email))
}
