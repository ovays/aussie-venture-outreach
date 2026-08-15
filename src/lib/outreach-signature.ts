import { INITIAL_SIGN_OFF } from '@/lib/email-voice'

export const OUTREACH_SIGNATURE = {
  closing: 'Cheers,',
  name: 'Owais',
  organisation: 'Aussie Venture',
  email: 'hello@aussieventure.com',
  website: 'https://aussieventure.com',
  socialProfiles: [
    { label: 'Instagram', url: 'https://instagram.com/aussie.venture' },
    { label: 'TikTok', url: 'https://tiktok.com/@aussie.venture' },
    { label: 'Facebook', url: 'https://facebook.com/AussieVenture' },
    { label: 'Sydney Venture', url: 'https://facebook.com/Sydneyventure' },
  ],
} as const

export const OUTREACH_SHORT_SIGN_OFF = `${OUTREACH_SIGNATURE.closing}\n${OUTREACH_SIGNATURE.name}`

export const OUTREACH_SIGNATURE_TEXT = [
  OUTREACH_SIGNATURE.closing,
  OUTREACH_SIGNATURE.name,
  OUTREACH_SIGNATURE.organisation,
  '',
  OUTREACH_SIGNATURE.email,
  OUTREACH_SIGNATURE.website,
  ...OUTREACH_SIGNATURE.socialProfiles.map(({ label, url }) => `${label}: ${url}`),
].join('\n')

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function withoutTerminalLineBreaks(value: string): string {
  let end = value.length
  while (end > 0 && (value[end - 1] === '\n' || value[end - 1] === '\r')) end--
  return value.slice(0, end)
}

function hasExactTerminalBlock(value: string, suffix: string): boolean {
  if (!value.endsWith(suffix)) return false
  const start = value.length - suffix.length
  return start === 0 || value[start - 1] === '\n'
}

function canonicalSignatureSuffix(body: string): string | null {
  if (hasExactTerminalBlock(body, OUTREACH_SIGNATURE_TEXT)) return OUTREACH_SIGNATURE_TEXT
  const windowsSignature = OUTREACH_SIGNATURE_TEXT.replaceAll('\n', '\r\n')
  return hasExactTerminalBlock(body, windowsSignature) ? windowsSignature : null
}

function exactTerminalBlockSuffix(body: string, block: string): string | null {
  if (hasExactTerminalBlock(body, block)) return block
  const windowsBlock = block.replaceAll('\n', '\r\n')
  return hasExactTerminalBlock(body, windowsBlock) ? windowsBlock : null
}

export function replaceExactTerminalSignOff(body: string, current: string, replacement: string): string {
  const withoutTrailingBreaks = withoutTerminalLineBreaks(body)
  const currentWindows = current.replaceAll('\n', '\r\n')
  const suffix = hasExactTerminalBlock(withoutTrailingBreaks, current)
    ? current
    : hasExactTerminalBlock(withoutTrailingBreaks, currentWindows) ? currentWindows : null
  if (!suffix) return body
  return `${withoutTrailingBreaks.slice(0, -suffix.length)}${replacement}`
}

export function appendOutreachSignature(body: string): string {
  const withoutTrailingBreaks = withoutTerminalLineBreaks(body)
  if (canonicalSignatureSuffix(withoutTrailingBreaks)) {
    return withoutTrailingBreaks === body ? body : withoutTrailingBreaks
  }

  const replaceableSuffix = exactTerminalBlockSuffix(withoutTrailingBreaks, INITIAL_SIGN_OFF)
    ?? exactTerminalBlockSuffix(withoutTrailingBreaks, OUTREACH_SHORT_SIGN_OFF)
  const bodyWithoutSignOff = replaceableSuffix
    ? withoutTerminalLineBreaks(withoutTrailingBreaks.slice(0, -replaceableSuffix.length))
    : withoutTrailingBreaks

  return bodyWithoutSignOff
    ? `${bodyWithoutSignOff}\n\n${OUTREACH_SIGNATURE_TEXT}`
    : OUTREACH_SIGNATURE_TEXT
}

function renderBodyHtml(body: string): string {
  return body
    .split(/\r?\n\r?\n/)
    .map((paragraph) => `<p style="margin:0 0 18px;color:#374151;font-size:15px;line-height:1.75;">${paragraph.split(/\r?\n/).map(escapeHtml).join('<br>')}</p>`)
    .join('\n')
}

export function outreachSignatureHtml(): string {
  const linkStyle = 'color:#0ea5e9;text-decoration:none;'
  const email = escapeHtml(OUTREACH_SIGNATURE.email)
  const website = escapeHtml(OUTREACH_SIGNATURE.website)
  const socialLinks = OUTREACH_SIGNATURE.socialProfiles.map(({ label, url }) =>
    `<p style="margin:0 0 3px;font-size:13px;">${escapeHtml(label)}: <a href="${escapeHtml(url)}" style="${linkStyle}">${escapeHtml(url)}</a></p>`,
  ).join('\n  ')

  return `<div data-outreach-signature="aussie-venture" style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;">
  <p style="margin:0 0 2px;color:#374151;">${escapeHtml(OUTREACH_SIGNATURE.closing)}</p>
  <p style="margin:0 0 2px;font-weight:600;color:#111827;">${escapeHtml(OUTREACH_SIGNATURE.name)}</p>
  <p style="margin:0 0 12px;color:#374151;">${escapeHtml(OUTREACH_SIGNATURE.organisation)}</p>
  <p style="margin:0 0 3px;font-size:13px;"><a href="mailto:${email}" style="${linkStyle}">${email}</a></p>
  <p style="margin:0 0 8px;font-size:13px;"><a href="${website}" style="${linkStyle}">${website}</a></p>
  ${socialLinks}
</div>`
}

export function composeOutreachEmailBody(body: string): { bodyText: string; bodyHtml: string } {
  const bodyText = appendOutreachSignature(body)
  const signatureSuffix = canonicalSignatureSuffix(bodyText) ?? OUTREACH_SIGNATURE_TEXT
  const mainBody = bodyText.slice(0, -signatureSuffix.length).replace(/\r?\n\r?\n$/, '')
  return {
    bodyText,
    bodyHtml: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;">\n${renderBodyHtml(mainBody)}\n${outreachSignatureHtml()}\n</div>`,
  }
}
