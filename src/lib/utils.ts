import { composeOutreachEmailBody } from './outreach-signature'

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(date))
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date))
}

export function timeAgo(date: string | Date): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = now - then

  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function textToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('')
}

export function emailBodyToHtml(plainText: string): string {
  return composeOutreachEmailBody(plainText).bodyHtml
}

export function cleanBusinessName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .join('')
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
  }).format(amount)
}

export function statusColor(status: string): string {
  const colors: Record<string, string> = {
    new: 'bg-blue-500/20 text-blue-400',
    researched: 'bg-purple-500/20 text-purple-400',
    email_ready: 'bg-yellow-500/20 text-yellow-400',
    contacted: 'bg-orange-500/20 text-orange-400',
    replied: 'bg-green-500/20 text-green-400',
    negotiating: 'bg-teal-500/20 text-teal-400',
    interested: 'bg-violet-500/20 text-violet-400',
    closed: 'bg-emerald-500/20 text-emerald-400',
    closed_won: 'bg-emerald-600/20 text-emerald-300',
    closed_manual: 'bg-orange-600/20 text-orange-300',
    dead: 'bg-gray-500/20 text-gray-400',
  }
  return colors[status] ?? 'bg-gray-500/20 text-gray-400'
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    new: 'New',
    researched: 'Researched',
    email_ready: 'Email Ready',
    contacted: 'Contacted',
    replied: 'Replied',
    negotiating: 'Negotiating',
    interested: 'Interested',
    closed: 'Closed',
    closed_won: 'Closed Won',
    closed_manual: 'Closed (Manual)',
    dead: 'Dead',
  }
  return labels[status] ?? status
}
