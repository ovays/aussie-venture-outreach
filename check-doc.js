const fs = require('fs')
const lines = fs.readFileSync('docs/outreach-sequences.md', 'utf8').split('\n')
const BANNED = [/—/, /!/, /following up/i, /just checking in|touching base|circling back/i,
  /our (audience|followers)/i, /(perfect|great|ideal|good) fit/i, /we'?d love to/i,
  /\b(excited|thrilled|stoked|resonate|authentic|showcase|immersive|vibrant|iconic|curated|leverage|synergy)\b/i,
  /hidden gem|must[- ]visit|no rush|at your convenience|hope this .*finds you well/i,
  /I came across|I stumbled across/i]
let cat = '', curStage = '', bad = 0, buf = []
const wc = {}
function flush() {
  if (!curStage || !buf.length) return
  const body = buf.join(' ')
  const words = body.split('Cheers,')[0].trim().split(/\s+/).filter(Boolean).length
  ;(wc[curStage] ??= []).push({ cat, words })
  if (curStage === 'Follow-up 2' && /package|pricing|price|budget|cost|option/i.test(body)) {
    console.log(`COMMERCIALS IN FU2: ${cat}`); bad++
  }
  if (curStage !== 'Initial' && !/I'm Owais.*Instagram, TikTok and Facebook/.test(body)) {
    console.log(`MISSING REMINDER: ${cat} / ${curStage}`); bad++
  }
  buf = []
}
for (const l of lines) {
  const h = l.match(/^## \d+\. (.+)$/); if (h) { flush(); cat = h[1]; curStage = '' }
  const s = l.match(/^\*\*(Initial|Follow-up \d|Reactivation)\*\*/); if (s) { flush(); curStage = s[1] }
  if (l.startsWith('> ')) {
    const t = l.slice(2)
    buf.push(t)
    for (const re of BANNED) if (re.test(t)) { console.log(`BANNED ${re} :: ${cat} / ${curStage} :: ${t}`); bad++ }
  }
}
flush()
for (const [k, v] of Object.entries(wc)) {
  const w = v.map((x) => x.words)
  console.log(`${k.padEnd(13)} n=${v.length}  min=${Math.min(...w)}  max=${Math.max(...w)}`)
}
console.log(bad === 0 ? '\nNO BANNED WORDING, ALL REMINDERS PRESENT' : `\n${bad} PROBLEM(S)`)
