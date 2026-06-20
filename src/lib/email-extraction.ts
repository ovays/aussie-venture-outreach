const MAILTO_RE = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const EMAIL_RE  = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const BLOCKED_LOCALS = new Set([
  'noreply', 'donotreply', 'no-reply', 'wordpress',
  'postmaster', 'webmaster', 'bounce', 'mailer',
])

export function isCleanEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0]
  if (BLOCKED_LOCALS.has(local)) return false
  if (local.length < 4) return false
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false
  if (email.toLowerCase().includes('@2x')) return false
  const hasVowel = /[aeiou]/.test(local)
  const hasSeparator = /[._]/.test(local)
  if (!hasVowel && !hasSeparator) return false
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false
  return true
}

export function extractMailtoEmail(html: string): string | null {
  // Always check mailto: links FIRST — avoids false positives from link text like "thello@..."
  const re = new RegExp(MAILTO_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (isCleanEmail(m[1])) return m[1]
  }
  const matches = html.match(EMAIL_RE) ?? []
  return matches.find(isCleanEmail) ?? null
}

export async function fetchRawHtml(url: string): Promise<string> {
  const normalised = url.startsWith('http') ? url : `https://${url}`
  const res = await fetch(normalised, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
    signal: AbortSignal.timeout(10_000),
  })
  return res.text()
}
