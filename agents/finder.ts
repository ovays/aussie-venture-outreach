import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses, type OutscraperResult } from '@/lib/searchBusinesses'
import { logger } from '@/lib/logger'
import {
  addLeadToDedupeIndex,
  checkLeadDedupe,
  fetchPipelineDedupeIndex,
} from '@/lib/deduplication'
import {
  isHalalFilterCategory,
  scoreHalalQualification,
} from '@/lib/halalQualification'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
const INSTAGRAM_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{3,30})/i
const INSTAGRAM_SKIP = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'share', 'sharer'])

// Phase 1 — first 4 categories are capped at EMAIL_TARGET/4 each to ensure variety
// Remaining categories fill whatever quota is left
// {city} is replaced at runtime with the active suburb being searched
export type FinderEmailCategory = {
  id: string
  name: string
  queries: string[]
  capped: boolean
  batchSize: number
}

type FinderCategoryRow = {
  id: string
  name: string
  search_keywords: string[] | null
  status: string | null
}

// Finder categories are loaded from the categories table.
const CITY_STATE: Record<string, string> = {
  Sydney:    'NSW',
  Melbourne: 'VIC',
  Brisbane:  'QLD',
  Perth:     'WA',
  Adelaide:  'SA',
}

export async function loadFinderCategories(
  supabase: ReturnType<typeof createServiceClient>
): Promise<FinderEmailCategory[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, search_keywords, status')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .order('name')

  if (error) throw new Error(`Failed to load finder categories: ${error.message}`)

  return ((data ?? []) as FinderCategoryRow[])
    .map((category, index) => ({
      id: category.id,
      name: category.name,
      queries: category.search_keywords?.filter(Boolean) ?? [],
      capped: index < 4,
      batchSize: index < 2 ? 5 : 3,
    }))
    .filter((category) => category.queries.length > 0)
}

export async function loadFinderCategoryDebugSnapshot(
  supabase: ReturnType<typeof createServiceClient>
): Promise<{
  finderCategories: FinderEmailCategory[]
  disabledCategories: FinderCategoryRow[]
}> {
  const [finderCategories, disabledResult] = await Promise.all([
    loadFinderCategories(supabase),
    supabase
      .from('categories')
      .select('id, name, search_keywords, status')
      .neq('status', 'active')
      .order('name'),
  ])

  return {
    finderCategories,
    disabledCategories: (disabledResult.data ?? []) as FinderCategoryRow[],
  }
}

// ── Email filtering ──────────────────────────────────────────────────────────

const BLOCKED_LOCALS = new Set([
  'noreply', 'donotreply', 'no-reply', 'wordpress',
  'postmaster', 'webmaster', 'bounce', 'mailer',
])

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'getnada.com',
  'sharklasers.com',
])

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'yahoo.com.au',
])

const FAKE_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'domain.com', 'invalid', 'localhost'])
const INFRASTRUCTURE_EMAIL_DOMAINS = new Set(['sentry.io', 'wixpress.com', 'mailchimp.com', 'sendgrid.net'])

type EmailValidationResult = {
  valid: boolean
  reason?: string
}

function validateEmailCandidate(email: string): EmailValidationResult {
  const normalized = email.trim().toLowerCase()
  const exactEmailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
  if (!exactEmailRegex.test(normalized)) return { valid: false, reason: 'malformed email' }

  const [local, domain] = normalized.split('@')
  if (!local || !domain) return { valid: false, reason: 'malformed email' }
  if (BLOCKED_LOCALS.has(local)) return { valid: false, reason: 'automated/system inbox' }
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(normalized)) {
    return { valid: false, reason: 'asset filename detected' }
  }
  if (normalized.includes('@2x')) return { valid: false, reason: 'asset filename detected' }
  if (!domain.includes('.')) return { valid: false, reason: 'invalid domain' }
  if (domain.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) {
    return { valid: false, reason: 'invalid domain' }
  }
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return { valid: false, reason: 'disposable email' }
  if (FAKE_EMAIL_DOMAINS.has(domain)) return { valid: false, reason: 'clearly fake email' }
  if (INFRASTRUCTURE_EMAIL_DOMAINS.has(domain)) return { valid: false, reason: 'clearly fake email' }

  const placeholderLocals = new Set(['example', 'user', 'test', 'demo', 'sample'])
  if (placeholderLocals.has(local)) return { valid: false, reason: 'fake placeholder email' }
  if (/^[a-f0-9]{20,}$/.test(local)) return { valid: false, reason: 'obvious spam pattern' }

  return { valid: true }
}

function isValidEmail(email: string): boolean {
  return validateEmailCandidate(email).valid
}

function extractEmailsFromHtml(html: string): string[] {
  const emails = new Set<string>()
  // Always check mailto: links FIRST — highest confidence
  const mailtoRe = new RegExp(MAILTO_REGEX.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = mailtoRe.exec(html)) !== null) {
    if (isValidEmail(m[1])) emails.add(m[1].trim().toLowerCase())
  }
  // Only fall back to full-HTML regex if no mailto found
  const matches = html.match(EMAIL_REGEX) ?? []
  for (const match of matches) {
    const email = match.trim().toLowerCase()
    if (isValidEmail(email)) emails.add(email)
  }

  for (const email of extractCloudflareEmails(html)) {
    if (isValidEmail(email)) emails.add(email)
  }

  const deobfuscated = deobfuscateEmailText(html)
  const deobfuscatedMatches = deobfuscated.match(EMAIL_REGEX) ?? []
  for (const match of deobfuscatedMatches) {
    const email = match.trim().toLowerCase()
    if (isValidEmail(email)) emails.add(email)
  }

  const entityDecoded = decodeBasicHtmlEntities(html)
  const entityDecodedMatches = entityDecoded.match(EMAIL_REGEX) ?? []
  for (const match of entityDecodedMatches) {
    const email = match.trim().toLowerCase()
    if (isValidEmail(email)) emails.add(email)
  }

  return [...emails]
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&amp;/gi, '&')
}

function extractCloudflareEmails(html: string): string[] {
  const cfEmails = new Set<string>()
  const cfPatterns = [
    /data-cfemail=["']([a-f0-9]+)["']/gi,
    /\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi,
  ]

  for (const pattern of cfPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null) {
      const decoded = decodeCloudflareEmail(match[1])
      if (decoded) cfEmails.add(decoded.toLowerCase())
    }
  }

  return [...cfEmails]
}

function decodeCloudflareEmail(encoded: string): string | null {
  if (!encoded || encoded.length < 4 || encoded.length % 2 !== 0) return null
  const key = Number.parseInt(encoded.slice(0, 2), 16)
  if (Number.isNaN(key)) return null

  let email = ''
  for (let i = 2; i < encoded.length; i += 2) {
    const charCode = Number.parseInt(encoded.slice(i, i + 2), 16) ^ key
    if (Number.isNaN(charCode)) return null
    email += String.fromCharCode(charCode)
  }
  return email
}

function deobfuscateEmailText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\S)(?:\s*(?:\[at\]|\(at\))\s*|\s+at\s+)(\S)/gi, '$1@$2')
    .replace(/(\S)(?:\s*(?:\[dot\]|\(dot\))\s*|\s+dot\s+)(\S)/gi, '$1.$2')
    .replace(/\s+@\s+/g, '@')
    .replace(/\s+\.\s+/g, '.')
}

