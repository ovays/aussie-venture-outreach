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
    new: 'bg-[var(--info-muted)] text-[var(--info)]',
    researched: 'bg-[var(--ai-muted)] text-[var(--ai)]',
    email_ready: 'bg-[var(--warning-muted)] text-[var(--warning)]',
    contacted: 'bg-[var(--info-muted)] text-[var(--info)]',
    replied: 'bg-[var(--success-muted)] text-[var(--success)]',
    negotiating: 'bg-[var(--warning-muted)] text-[var(--warning)]',
    interested: 'bg-[var(--sand-muted)] text-[var(--sand)]',
    closed: 'bg-[var(--success-muted)] text-[var(--success)]',
    closed_won: 'bg-[var(--success-muted)] text-[var(--success)]',
    closed_manual: 'bg-[var(--success-muted)] text-[var(--success)]',
    awaiting_reply: 'bg-[var(--warning-muted)] text-[var(--warning)]',
    failed: 'bg-[var(--error-muted)] text-[var(--error)]',
    suppressed: 'bg-[var(--error-muted)] text-[var(--error)]',
    dead: 'bg-[var(--error-muted)] text-[var(--error)]',
  }
  return colors[status] ?? 'bg-white/5 text-[var(--text-secondary)]'
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
