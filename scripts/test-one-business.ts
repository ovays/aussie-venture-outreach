import { config } from 'dotenv'
config({ path: '.env.local' })
import { searchBusinesses } from '../src/lib/outscraper'

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

async function fetchWebsiteText(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`
    const res = await fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    console.log(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 50000)
  } catch (err) {
    clearTimeout(timeoutId)
    console.error('Fetch error:', err)
    return ''
  }
}

async function run() {
  console.log('Searching Outscraper: "travel agent Sydney" limit=10...\n')

  const results = await searchBusinesses('tour operator Sydney', 10)
  console.log(`Got ${results.length} results\n`)

  // Show email field status for all results
  console.log('=== Outscraper email field scan (all results) ===')
  for (const r of results) {
    const raw = r as unknown as Record<string, unknown>
    console.log(`  ${r.name}: email="${raw.email ?? ''}" website="${r.website ?? ''}"`)
  }

  // Try each business with a website until we find an email
  console.log('\n=== Trying each business with a website until email found ===')
  for (const result of results) {
    if (!result.website) continue

    const raw = result as unknown as Record<string, unknown>
    console.log(`\n--- ${result.name} ---`)
    console.log(`Outscraper email field: ${raw.email ?? '(none)'}`)
    console.log(`Website: ${result.website}`)
    console.log(`Full raw object:\n${JSON.stringify(result, null, 2)}`)

    console.log('\nFetching homepage...')
    const homeText = await fetchWebsiteText(result.website)
    console.log(`Stripped length: ${homeText.length}`)
    const homeMatches = homeText.match(EMAIL_REGEX) ?? []
    console.log(`Homepage email matches: ${homeMatches.length ? homeMatches.join(', ') : '(none)'}`)

    if (!homeMatches.length) {
      const base = result.website.replace(/\/$/, '')
      console.log(`\nFetching /contact page...`)
      const contactText = await fetchWebsiteText(`${base}/contact`)
      const contactMatches = contactText.match(EMAIL_REGEX) ?? []
      console.log(`Contact page email matches: ${contactMatches.length ? contactMatches.join(', ') : '(none)'}`)

      if (contactMatches.length) {
        console.log(`\n✅ Email found: ${contactMatches[0]}`)
        break
      }
    } else {
      console.log(`\n✅ Email found: ${homeMatches[0]}`)
      break
    }

    console.log('❌ No email found on this business — trying next...')
  }
}

run()