function emailSelectionRank(email: string): number {
  const [local, domain] = email.toLowerCase().split('@')
  const priorityLocals = ['bookings', 'reservations', 'catering', 'info', 'contact', 'hello']
  const exactLocalRank = priorityLocals.indexOf(local)
  if (exactLocalRank >= 0) return exactLocalRank

  const prefixRank = priorityLocals.findIndex((prefix) => local.startsWith(prefix))
  if (prefixRank >= 0) return prefixRank + 0.5

  return PERSONAL_EMAIL_DOMAINS.has(domain) ? 100 : 50
}

function selectBestEmail(emails: string[]): string | null {
  if (!emails.length) return null
  return [...emails].sort((a, b) => {
    const rankDiff = emailSelectionRank(a) - emailSelectionRank(b)
    return rankDiff !== 0 ? rankDiff : a.localeCompare(b)
  })[0]
}

type CrawlPage = {
  url: string
  label: string
  score: number
}

type LinkCandidate = {
  href: string
  text: string
}

const CONTACT_LINK_KEYWORDS = [
  'contact',
  'enquiry',
  'inquiry',
  'about',
  'team',
  'location',
]

const STATIC_ASSET_EXTENSIONS = [
  '.css',
  '.js',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.woff',
  '.woff2',
  '.ico',
  '.map',
  '.json',
  '.xml',
  '.txt',
  '.pdf',
  '.zip',
]

function rootHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

const SOCIAL_MEDIA_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'linkedin.com',
  'order.store',
  'uber.com',
  'square.site',
  'linktr.ee',
])

function isSocialMediaUrl(url: string): boolean {
  const host = rootHost(url)
  return host != null && SOCIAL_MEDIA_DOMAINS.has(host)
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeCrawlUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/+$/, '')
  }
}

function crawlOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

function crawlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return url
  }
}

function isCrawlableBusinessPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    if (STATIC_ASSET_EXTENSIONS.some((extension) => pathname.endsWith(extension))) return false
    if (/\/(?:api|assets?|static|_next|cdn-cgi|wp-content|wp-includes)\//i.test(pathname)) return false
    return true
  } catch {
    const lower = url.toLowerCase().split('?')[0]
    return !STATIC_ASSET_EXTENSIONS.some((extension) => lower.endsWith(extension))
  }
}

function scoreContactLink(url: string, text: string): number {
  const haystack = `${url} ${text}`.toLowerCase()
  let score = 0
  CONTACT_LINK_KEYWORDS.forEach((keyword, index) => {
    if (haystack.includes(keyword)) score += 100 - index
  })
  if (/mailto:|tel:|facebook\.com|instagram\.com|linktr\.ee|ubereats|doordash|menulog|order\.store|uber\.com|square\.site/i.test(url)) score -= 500
  if (!isCrawlableBusinessPageUrl(url)) score -= 500
  return score
}

function extractInternalLinkCandidates(html: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let anchorMatch: RegExpExecArray | null

  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const attrs = anchorMatch[1] ?? ''
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]?.trim()
    if (href) candidates.push({ href, text: stripHtml(anchorMatch[2] ?? '') })
  }

  const attrRe = /\b(?:href|data-href|data-url|data-link)\s*=\s*["']([^"']+)["']/gi
  let attrMatch: RegExpExecArray | null
  while ((attrMatch = attrRe.exec(html)) !== null) {
    candidates.push({ href: attrMatch[1].trim(), text: '' })
  }

  const onclickRe = /\bonclick\s*=\s*["'][^"']*(?:location\.href|window\.location|location\.assign)\s*\(?\s*['"]([^'"]+)['"]/gi
  let onclickMatch: RegExpExecArray | null
  while ((onclickMatch = onclickRe.exec(html)) !== null) {
    candidates.push({ href: onclickMatch[1].trim(), text: '' })
  }

  return candidates
}

function discoverLikelyBusinessPages(html: string, homepageUrl: string): CrawlPage[] {
  const homeHost = rootHost(homepageUrl)
  if (!homeHost) return []

  const pages = new Map<string, CrawlPage>()
  for (const candidate of extractInternalLinkCandidates(html)) {
    const href = candidate.href
    if (!href || href.startsWith('#') || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
      continue
    }

    let absoluteUrl: string
    try {
      absoluteUrl = normalizeCrawlUrl(new URL(href, homepageUrl).toString())
    } catch {
      continue
    }

    if (rootHost(absoluteUrl) !== homeHost) continue
    if (!isCrawlableBusinessPageUrl(absoluteUrl)) continue

    const label = candidate.text || new URL(absoluteUrl).pathname || absoluteUrl
    const score = scoreContactLink(absoluteUrl, label)
    if (score <= 0) continue

    const existing = pages.get(absoluteUrl)
    if (!existing || score > existing.score) {
      pages.set(absoluteUrl, { url: absoluteUrl, label, score })
    }
  }

  return [...pages.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, 10)
}

// ── Website fetching ─────────────────────────────────────────────────────────

type WebsiteFetchResult = {
  html: string
  requestedUrl: string
  finalUrl: string
  reason?: string
}

function decodeWebsite(rawWebsite: string): string {
  try {
    return decodeURIComponent(rawWebsite.trim())
  } catch {
    return rawWebsite.trim()
  }
}

function buildWebsiteUrlCandidates(rawWebsite: string): string[] {
  const decoded = decodeWebsite(rawWebsite).replace(/\/+$/, '')
  if (!decoded) return []

  const withProtocol = /^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`
  const candidates = new Set<string>()

  try {
    const parsed = new URL(withProtocol)
    const host = parsed.hostname.replace(/^www\./i, '')
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '')
    candidates.add(`https://${host}${path}`)
    candidates.add(`https://www.${host}${path}`)
    candidates.add(`http://${host}${path}`)
    candidates.add(`http://www.${host}${path}`)
  } catch {
    candidates.add(withProtocol)
    if (!/^https?:\/\/www\./i.test(withProtocol)) {
      candidates.add(withProtocol.replace(/^https?:\/\//i, 'https://www.'))
    }
  }

  return [...candidates]
}

function normalizeResolvedWebsite(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/+$/, '')
  }
}

async function fetchHtmlWithDiagnostics(url: string): Promise<WebsiteFetchResult> {
  const candidates = buildWebsiteUrlCandidates(url)
  let lastReason = 'no URL candidates'

  for (const candidate of candidates) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 7000)
    try {
      const res = await fetch(candidate, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
        redirect: 'follow',
        signal: controller.signal,
      })

      if (!res.ok) {
        clearTimeout(timeoutId)
        lastReason = `${candidate} returned HTTP ${res.status}`
        continue
      }

      const html = await res.text()
      clearTimeout(timeoutId)
      return {
        html,
        requestedUrl: normalizeResolvedWebsite(candidate),
        finalUrl: normalizeResolvedWebsite(res.url || candidate),
      }
    } catch (error) {
      clearTimeout(timeoutId)
      lastReason = `${candidate} failed: ${error instanceof Error ? error.name || error.message : String(error)}`
    }
  }

  const fallbackUrl = candidates[0] ?? url
  return {
    html: '',
    requestedUrl: normalizeResolvedWebsite(fallbackUrl),
    finalUrl: normalizeResolvedWebsite(fallbackUrl),
    reason: lastReason,
  }
}

