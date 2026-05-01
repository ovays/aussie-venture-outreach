import { NextResponse } from 'next/server'
import { runFinderAgent } from '../../../../../agents/finder'
import { runResearcherAgent } from '../../../../../agents/researcher'
import { runWriterAgent } from '../../../../../agents/writer'
import { runSenderAgent } from '../../../../../agents/sender'

export const maxDuration = 300

export async function POST() {
  try {
    const leadsFound = await runFinderAgent()
    const leadsEnriched = await runResearcherAgent()
    const emailsWritten = await runWriterAgent()
    const { sent: emailsSent, failed: emailsFailed } = await runSenderAgent()

    return NextResponse.json({
      leads_found: leadsFound,
      leads_enriched: leadsEnriched,
      emails_written: emailsWritten,
      emails_sent: emailsSent,
      emails_failed: emailsFailed,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
