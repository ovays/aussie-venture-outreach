const MAX_BUSINESSES_PROCESSED = 20

const mockBusinesses = [
  { domain: 'a.com', duplicate: true },
  { domain: 'b.com', duplicate: true },
  { domain: 'c.com', duplicate: true },
  { domain: 'd.com', duplicate: false },
  { domain: 'e.com', duplicate: false },
  { domain: 'f.com', duplicate: true },
  { domain: 'g.com', duplicate: false },
  { domain: 'h.com', duplicate: false },
  { domain: 'i.com', duplicate: true },
  { domain: 'j.com', duplicate: false },
  { domain: 'k.com', duplicate: false },
  { domain: 'l.com', duplicate: true },
  { domain: 'm.com', duplicate: false },
  { domain: 'n.com', duplicate: false },
  { domain: 'o.com', duplicate: true },
  { domain: 'p.com', duplicate: false },
  { domain: 'q.com', duplicate: false },
  { domain: 'r.com', duplicate: true },
  { domain: 's.com', duplicate: false },
  { domain: 't.com', duplicate: false },
  { domain: 'u.com', duplicate: false },
  { domain: 'v.com', duplicate: false },
  { domain: 'w.com', duplicate: false },
]

let businessesProcessed = 0
let duplicatesSkipped = 0
let realCandidates = 0

for (const business of mockBusinesses) {

  if (businessesProcessed >= MAX_BUSINESSES_PROCESSED) {
    console.log('')
    console.log('STOPPED — quota exhausted')
    break
  }

  if (business.duplicate) {
    duplicatesSkipped++
    console.log(`[DUPLICATE] ${business.domain}`)
    
    // IMPORTANT:
    // NO businessesProcessed++ HERE
    
    continue
  }

  businessesProcessed++
  realCandidates++

  console.log(`[REAL] ${business.domain}`)
}

console.log('')
console.log('==============================')
console.log('RESULTS')
console.log('==============================')
console.log('MAX_BUSINESSES_PROCESSED :', MAX_BUSINESSES_PROCESSED)
console.log('businessesProcessed      :', businessesProcessed)
console.log('duplicatesSkipped        :', duplicatesSkipped)
console.log('realCandidates           :', realCandidates)