export async function findEmailForBusiness(rawWebsite: string, businessName: string, deadline?: number): Promise<{
  email: string | null
  source: string
  websiteText: string
  normalizedWebsite: string | null
  failureReason: string | null
}> {
  const decoded = decodeWebsite(rawWebsite)

  let websiteText = ''
  let homepageHtml = ''

  let normalizedWebsite: string | null = null
  let failureReason: string | null = null

  const emailsFound = new Set<string>()
  const sourceByEmail = new Map<string, string>()

  const scanPage = async (
    page: CrawlPage,
    logName: 'Homepage scanned' | 'Contact page scanned'
  ): Promise<string | null> => {
    const scanMessage =
      logName === 'Homepage scanned'
        ? `Scanning homepage: ${page.url}`
        : `Scanning page: ${page.url}`

    console.log(scanMessage)

    logger.info('finder', scanMessage, {
      business_name: businessName,
      page: page.label,
      url: page.url,
    })

    const fetchResult = await fetchHtmlWithDiagnostics(page.url)

    if (fetchResult.finalUrl) {
      normalizedWebsite = fetchResult.finalUrl
    }

    if (fetchResult.reason) {
      failureReason = fetchResult.reason
    }

    const html = fetchResult.html

    if (!html) {
      return null
    }

    if (page.label === 'homepage') {
      homepageHtml = html
    }

    websiteText += `\n${stripHtml(html).slice(0, 3000)}`

    const pageEmails = extractEmailsFromHtml(html)

    for (const email of pageEmails) {
      emailsFound.add(email)

      if (!sourceByEmail.has(email)) {
        sourceByEmail.set(email, page.label)
      }
    }

    const selectedEmail = selectBestEmail([...emailsFound])

    if (selectedEmail) {
      console.log(`Email found: ${selectedEmail}`)
      return selectedEmail
    }

    return null
  }

  const homepage: CrawlPage = {
    url: decoded,
    label: 'homepage',
    score: 999,
  }

  const homepageEmail = await scanPage(
    homepage,
    'Homepage scanned'
  )

  if (homepageEmail) {
    return {
      email: homepageEmail,
      source: sourceByEmail.get(homepageEmail) ?? 'homepage',
      websiteText,
      normalizedWebsite,
      failureReason: null,
    }
  }

  if (isSocialMediaUrl(decoded)) {
    const socialDomain = rootHost(decoded) ?? decoded
    logger.info('finder', `SOCIAL_DOMAIN_SKIP_INTERNAL_CRAWL = ${socialDomain}`, {
      business_name: businessName,
      domain:        socialDomain,
      url:           decoded,
    })
    return {
      email:             null,
      source:            '',
      websiteText,
      normalizedWebsite,
      failureReason:     `social media domain — internal crawl skipped (${socialDomain})`,
    }
  }

  const homepageCandidates =
    buildWebsiteUrlCandidates(decoded)

  const homepageUrl =
    normalizedWebsite ??
    normalizeResolvedWebsite(
      homepageCandidates[0] ?? decoded
    )

  const origin =
    crawlOrigin(homepageUrl) ??
    crawlOrigin(homepageCandidates[0] ?? '')

  const discoveredPages =
    discoverLikelyBusinessPages(
      homepageHtml,
      homepageUrl
    )

  const fixedPathPages = [
    { path: '/contact',    label: '/contact',    score: 100 },
    { path: '/contact-us', label: '/contact-us', score: 99 },
    { path: '/about',      label: '/about',      score: 50 },
    { path: '/about-us',   label: '/about-us',   score: 49 },
  ]

  const fixedPages: CrawlPage[] = origin
    ? fixedPathPages.map((page) => ({
        url: normalizeCrawlUrl(
          new URL(page.path, origin).toString()
        ),
        label: page.label,
        score: page.score,
      }))
    : []

  const candidatePages = new Map<string, CrawlPage>()

  for (const page of [...discoveredPages, ...fixedPages]) {
    const normalizedUrl = normalizeCrawlUrl(page.url)

    if (
      normalizedUrl === normalizeCrawlUrl(homepageUrl)
    ) {
      continue
    }

    if (
      origin &&
      rootHost(normalizedUrl) !== rootHost(origin)
    ) {
      continue
    }

    if (!isCrawlableBusinessPageUrl(normalizedUrl)) {
      continue
    }

    const existing = candidatePages.get(normalizedUrl)

    if (!existing || page.score > existing.score) {
      candidatePages.set(normalizedUrl, {
        ...page,
        url: normalizedUrl,
      })
    }
  }

  const crawlPages = [...candidatePages.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.url.localeCompare(b.url)
    )
    .slice(0, 4)

  console.log('Discovered internal links:')

  for (const page of crawlPages) {
    console.log(`* ${crawlPath(page.url)}`)
  }

  for (const page of crawlPages) {
    if (deadline != null && Date.now() >= deadline) {
      logger.info('finder', `CRAWL_DEADLINE_REACHED = ${businessName} — skipping remaining pages`)
      break
    }

    console.log(`Scanning page: ${page.url}`)

    const selectedEmail = await scanPage(
      page,
      'Contact page scanned'
    )

    if (selectedEmail) {
      return {
        email: selectedEmail,
        source:
          sourceByEmail.get(selectedEmail) ??
          page.label,
        websiteText,
        normalizedWebsite,
        failureReason: null,
      }
    }
  }

  return {
    email: null,
    source: '',
    websiteText,
    normalizedWebsite,
    failureReason,
  }
}

// ── Irrelevant business filter ───────────────────────────────────────────────

const IRRELEVANT_KEYWORDS = [
  'migrate', 'migration', 'migrant', 'visa', 'immigration', 'education', 'university',
  'college', 'school', 'tafe', 'accounting', 'tax', 'legal', 'lawyer',
  'solicitor', 'dentist', 'doctor', 'medical', 'pharmacy', 'clinic',
  'real estate', 'mortgage', 'insurance', 'finance', 'funeral',
]

function isIrrelevant(name: string): boolean {
  const lower = name.toLowerCase()
  return IRRELEVANT_KEYWORDS.some((kw) => lower.includes(kw))
}

function buildNormalizedSearchQuery(keyword: string, suburb: string, city: string, state: string): string {
  const cleanSuburb = normalizeLocationPart(suburb, city, state)
  const cleanCity = normalizeLocationPart(city, '', state)
  const cleanState = normalizeLocationPart(state, '', '')
  let categoryPart = keyword
    .replace(/\{suburb\}/gi, ' ')
    .replace(/\{city\}/gi, ' ')
    .replace(/\bnear me\b/gi, ' ')
    .replace(/\bservices?\b/gi, ' ')
    .replace(/\bbest\s+in\b/gi, ' ')
    .replace(/\bbest\b/gi, ' ')
    .replace(/\blocal business\b/gi, ' ')
    .replace(/\bin\s+sydney\b/gi, ' ')
    .replace(/\bsydney\b/gi, ' ')
    .replace(/\bnsw\b/gi, ' ')
    .replace(/\baustralia\b/gi, ' ')

  if (cleanSuburb) {
    categoryPart = categoryPart.replace(new RegExp(`\\b${escapeRegExp(cleanSuburb)}\\b`, 'gi'), ' ')
  }

  categoryPart = categoryPart.replace(/\s+/g, ' ').trim()

  const terms = [
    categoryPart,
    cleanSuburb,
    cleanCity,
    cleanState,
    'Australia',
  ].filter(Boolean)

  return dedupeQueryTokens(terms.join(' '))
}

