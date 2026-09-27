import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const PUBLIC_HTTP_MAX_REDIRECTS = 3
export const PUBLIC_HTTP_MAX_RESPONSE_BYTES = 512 * 1024
export const PUBLIC_HTTP_TIMEOUT_MS = 10_000

type LookupAddress = { address: string; family: number }
type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>

export interface SafePublicHttpOptions {
  fetchImpl?: typeof fetch
  lookup?: Lookup
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
}

export interface SafePublicHttpResult {
  text: string
  finalUrl: string
  status: number
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
])

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null
  const octets = address.split('.').map(Number)
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null
}

/** True only for an internet-routable address. Reserved ranges fail closed. */
export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const parts = ipv4Octets(address)!
    const [a, b, c] = parts
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 0) return false
    if (a === 192 && b === 168) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split('%')[0]
    if (normalized === '::' || normalized === '::1') return false
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
    if (/^fe[89ab]/.test(normalized)) return false
    if (normalized.startsWith('ff')) return false
    if (normalized.startsWith('2001:db8:')) return false
    if (normalized.startsWith('::ffff:')) {
      const embedded = normalized.slice('::ffff:'.length)
      return isPublicIpAddress(embedded)
    }
    return true
  }
  return false
}

function normalizeHttpUrl(value: string): URL {
  const raw = value.trim()
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) URLs are allowed')
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  if (!url.hostname || url.hostname.length > 253) throw new Error('Invalid public hostname')
  return url
}

async function defaultLookup(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

export async function assertPublicHttpUrl(value: string, lookup: Lookup = defaultLookup): Promise<URL> {
  const url = normalizeHttpUrl(value)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private or local hosts are not allowed')
  }

  const literalVersion = isIP(hostname)
  if (literalVersion) {
    if (!isPublicIpAddress(hostname)) throw new Error('Private or reserved IP addresses are not allowed')
    return url
  }

  const addresses = await lookup(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('Hostname did not resolve exclusively to public addresses')
  }
  return url
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response body is too large')
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('Response body is too large')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/** Fetches only validated public HTTP(S), validating every redirect and bounding time/bytes. */
export async function fetchPublicText(value: string, options: SafePublicHttpOptions = {}): Promise<string> {
  return (await fetchPublicTextResponse(value, options)).text
}

export async function fetchPublicTextResponse(value: string, options: SafePublicHttpOptions = {}): Promise<SafePublicHttpResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const lookup = options.lookup ?? defaultLookup
  const maxBytes = Math.max(1, options.maxBytes ?? PUBLIC_HTTP_MAX_RESPONSE_BYTES)
  const maxRedirects = Math.max(0, options.maxRedirects ?? PUBLIC_HTTP_MAX_REDIRECTS)
  const timeoutMs = Math.max(1, options.timeoutMs ?? PUBLIC_HTTP_TIMEOUT_MS)
  const signal = AbortSignal.timeout(timeoutMs)
  let url = await assertPublicHttpUrl(value, lookup)

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirect === maxRedirects) throw new Error('Unsafe or excessive redirect')
      url = await assertPublicHttpUrl(new URL(location, url).toString(), lookup)
      continue
    }
    if (!response.ok) throw new Error(`Public HTTP request failed with status ${response.status}`)
    return { text: await readBoundedText(response, maxBytes), finalUrl: url.toString(), status: response.status }
  }
  throw new Error('Redirect limit exceeded')
}
