import { NextResponse } from 'next/server'
import { runFinderAgent } from '../../../../../agents/finder'
import { runResearcherAgent } from '../../../../../agents/researcher'
import { runWriterAgent } from '../../../../../agents/writer'
import { runSenderAgent } from '../../../../../agents/sender'

export const maxDuration = 300

export async function POST() {
  let step = 'finder'
  try {
    const leadsFound = await runFinderAgent()

    step = 'researcher'
    const leadsEnriched = await runResearcherAgent()

    step = 'writer'
    await runWriterAgent()

    step = 'sender'
    const { sent: emailsSent, failed: emailsFailed } = await runSenderAgent()

    return NextResponse.json({
      leads_found: leadsFound,
      leads_enriched: leadsEnriched,
      emails_sent: emailsSent,
      emails_failed: emailsFailed,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] step="${step}" error:`, err)
    return NextResponse.json({ error: message, step }, { status: 500 })
  }
}