function normalizeLocationPart(value: string, city: string, state: string): string {
  let normalized = value
  if (city) normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(city)}\\b`, 'gi'), ' ')
  if (state) normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(state)}\\b`, 'gi'), ' ')
  return normalized.replace(/\baustralia\b/gi, ' ').replace(/\s+/g, ' ').trim()
}

function dedupeQueryTokens(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean)
  const deduped: string[] = []
  const seenGeo = new Set<string>()
  const seenAll = new Set<string>()

  const geoTokens = new Set(['sydney', 'nsw', 'australia'])

  for (const token of tokens) {
    const normalized = token.toLowerCase()
    if (geoTokens.has(normalized)) {
      if (seenGeo.has(normalized)) continue
      seenGeo.add(normalized)
      deduped.push(token)
      continue
    }

    if (seenAll.has(normalized)) continue
    seenAll.add(normalized)
    deduped.push(token)
  }

  return deduped.join(' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Business email quality filter ────────────────────────────────────────────

function validateBusinessEmail(email: string, businessName: string): EmailValidationResult {
  void businessName // restaurant outreach accepts generic inboxes and common personal providers
  return validateEmailCandidate(email)
}

// ── DB dedup ─────────────────────────────────────────────────────────────────

async function isAlreadyInDB(
  supabase: ReturnType<typeof createServiceClient>,
  name: string,
  city: string,
  phone?: string
): Promise<boolean> {
  const conditions: string[] = [`and(business_name.eq.${name},city.eq.${city})`]
  if (phone) conditions.push(`phone.eq.${phone}`)
  const { data } = await supabase
    .from('leads')
    .select('id')
    .or(conditions.join(','))
    .limit(1)
  return !!data?.length
}

// ── Daily spend helper ───────────────────────────────────────────────────────

async function getDailyOutscraperSpend(supabase: ReturnType<typeof createServiceClient>): Promise<number> {
  // Compute midnight Sydney time as a UTC timestamp.
  // The server (Trigger.dev) runs in UTC — using toISOString().slice(0,10) gives the UTC
  // date which can be yesterday in Sydney (UTC+10/+11), causing false "already spent" reads.
  const now = new Date()
  const sydneyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(now)
  // Dynamic offset handles both AEST (+10) and AEDT (+11)
  const offsetMs =
    new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' })).getTime() -
    new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  // Midnight Sydney expressed as UTC: take midnight of the Sydney date string (as UTC) then subtract the offset
  const todayStart = new Date(new Date(`${sydneyDate}T00:00:00Z`).getTime() - offsetMs)

  const { data } = await supabase
    .from('activity_log')
    .select('metadata')
    .eq('event_type', 'finder_complete')
    .gte('created_at', todayStart.toISOString())

  return (data ?? []).reduce((sum, row) => {
    const meta = row.metadata as { estimated_cost?: string | number } | null
    const cost = typeof meta?.estimated_cost === 'string'
      ? parseFloat(meta.estimated_cost)
      : typeof meta?.estimated_cost === 'number'
        ? meta.estimated_cost
        : 0
    return sum + (isNaN(cost) ? 0 : cost)
  }, 0)
}

// ── DM Queue cleanup ─────────────────────────────────────────────────────────

async function cleanupDmQueue(supabase: ReturnType<typeof createServiceClient>): Promise<void> {
  logger.info('finder', 'Cleaning up DM queue entries')

  const { error: fbErr } = await supabase.from('dm_queue').delete().eq('platform', 'facebook')
  if (fbErr) logger.error('finder', 'DM cleanup Facebook delete error', { error: fbErr.message })

  const invalidValues = ['Not found', 'Not mentioned', 'N/A', 'None', 'null', 'Unknown']
  for (const val of invalidValues) {
    await supabase.from('dm_queue').delete().eq('handle', val)
  }

  // Remove duplicate lead entries — keep oldest per lead_id
  const { data: allDms } = await supabase
    .from('dm_queue')
    .select('id, lead_id, created_at')
    .order('created_at', { ascending: true })

  if (allDms?.length) {
    const seenLeadIds = new Map<string, string>()
    const toDelete: string[] = []
    for (const dm of allDms) {
      if (seenLeadIds.has(dm.lead_id)) {
        toDelete.push(dm.id)
      } else {
        seenLeadIds.set(dm.lead_id, dm.id)
      }
    }
    if (toDelete.length) {
      logger.info('finder', `Removing ${toDelete.length} duplicate DM queue entries`)
      await supabase.from('dm_queue').delete().in('id', toDelete)
    } else {
      logger.info('finder', 'DM queue clean — no duplicates')
    }
  }
}

// ── Main agent ───────────────────────────────────────────────────────────────

export async function runFinderAgent(): Promise<number> {
  const supabase = createServiceClient()

  try {
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    logger.info('finder', 'System paused - skipped')
    return 0
  }

  const [emailLimitRow, dmLimitRow, totalLimitRow, dailyOutscraperLimitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_email_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_dm_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_outscraper_limit').single(),
  ])

  const DAILY_EMAIL_LIMIT      = parseInt(emailLimitRow.data?.value ?? '30', 10)
  const DAILY_DM_LIMIT         = parseInt(dmLimitRow.data?.value   ?? '10', 10)
  const TOTAL_TARGET           = parseInt(totalLimitRow.data?.value ?? '40', 10)
  const EMAIL_TARGET           = Math.min(DAILY_EMAIL_LIMIT, TOTAL_TARGET)
  const DM_TARGET              = Math.min(DAILY_DM_LIMIT, Math.max(0, TOTAL_TARGET - EMAIL_TARGET))
  const DAILY_OUTSCRAPER_LIMIT = parseFloat(dailyOutscraperLimitRow.data?.value ?? '1.00')

  logger.info('finder', 'Targets', { emailTarget: EMAIL_TARGET, dmTarget: DM_TARGET, totalTarget: TOTAL_TARGET })
  logger.info('finder', '[NEW_OUTREACH_ALLOCATION]', {
    daily_lead_limit: TOTAL_TARGET,
    email_allocation: EMAIL_TARGET,
    dm_allocation: DM_TARGET,
    configured_daily_email_limit: DAILY_EMAIL_LIMIT,
    configured_daily_dm_limit: DAILY_DM_LIMIT,
  })
  logger.info('finder', `Daily cost limit: $${DAILY_OUTSCRAPER_LIMIT}`)

  const categoryDebug = await loadFinderCategoryDebugSnapshot(supabase)
  const finderCategories = categoryDebug.finderCategories
  const activeFinderCategoryNames = finderCategories.map((category) => category.name)
  logger.info('finder', '[DEBUG_CATEGORY_FILTER] ACTIVE FINDER CATEGORIES FROM DB', {
    categories: finderCategories.map((category) => ({
      name: category.name,
      queries: category.queries,
      capped: category.capped,
      batchSize: category.batchSize,
    })),
  })
  logger.info('finder', '[DEBUG_CATEGORY_FILTER] Admin disabled categories', {
    categories: categoryDebug.disabledCategories.map((category) => ({
      name: category.name,
      status: category.status,
    })),
  })

  const activeCategoryCount = finderCategories.length > 0 ? finderCategories.length : 1
  const cappedLimit         = EMAIL_TARGET > 0 ? Math.max(1, Math.ceil(EMAIL_TARGET / activeCategoryCount)) : 0

  logger.info('finder', `ACTIVE_CATEGORY_COUNT = ${activeCategoryCount}`)
  logger.info('finder', `CATEGORY_CAP_VALUE = ${cappedLimit}`)
  logger.info('finder', `GLOBAL_EMAIL_TARGET = ${EMAIL_TARGET}`)

  // FIX 1: read active_cities from settings — source of truth for which cities to search
  const { data: activeCitySetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'active_cities')
    .single()

  const activeCities: string[] = activeCitySetting?.value
    .split(',')
    .map((c: string) => c.trim())
    .filter(Boolean) ?? ['Sydney']

  logger.info('finder', 'Active cities', { cities: activeCities })

  // Load active suburbs for active cities only — both filters must be satisfied
  const { data: suburbData } = await supabase
    .from('city_suburbs')
    .select('city, suburb')
    .eq('active', true)
    .in('city', activeCities)
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .order('city')
    .order('suburb')

  // Use a Set per city so duplicate DB rows never produce duplicate suburbs
  const cityAreaSets: Record<string, Set<string>> = {}
  for (const row of suburbData ?? []) {
    if (!cityAreaSets[row.city]) cityAreaSets[row.city] = new Set()
    cityAreaSets[row.city].add(row.suburb)
  }
  const cityAreas: Record<string, string[]> = Object.fromEntries(
    Object.entries(cityAreaSets).map(([city, set]) => [city, [...set]])
  )
  // If a city is active but has no configured suburbs, search the city name itself
  for (const city of activeCities) {
    if (!cityAreas[city]?.length) cityAreas[city] = [city]
  }

  logger.info('finder', `Suburbs loaded: ${Object.values(cityAreas).flat().length} active suburbs`)

  // Load exhausted queries (cleanup expired first)
  await supabase.from('exhausted_queries').delete().lt('expires_at', new Date().toISOString())
  const { data: exhaustedData } = await supabase
    .from('exhausted_queries')
    .select('query')
    .gt('expires_at', new Date().toISOString())
  const exhaustedSet = new Set((exhaustedData ?? []).map((r) => r.query))
  logger.info('finder', `Exhausted queries cached: ${exhaustedSet.size}`)

  // Today's prior Outscraper spend
  const spentToday = await getDailyOutscraperSpend(supabase)
  logger.info('finder', `Prior spend today: $${spentToday.toFixed(4)}`)

  const dedupeIndex = await fetchPipelineDedupeIndex(supabase)
  logger.info('finder', '[DEBUG_DEDUPLICATION] Pipeline dedupe index loaded', {
    emails: dedupeIndex.byEmail.size,
    root_domains: dedupeIndex.byRootDomain.size,
  })

  const seenQueries = new Set<string>()
  let costGuardHit = false

  let emailCount               = 0
  let dmCount                  = 0
  let callCount                = 0
  let totalResultsFetched      = 0
  let outscraperResultsFetched = 0
  let halalConfidenceRecorded  = 0
  let duplicatesRemoved        = 0
  let invalidEmailsRemoved     = 0
  let noOutreachMethodsRemoved = 0
  let qualifiedCandidates      = 0

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1 — EMAIL LEADS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Safety limits: prevent runaway searching when leads are scarce
const MAX_BUSINESSES_PROCESSED = 1200
const MAX_QUERIES_EXECUTED = 300
const MAX_RUNTIME_MS = 45 * 60 * 1000
  const runStartTime             = Date.now()
  let businessesProcessed = 0
  let safetyLimitHit      = false
  let safetyLimitReason   = ''

  logger.info('finder', `DAILY_EMAIL_TARGET = ${EMAIL_TARGET}`, {
    email_target:      EMAIL_TARGET,
    daily_email_limit: DAILY_EMAIL_LIMIT,
    total_target:      TOTAL_TARGET,
  })
  logger.info('finder', `PER_CATEGORY_CAP = ${cappedLimit}`, {
    per_category_cap:    cappedLimit,
    formula:             `ceil(${EMAIL_TARGET} / ${activeCategoryCount}) = ${cappedLimit}`,
    capped_categories:   finderCategories.filter((c) => c.capped).length,
    uncapped_categories: finderCategories.filter((c) => !c.capped).length,
  })
  logger.info('finder', `CURRENT_SUCCESSFUL_LEADS = 0 / ${EMAIL_TARGET}`, {
    email_count:  0,
    email_target: EMAIL_TARGET,
    remaining:    EMAIL_TARGET,
  })

  logger.info('finder', 'Phase 1: Email Leads')

  for (const category of finderCategories) {
    if (emailCount >= EMAIL_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (costGuardHit) break

    const categoryLimit = category.capped ? cappedLimit : EMAIL_TARGET - emailCount
    let categoryEmailCount = 0
    const shouldApplyHalalQualification = isHalalFilterCategory(category.name)
    logger.info('finder', `Category: ${category.name}`, { limit: categoryLimit })
    if (!shouldApplyHalalQualification) {
      logger.info('finder', `Skipping halal qualification for category: ${category.name}`)
    }

    citySuburbLoop:
    for (const [city, suburbs] of Object.entries(cityAreas)) {
      const state = CITY_STATE[city] ?? 'Unknown'

      for (const suburb of suburbs) {
        if (emailCount >= EMAIL_TARGET) break citySuburbLoop
        if (emailCount + dmCount >= TOTAL_TARGET) break citySuburbLoop
        if (categoryEmailCount >= categoryLimit) break citySuburbLoop
        if (costGuardHit) break citySuburbLoop

        for (const keyword of category.queries) {
          if (emailCount >= EMAIL_TARGET) break citySuburbLoop
          if (emailCount + dmCount >= TOTAL_TARGET) break citySuburbLoop
          if (categoryEmailCount >= categoryLimit) break citySuburbLoop
          if (costGuardHit) break citySuburbLoop

        const query = buildNormalizedSearchQuery(keyword, suburb, city, state)
        logger.info('finder', '[SEARCH_QUERY_NORMALIZED]', { keyword, suburb, city, state, query })
        // Check and guard BEFORE seenQueries.add — API call only happens after add
        if (seenQueries.has(query)) {
          logger.info('finder', `Skip duplicate query: ${query}`)
          continue
        }
        if (exhaustedSet.has(query)) {
          logger.info('finder', `Skip exhausted query: ${query}`)
          continue
        }
        if (seenQueries.size >= MAX_QUERIES_EXECUTED) {
          logger.warn('finder', 'Safety limit: max queries executed', { limit: MAX_QUERIES_EXECUTED, executed: seenQueries.size })
          safetyLimitHit = true
          safetyLimitReason = `max_queries_executed (${MAX_QUERIES_EXECUTED})`
          break citySuburbLoop
        }
        seenQueries.add(query)

        let skip = 0
        let exhaustedThisQuery = false
        while (true) {
          if (emailCount >= EMAIL_TARGET) break
          if (emailCount + dmCount >= TOTAL_TARGET) break
          if (categoryEmailCount >= categoryLimit) break
          if (costGuardHit) break
          if (safetyLimitHit) break

          // Safety: stop if we've processed too many businesses or run too long
          if (businessesProcessed >= MAX_BUSINESSES_PROCESSED) {
            logger.warn('finder', 'Safety limit: max businesses processed', { limit: MAX_BUSINESSES_PROCESSED, processed: businessesProcessed })
            safetyLimitHit = true
            safetyLimitReason = `max_businesses_processed (${MAX_BUSINESSES_PROCESSED})`
            break
          }
          if (Date.now() - runStartTime >= MAX_RUNTIME_MS) {
            logger.warn('finder', 'Safety limit: max runtime reached', { limitMin: MAX_RUNTIME_MS / 60000, elapsedMin: ((Date.now() - runStartTime) / 60000).toFixed(1) })
            safetyLimitHit = true
            safetyLimitReason = `max_runtime_exceeded (${MAX_RUNTIME_MS / 60000}min)`
            break
          }

          // Cost guard — check before every Outscraper call
          const currentRunEstimate = outscraperResultsFetched * 0.003
          if (spentToday + currentRunEstimate >= DAILY_OUTSCRAPER_LIMIT) {
            logger.warn('finder', 'Cost guard triggered', { limit: DAILY_OUTSCRAPER_LIMIT, spentToday, estimate: currentRunEstimate })
            await supabase.from('activity_log').insert({
              event_type:  'cost_guard_triggered',
              description: `Daily Outscraper limit $${DAILY_OUTSCRAPER_LIMIT} reached`,
              metadata:    { spent_today: spentToday, current_run_estimate: currentRunEstimate, limit: DAILY_OUTSCRAPER_LIMIT },
            })
            costGuardHit = true
            break
          }

          let results: OutscraperResult[]
          let apiUsed: string
          try {
            callCount++
            const searchResult = await searchBusinesses(query, category.batchSize, supabase, skip)
            await supabase
              .from('city_suburbs')
              .update({ last_used_at: new Date().toISOString() })
              .eq('active', true)
              .eq('city', city)
              .eq('suburb', suburb)
            results = searchResult.results
            apiUsed = searchResult.apiUsed
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('402')) throw error  // balance exhausted — abort pipeline
            logger.error('finder', `Search error: ${query}`, { error: msg })
            await supabase.from('dead_letter_queue').insert({
              operation: 'outscraper_search',
              payload: { query, skip },
              error: msg,
            })
            await supabase.from('activity_log').insert({
              event_type: 'agent_error',
              description: `Search error for query "${query}": ${msg}`,
              metadata: { query, skip, error: msg },
            })
            break
          }
          totalResultsFetched += results.length
          if (apiUsed === 'outscraper' || apiUsed === 'outscraper_fallback') {
            outscraperResultsFetched += results.length
          }

          let newLeadsThisBatch = 0

          for (const result of results) {
            if (emailCount >= EMAIL_TARGET) break
            if (emailCount + dmCount >= TOTAL_TARGET) break
            if (categoryEmailCount >= categoryLimit) break
            if (Date.now() - runStartTime >= MAX_RUNTIME_MS) {
              logger.warn('finder', 'Safety limit: max runtime reached mid-batch', {
                limitMin:   MAX_RUNTIME_MS / 60000,
                elapsedMin: ((Date.now() - runStartTime) / 60000).toFixed(1),
              })
              safetyLimitHit = true
              safetyLimitReason = `max_runtime_exceeded (${MAX_RUNTIME_MS / 60000}min)`
              break
            }

            businessesProcessed++

            const name       = result.name
            const rawWebsite = result.website || null
            let normalizedWebsite = rawWebsite
            let websiteFailureReason: string | null = null

            if (isIrrelevant(name)) {
              logger.info('finder', `Skip irrelevant: ${name}`)
              continue
            }

            if (rawWebsite) {
              logger.info('finder', 'Website extracted', {
                business_name: name,
                extracted_website: rawWebsite,
              })
            }

            // Business whose website IS an Instagram page has no real web presence for email
            if (rawWebsite && INSTAGRAM_REGEX.test(rawWebsite)) {
              logger.info('finder', `Skip Instagram website: ${name}`)
              noOutreachMethodsRemoved++
              continue
            }

            let foundEmail: string | null = null
            let emailSource = ''
            let websiteText = ''
            let halalConfidenceScore: number | null = null
            let halalReasons: string[] | null = null
            if (result.email && isValidEmail(result.email)) {
              foundEmail  = result.email
              emailSource = 'outscraper'
            }

            if (!foundEmail && !rawWebsite) {
              logger.info('finder', 'No website available for email extraction', {
                business_name: name,
                extracted_website: rawWebsite,
              })
              noOutreachMethodsRemoved++
              continue
            }

            if (!foundEmail && rawWebsite) {
              const found = await findEmailForBusiness(rawWebsite, name, runStartTime + MAX_RUNTIME_MS)
              websiteText = found.websiteText
              normalizedWebsite = found.normalizedWebsite ?? rawWebsite
              websiteFailureReason = found.failureReason
              logger.info('finder', 'Website normalized', {
                business_name: name,
                extracted_website: rawWebsite,
                normalized_website: normalizedWebsite,
              })
              if (websiteFailureReason) {
                logger.info('finder', 'Website validation failed', {
                  business_name: name,
                  extracted_website: rawWebsite,
                  normalized_website: normalizedWebsite,
                  reason: websiteFailureReason,
                })
              }
              if (found.email) {
                foundEmail  = found.email
                emailSource = found.source
              }
            } else if (rawWebsite && shouldApplyHalalQualification) {
              const websiteFetch = await fetchHtmlWithDiagnostics(rawWebsite)
              websiteText = websiteFetch.html
              normalizedWebsite = websiteFetch.finalUrl || websiteFetch.requestedUrl || rawWebsite
              websiteFailureReason = websiteFetch.reason ?? null
              logger.info('finder', 'Website normalized', {
                business_name: name,
                extracted_website: rawWebsite,
                normalized_website: normalizedWebsite,
              })
              if (websiteFailureReason) {
                logger.info('finder', 'Website validation failed', {
                  business_name: name,
                  extracted_website: rawWebsite,
                  normalized_website: normalizedWebsite,
                  reason: websiteFailureReason,
                })
              }
            }

            if (shouldApplyHalalQualification) {
              const halalQualification = scoreHalalQualification({
                name,
                categories: [category.name, ...(result.categories ?? [])],
                websiteText,
                websiteUrl: normalizedWebsite ?? rawWebsite,
                reviewTexts: result.reviewTexts ?? [],
                reviews: result.reviews ?? 0,
              })
              halalConfidenceScore = halalQualification.confidence
              halalReasons = halalQualification.reasons
              halalConfidenceRecorded++

              logger.info('finder', 'HALAL_CONFIDENCE_RECORDED', {
                business_name: name,
                category: category.name,
                confidence: halalQualification.confidence,
                classification: halalQualification.classification,
                reasons: halalQualification.reasons,
                negative_signals: halalQualification.negativeSignals,
              })
            }

            if (await isAlreadyInDB(supabase, name, city, result.phone)) {
              duplicatesRemoved++
              logger.info('finder', `Skip duplicate: ${name}`)
              continue
            }

            if (foundEmail) {
              const emailValidation = validateBusinessEmail(foundEmail, name)
              if (!emailValidation.valid) {
                invalidEmailsRemoved++
                logger.info('finder', 'Skipped invalid email', {
                  business_name: name,
                  email: foundEmail,
                  reason: emailValidation.reason ?? 'invalid email',
                })
                continue
              }

              const dedupeDecision = checkLeadDedupe(foundEmail, dedupeIndex)
              if (dedupeDecision.duplicate) {
                const duplicateMeta = {
                  candidate_business_name: name,
                  candidate_email: dedupeDecision.email,
                  root_domain: dedupeDecision.rootDomain,
                  existing_lead_id: dedupeDecision.match.id,
                  existing_business_name: dedupeDecision.match.businessName,
                  existing_email: dedupeDecision.match.email,
                  existing_status: dedupeDecision.match.status,
                  skipped_reason: dedupeDecision.reason,
                }
                logger.info('finder', dedupeDecision.reason, duplicateMeta)
                if (dedupeDecision.reason === 'DUPLICATE_EMAIL_SKIPPED') {
                  logger.info('finder', '[DEBUG_DEDUPLICATION] duplicate email detected', duplicateMeta)
                } else {
                  logger.info('finder', '[DEBUG_DEDUPLICATION] duplicate domain detected', duplicateMeta)
                }
                logger.info('finder', '[DEBUG_DEDUPLICATION] lead skipped reason', duplicateMeta)
                duplicatesRemoved++
                continue
              }

              qualifiedCandidates++
              const { data: insertedLead, error } = await supabase.from('leads').insert({
                business_name:        name,
                category_name:        category.name,
                city:                 city,
                state:                state,
                phone:                result.phone  || null,
                email:                foundEmail,
                website:              normalizedWebsite,
                address:              result.address || null,
                google_rating:        result.rating  || null,
                google_reviews_count: result.reviews || null,
                halal_confidence_score: halalConfidenceScore,
                halal_reasons:        halalReasons,
                status:               'new',
                outreach_channel:     'email',
              }).select('id, business_name, email, status').single()

              if (error) {
                logger.error('finder', `Insert failed: ${name}`, { error: error.message })
                continue
              }

              if (insertedLead) {
                addLeadToDedupeIndex(dedupeIndex, insertedLead)
              }

              emailCount++
              categoryEmailCount++
              newLeadsThisBatch++
              logger.info('finder', `Email lead: ${name}`, { email: foundEmail, source: emailSource })

              logger.info('finder', `SUCCESSFUL_LEAD_PROGRESS = ${emailCount}/${EMAIL_TARGET} (category ${categoryEmailCount}/${categoryLimit})`, {
                category:          category.name,
                category_progress: `${categoryEmailCount}/${categoryLimit}`,
                global_progress:   `${emailCount}/${EMAIL_TARGET}`,
                category_count:    categoryEmailCount,
                category_cap:      categoryLimit,
                email_count:       emailCount,
                email_target:      EMAIL_TARGET,
                remaining:         EMAIL_TARGET - emailCount,
              })

              if (emailCount >= EMAIL_TARGET) {
                logger.info('finder', 'DAILY_TARGET_REACHED', {
                  email_count:         emailCount,
                  email_target:        EMAIL_TARGET,
                  businesses_processed: businessesProcessed,
                  queries_executed:    seenQueries.size,
                  elapsed_ms:          Date.now() - runStartTime,
                })
              }

              await supabase.from('activity_log').insert({
                event_type:  'lead_found',
                description: `Email lead: ${name} — ${foundEmail}`,
                metadata:    { category: category.name, city, email: foundEmail, source: emailSource, type: 'email' },
              })
            } else {
              noOutreachMethodsRemoved++
              logger.info('finder', 'No email found after website validation', {
                business_name: name,
                extracted_website: rawWebsite,
                normalized_website: normalizedWebsite,
                validation_failure_reason: websiteFailureReason ?? 'email not found',
              })
            }
          }

          if (safetyLimitHit) break

          // Log progress after every batch regardless of yield
          logger.info('finder', 'DAILY_TARGET_PROGRESS', {
            email_count: emailCount,
            email_target: EMAIL_TARGET,
            new_leads_this_batch: newLeadsThisBatch,
            businesses_processed: businessesProcessed,
            queries_executed: seenQueries.size,
            elapsed_ms: Date.now() - runStartTime,
          })

          if (categoryEmailCount >= categoryLimit) {
            logger.info('finder', `CATEGORY_CAP_REACHED = ${category.name} (${categoryEmailCount}/${categoryLimit}) global ${emailCount}/${EMAIL_TARGET}`, {
              category:          category.name,
              category_cap:      categoryLimit,
              category_count:    categoryEmailCount,
              global_progress:   `${emailCount}/${EMAIL_TARGET}`,
              email_count:       emailCount,
              email_target:      EMAIL_TARGET,
              capped:            category.capped,
            })
            break
          }

          // Google Maps and cache results are complete in one call — no pagination
          if (apiUsed === 'google_maps' || apiUsed === 'cache') {
            exhaustedThisQuery = true
            break
          }

          if (results.length <= 1) {
            exhaustedThisQuery = true
            break
          }

          // Low-yield batch: log and continue to next page rather than stopping early.
          // Safety limits above bound total search depth.
          if (newLeadsThisBatch === 0) {
            logger.info('finder', 'SEARCH_CONTINUING_FOR_TARGET', {
              query,
              skip,
              global_progress:      `${emailCount}/${EMAIL_TARGET}`,
              remaining_needed:     EMAIL_TARGET - emailCount,
              category_progress:    `${categoryEmailCount}/${categoryLimit}`,
              queries_executed:     seenQueries.size,
              queries_remaining:    Math.max(0, MAX_QUERIES_EXECUTED - seenQueries.size),
              businesses_processed: businessesProcessed,
              reason:               'zero new leads this batch — paginating for more',
            })
          }

          skip += category.batchSize
        }

        if (exhaustedThisQuery) {
          await supabase.from('exhausted_queries').upsert({
            query,
            city,
            category: category.name,
            exhausted_at: new Date().toISOString(),
            expires_at:   new Date(Date.now() + 3 * 86_400_000).toISOString(),
          })
          exhaustedSet.add(query)
        }

        if (costGuardHit || safetyLimitHit) break citySuburbLoop
        }
      }
      if (costGuardHit || safetyLimitHit) break
    }
    if (costGuardHit || safetyLimitHit) break
  }

  const finderStopReason =
    emailCount >= EMAIL_TARGET ? 'DAILY_TARGET_REACHED'
    : costGuardHit             ? 'COST_GUARD_HIT'
    : safetyLimitHit           ? 'SAFETY_LIMIT_REACHED'
    :                            'ALL_QUERIES_EXHAUSTED'

  logger.info('finder', `FINDER_STOP_REASON = ${finderStopReason} (${emailCount}/${EMAIL_TARGET})`, {
    reason:               finderStopReason,
    email_count:          emailCount,
    email_target:         EMAIL_TARGET,
    global_progress:      `${emailCount}/${EMAIL_TARGET}`,
    cost_guard_hit:       costGuardHit,
    safety_limit_hit:     safetyLimitHit,
    safety_limit_reason:  safetyLimitReason || null,
    businesses_processed: businessesProcessed,
    queries_executed:     seenQueries.size,
    elapsed_ms:           Date.now() - runStartTime,
  })

  logger.info('finder', 'Phase 1 complete', { emailCount, target: EMAIL_TARGET })

  if (emailCount < EMAIL_TARGET) {
    logger.info('finder', 'SEARCH_EXHAUSTED_BEFORE_TARGET', {
      email_count: emailCount,
      email_target: EMAIL_TARGET,
      businesses_processed: businessesProcessed,
      queries_executed: seenQueries.size,
      elapsed_ms: Date.now() - runStartTime,
      safety_limit_hit: safetyLimitHit,
      safety_limit_reason: safetyLimitReason || 'all_queries_exhausted',
    })
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 2 — MANUAL INSTAGRAM DM QUEUE
  // No Outscraper calls — queue existing leads for manual Instagram outreach
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  logger.info('finder', 'Phase 2: Instagram DM Queue (free)')

  await cleanupDmQueue(supabase)

  // Get lead IDs already in dm_queue so we don't double-queue
  const { data: existingDms } = await supabase
    .from('dm_queue')
    .select('lead_id')
  const alreadyQueued = new Set((existingDms ?? []).map((r) => r.lead_id))

  // Find leads in DM categories with no email — not yet queued, in active cities
  const { data: dmCandidates } = activeFinderCategoryNames.length
    ? await supabase
      .from('leads')
      .select('id, business_name, category_name, city, state, halal_confidence_score')
      .in('category_name', activeFinderCategoryNames)
      .is('email', null)
      .eq('status', 'new')
      .in('city', activeCities)
      .order('created_at', { ascending: false })
      .limit(DM_TARGET * 3)
    : { data: [] }

  for (const lead of dmCandidates ?? []) {
    if (dmCount >= DM_TARGET) break
    if (emailCount + dmCount >= TOTAL_TARGET) break
    if (alreadyQueued.has(lead.id)) continue

    // Derive a suggested Instagram handle from the business name
    const suggestedHandle = lead.business_name
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9_.]/g, '')
      .slice(0, 30) || 'instagram'

    const dmMessage =
      `Hi! We're Aussie Venture, a food & lifestyle media brand based in Sydney. ` +
      `We'd love to feature ${lead.business_name} in our content. ` +
      `Would you be open to a collaboration? DM us back if you're keen!`

    const { error } = await supabase.from('dm_queue').insert({
      lead_id:      lead.id,
      platform:     'instagram',
      handle:       suggestedHandle,
      message_text: dmMessage,
      status:       'pending',
    })

    if (error) {
      logger.error('finder', `DM queue insert failed: ${lead.business_name}`, { error: error.message })
      continue
    }

    dmCount++
    logger.info('finder', `DM queued: ${lead.business_name}`, { handle: suggestedHandle })

    await supabase.from('activity_log').insert({
      event_type:  'lead_found',
      description: `DM queued: ${lead.business_name} — search @${suggestedHandle} on Instagram`,
      metadata:    { category: lead.category_name, city: lead.city, suggested_handle: suggestedHandle, type: 'dm' },
    })
  }

  logger.info('finder', 'Phase 2 complete', { dmCount, target: DM_TARGET })

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SUMMARY
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const leadsKept     = emailCount + dmCount
  const estimatedCost = (outscraperResultsFetched * 0.003).toFixed(4)
  const efficiency    = `${leadsKept}/${totalResultsFetched} results used`
  const efficiencyPct = totalResultsFetched > 0 ? ((leadsKept / totalResultsFetched) * 100).toFixed(1) : '0.0'

  logger.info('finder', `Outscraper results fetched: ${outscraperResultsFetched}`)
  logger.info('finder', `Total results fetched (all APIs): ${totalResultsFetched}`)
  logger.info('finder', `Leads kept: ${leadsKept}`)
  logger.info('finder', `Efficiency: ${leadsKept}/${totalResultsFetched} (${efficiencyPct}%)`)
  logger.info('finder', `Estimated Outscraper cost: $${estimatedCost}`)
  logger.info('finder', '[QUALIFIED_OUTREACH_COUNTS]', {
    search_results: totalResultsFetched,
    businesses_processed: businessesProcessed,
    queries_executed: seenQueries.size,
    halal_confidence_recorded: halalConfidenceRecorded,
    duplicates_removed: duplicatesRemoved,
    invalid_emails_removed: invalidEmailsRemoved,
    no_outreach_methods_removed: noOutreachMethodsRemoved,
    qualified_outreach_candidates: qualifiedCandidates,
    emails_queued: emailCount,
    safety_limit_hit: safetyLimitHit,
    safety_limit_reason: safetyLimitReason || null,
    final_quota_counts: {
      email_leads: emailCount,
      dm_leads: dmCount,
      total_leads: leadsKept,
      email_target: EMAIL_TARGET,
      dm_target: DM_TARGET,
      total_target: TOTAL_TARGET,
    },
  })

  logger.info('finder', 'Run complete', {
    emailLeads: emailCount,
    dmLeads: dmCount,
    outscraperCalls: callCount,
    resultsFetched: totalResultsFetched,
    estimatedCost,
    efficiency,
    costGuardHit,
  })
  if (costGuardHit) logger.warn('finder', `Run stopped by cost guard ($${DAILY_OUTSCRAPER_LIMIT} daily limit)`)

  await supabase.from('activity_log').insert({
    event_type:  'finder_complete',
    description: `Finder complete: ${emailCount} email leads, ${dmCount} DM leads queued (${callCount} Outscraper calls)`,
    metadata: {
      email_leads:        emailCount,
      dm_leads:           dmCount,
      email_target:       EMAIL_TARGET,
      dm_target:          DM_TARGET,
      total_target:       TOTAL_TARGET,
      outscraper_calls:   callCount,
      results_fetched:    totalResultsFetched,
      leads_kept:         leadsKept,
      halal_confidence_recorded: halalConfidenceRecorded,
      duplicates_removed: duplicatesRemoved,
      invalid_emails_removed: invalidEmailsRemoved,
      no_outreach_methods_removed: noOutreachMethodsRemoved,
      qualified_outreach_candidates: qualifiedCandidates,
      outscraper_results: outscraperResultsFetched,
      businesses_processed: businessesProcessed,
      queries_executed: seenQueries.size,
      estimated_cost:     estimatedCost,
      efficiency,
      cost_guard_hit:     costGuardHit,
      safety_limit_hit:   safetyLimitHit,
      safety_limit_reason: safetyLimitReason || null,
    },
  })

  return leadsKept

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('finder', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    const isBalanceError = message.includes('402')
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'finder',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        is_balance_error: isBalanceError,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}

function extractInstagramHandle(text: string): string | null {
  const match = text.match(INSTAGRAM_REGEX)
  if (!match) return null
  const handle = match[1].toLowerCase()
  if (INSTAGRAM_SKIP.has(handle)) return null
  return `@${match[1]}`
}
