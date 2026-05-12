const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReachAgentBot/1.0)' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    console.log(`\nHTTP ${res.status} ${res.statusText} — ${url}`)
    return await res.text()
  } catch (err) {
    clearTimeout(timeoutId)
    console.error(`Fetch failed (${url}):`, err)
    return ''
  }
}

async function run() {
  // ── Homepage ──────────────────────────────────────────────────────────────
  const homeHtml = await fetchPage('https://www.summertravel.com.au/')

  console.log('\n=== HOMEPAGE — first 5000 chars ===')
  console.log(homeHtml.slice(0, 5000))

  const homeMatches = homeHtml.match(EMAIL_REGEX) ?? []
  console.log('\n=== HOMEPAGE — email regex matches ===')
  console.log(homeMatches.length ? homeMatches : '(none found)')

  // ── Contact page ─────────────────────────────────────────────────────────
  const contactHtml = await fetchPage('https://www.summertravel.com.au/contact')

  console.log('\n=== CONTACT PAGE — first 5000 chars ===')
  console.log(contactHtml.slice(0, 5000))

  const contactMatches = contactHtml.match(EMAIL_REGEX) ?? []
  console.log('\n=== CONTACT PAGE — email regex matches ===')
  console.log(contactMatches.length ? contactMatches : '(none found)')
}

run()
