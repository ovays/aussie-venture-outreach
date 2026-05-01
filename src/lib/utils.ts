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

const HTML_SIGNOFF = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;">
  <p style="margin:0 0 2px;color:#374151;">Cheers,</p>
  <p style="margin:0 0 2px;font-weight:600;color:#111827;">Owais</p>
  <p style="margin:0 0 12px;color:#374151;">Aussie Venture</p>
  <p style="margin:0 0 3px;font-size:13px;"><a href="mailto:hello@aussieventure.com" style="color:#0ea5e9;text-decoration:none;">hello@aussieventure.com</a></p>
  <p style="margin:0 0 8px;font-size:13px;"><a href="https://aussieventure.com" style="color:#0ea5e9;text-decoration:none;">aussieventure.com</a></p>
  <p style="margin:0;font-size:13px;color:#6b7280;">
    <a href="https://instagram.com/aussie.venture" style="color:#0ea5e9;text-decoration:none;">Instagram</a>&nbsp;&middot;&nbsp;<a href="https://tiktok.com/@aussie.venture" style="color:#0ea5e9;text-decoration:none;">TikTok</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/AussieVenture" style="color:#0ea5e9;text-decoration:none;">Facebook</a>&nbsp;&middot;&nbsp;<a href="https://facebook.com/Sydneyventure" style="color:#0ea5e9;text-decoration:none;">Sydney Venture</a>
  </p>
</div>`

export function emailBodyToHtml(plainText: string): string {
  const signoffIdx = plainText.indexOf('Cheers,')
  const bodyOnly = (signoffIdx >= 0 ? plainText.slice(0, signoffIdx) : plainText).trim()

  const paragraphs = bodyOnly
    .split(/\n\n+/)
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 18px;color:#374151;font-size:15px;line-height:1.75;">${p.trim()}</p>`)
    .join('\n')

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;">\n${paragraphs}\n${HTML_SIGNOFF}\n</div>`
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
    closed: 'bg-emerald-500/20 text-emerald-400',
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
    closed: 'Closed',
    dead: 'Dead',
  }
  return labels[status] ?? status
}
