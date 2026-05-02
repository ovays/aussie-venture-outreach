import { config } from 'dotenv'
config({ path: '.env.local' })

import { searchBusinesses } from '../src/lib/outscraper'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const MAILTO_REGEX = /href=["']mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi

const BLOCKED_LOCALS = new Set([
  'noreply', 'donotreply', 'no-reply', 'wordpress',
  'postmaster', 'webmaster', 'bounce', 'mailer',
])

function filterEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0]
  if (BLOCKED_LOCALS.has(local)) return false
  if (local.length < 4) return false
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i.test(email)) return false
  if (email.toLowerCase().includes('@2x')) return false
  // No vowels + no separators = random tracking ID (e.g. bg0i, ey6i, da7i)
  const hasVowel = /[aeiou]/.test(local)
  const hasSeparator = /[._]/.test(local)
  if (!hasVowel && !hasSeparator) return false
  // Short alphanumeric with digits = generated ID (bg0i, ey6i) — real locals don't mix random chars+digits
  if (/^[a-z0-9]{2,6}$/.test(local) && /\d/.test(local)) return false
  return true
}

async function fetchHtml(url: string): Promise<{ html: string; status: number }> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AussieVentureBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const html = await res.text()
    return { html, status: res.status }
  } catch {
    clearTimeout(timeoutId)
    return { html: '', status: 0 }
  }
}

function findEmails(html: string): { mailto: string[]; regex: string[] } {
  const mailtoMatches: string[] = []
  let m: RegExpExecArray | null
  const mailtoRe = new RegExp(MAILTO_REGEX.source, 'gi')
  while ((m = mailtoRe.exec(html)) !== null) {
    if (filterEmail(m[1])) mailtoMatches.push(m[1])
  }
  const regexMatches = (html.match(EMAIL_REGEX) ?? []).filter(filterEmail)
  return {
    mailto: [...new Set(mailtoMatches)],
    regex: [...new Set(regexMatches)],
  }
}

async function run() {
  console.log('Searching Outscraper: "travel agent Sydney" limit=10...\n')
  const results = await searchBusinesses('travel agent Sydney', 10)
  console.log(`Got ${results.length} results\n`)
  console.log('═'.repeat(60))

  let fromOutscraper = 0
  let fromWebsite = 0
  let noEmail = 0

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const raw = r as unknown as Record<string, unknown>
    console.log(`\n[${i + 1}] ${r.name}`)
    console.log(`    Website (raw)   : ${r.website || '(none)'}`)
    console.log(`    Outscraper email: ${(raw.email as string) || '(none)'}`)

    // Already have email from Outscraper
    if (raw.email && typeof raw.email === 'string' && filterEmail(raw.email)) {
      console.log(`    ✅ Found email: ${raw.email} (source: outscraper)`)
      fromOutscraper++
      continue
    }

    if (!r.website) {
      console.log('    ❌ No website — no email found')
      noEmail++
      continue
    }

    // a. Decode URL
    const decoded = decodeURIComponent(r.website)
    const base = decoded.replace(/\/$/, '')
    if (decoded !== r.website) {
      console.log(`    Website (decoded): ${decoded}`)
    }

    let foundEmail: string | null = null
    let source = ''

    // b+c. Fetch homepage — mailto: first, then full HTML regex
    console.log(`    Fetching homepage...`)
    const { html: homeHtml, status: homeStatus } = await fetchHtml(decoded)
    console.log(`    HTTP ${homeStatus} (${homeHtml.length} chars raw HTML)`)

    if (homeHtml) {
      const { mailto, regex } = findEmails(homeHtml)
      console.log(`    mailto: links : ${mailto.length ? mailto.join(', ') : '(none)'}`)
      console.log(`    regex matches : ${regex.length ? regex.slice(0, 5).join(', ') : '(none)'}`)
      if (mailto.length) { foundEmail = mailto[0]; source = 'mailto on homepage' }
      else if (regex.length) { foundEmail = regex[0]; source = 'homepage regex' }
    }

    // d. Try /contact
    if (!foundEmail) {
      console.log(`    Fetching /contact...`)
      const { html: contactHtml, status: contactStatus } = await fetchHtml(`${base}/contact`)
      console.log(`    HTTP ${contactStatus} (${contactHtml.length} chars)`)
      if (contactHtml) {
        const { mailto, regex } = findEmails(contactHtml)
        console.log(`    mailto: links : ${mailto.length ? mailto.join(', ') : '(none)'}`)
        console.log(`    regex matches : ${regex.length ? regex.slice(0, 5).join(', ') : '(none)'}`)
        if (mailto.length) { foundEmail = mailto[0]; source = 'mailto on /contact' }
        else if (regex.length) { foundEmail = regex[0]; source = '/contact regex' }
      }
    }

    // e. Try /about
    if (!foundEmail) {
      console.log(`    Fetching /about...`)
      const { html: aboutHtml, status: aboutStatus } = await fetchHtml(`${base}/about`)
      console.log(`    HTTP ${aboutStatus} (${aboutHtml.length} chars)`)
      if (aboutHtml) {
        const { mailto, regex } = findEmails(aboutHtml)
        console.log(`    mailto: links : ${mailto.length ? mailto.join(', ') : '(none)'}`)
        console.log(`    regex matches : ${regex.length ? regex.slice(0, 5).join(', ') : '(none)'}`)
        if (mailto.length) { foundEmail = mailto[0]; source = 'mailto on /about' }
        else if (regex.length) { foundEmail = regex[0]; source = '/about regex' }
      }
    }

    if (foundEmail) {
      console.log(`    ✅ Found email: ${foundEmail} (source: ${source})`)
      fromWebsite++
    } else {
      console.log(`    ❌ No email found`)
      noEmail++
    }
  }

  const total = fromOutscraper + fromWebsite
  console.log('\n' + '═'.repeat(60))
  console.log(`Out of ${results.length} travel agents:`)
  console.log(`  ${fromOutscraper} had email from Outscraper directly`)
  console.log(`  ${fromWebsite} had email found from website`)
  console.log(`  ${noEmail} had no email anywhere`)
  console.log(`  Total with email: ${total}/${results.length}`)
}

run()
