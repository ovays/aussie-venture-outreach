import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  choosePreferredLead,
  claimRecipientOutreach,
  classifyDuplicateGroup,
  classifyEmailQuality,
  isProtectedFromAutoDelete,
  normalizeEmail,
} from '../src/lib/data-quality'

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')

type BackfillLead = {
  id: string
  normalizedEmail: string
  createdAt: string | null
  protected?: boolean
}

type BackfillEmail = {
  leadId: string
  status: string
  sentAt: string | null
  createdAt: string | null
}

type Ownership = {
  ownerLeadId: string
  claimedAt: string
  lastActivityAt: string
}

function simulateOwnershipBackfill(
  leads: BackfillLead[],
  emails: BackfillEmail[],
  existing: Map<string, Ownership>,
  now: string,
): Map<string, Ownership> {
  const result = new Map(existing)
  const recipients = [...new Set(leads.map((lead) => lead.normalizedEmail))].sort()

  for (const normalizedEmail of recipients) {
    if (result.has(normalizedEmail)) continue

    const candidates = leads
      .filter((lead) => lead.normalizedEmail === normalizedEmail)
      .map((lead) => {
        const history = emails.filter(
          (email) => email.leadId === lead.id && ['sent', 'email_sync_failed'].includes(email.status),
        )
        const activity = history
          .map((email) => email.sentAt ?? email.createdAt)
          .filter((timestamp): timestamp is string => timestamp !== null)
          .sort()
        return {
          lead,
          hasHistory: history.length > 0,
          claimedAt: activity[0] ?? lead.createdAt ?? now,
          lastActivityAt: activity[activity.length - 1] ?? lead.createdAt ?? now,
        }
      })
      .filter((candidate) => candidate.hasHistory)
      .sort((a, b) =>
        Number(Boolean(b.lead.protected)) - Number(Boolean(a.lead.protected))
        || a.claimedAt.localeCompare(b.claimedAt)
        || (a.lead.createdAt ?? '').localeCompare(b.lead.createdAt ?? '')
        || a.lead.id.localeCompare(b.lead.id)
      )

    const selected = candidates[0]
    if (selected) {
      result.set(normalizedEmail, {
        ownerLeadId: selected.lead.id,
        claimedAt: selected.claimedAt,
        lastActivityAt: selected.lastActivityAt,
      })
    }
  }

  return result
}

async function main() {
  assert.equal(normalizeEmail(' Admin@LocalForYou.com '), 'admin@localforyou.com')
  assert.equal(normalizeEmail('   '), null)

  const duplicate = classifyDuplicateGroup([
    { id: 'a', business_name: 'Port AdVenture Cruises', website: 'https://portadventurecruises.com.au', phone: '02 1111 2222' },
    { id: 'b', business_name: 'Port Adventure Cruises', website: 'portadventurecruises.com.au/', phone: '(02) 1111 2222' },
  ])
  assert.equal(duplicate.issueType, 'duplicate_lead')
  assert(duplicate.reasons.includes('same_normalized_business_name'))

  const shared = classifyDuplicateGroup([
    { id: 'a', business_name: 'Thai Hoxton Austral', address: 'Austral NSW' },
    { id: 'b', business_name: 'Boom Boom Thai', address: 'Hoxton Park NSW' },
    { id: 'c', business_name: 'Thaigerwood Thai Restaurant and cafe', address: 'Sutherland NSW' },
    { id: 'd', business_name: 'Patchai Thai Restaurant', address: 'Engadine NSW' },
    { id: 'e', business_name: "Sa-Ne' Thai Cuisine Sutherland", address: 'Sutherland NSW' },
  ])
  assert.equal(shared.issueType, 'shared_email')

  assert.equal(classifyEmailQuality('user@domain.com').issueType, 'placeholder_email')
  assert.equal(classifyEmailQuality('john@doe.com').issueType, 'placeholder_email')
  assert.equal(classifyEmailQuality('0123456789abcdef01234567@o123.ingest.us.sentry.io').issueType, 'technical_email')
  assert.equal(classifyEmailQuality('bad address').issueType, 'invalid_email')
  assert.equal(classifyEmailQuality('info@company.com').issueType, null)
  assert.equal(classifyEmailQuality('marketing@company.com').issueType, null)

  const protectedLead = { id: 'reply', business_name: 'Reply Co', status: 'replied', hasReply: true, outreachCount: 3 }
  const emptyLead = { id: 'empty', business_name: 'Reply Co', status: 'new' }
  assert.equal(isProtectedFromAutoDelete(protectedLead), true)
  assert.equal(choosePreferredLead([emptyLead, protectedLead])?.id, 'reply')

  const blocked = await claimRecipientOutreach({
    rpc: async () => ({ data: { allowed: false, owner_lead_id: 'owner-a', normalized_email: 'admin@localforyou.com', reason: 'email_already_contacted' }, error: null }),
  } as never, 'lead-b', 'initial')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.ownerLeadId, 'owner-a')

  const owner = await claimRecipientOutreach({
    rpc: async () => ({ data: { allowed: true, owner_lead_id: 'owner-a', normalized_email: 'admin@localforyou.com', reason: null }, error: null }),
  } as never, 'owner-a', 'follow_up')
  assert.equal(owner.allowed, true)

  const migration = read('supabase/migrations/049_data_quality_and_recipient_ownership.sql')
  assert(migration.includes('CREATE INDEX IF NOT EXISTS leads_normalized_email_idx'))
  assert(migration.includes('pg_advisory_xact_lock'))
  assert(migration.includes('recipient_outreach_ownership'))
  assert(migration.includes('protected_from_auto_delete'))
  assert(migration.includes('preferred_lead_id'))
  assert(migration.includes('get_data_quality_summary'))
  assert(!/\bDELETE\s+FROM\s+leads\b/i.test(migration), 'P1 migration must not delete leads')

  const ownershipInserts = migration.match(/INSERT\s+INTO\s+recipient_outreach_ownership\b/gi) ?? []
  assert.equal(ownershipInserts.length, 2, 'every ownership INSERT is covered by this audit')
  assert(
    /MIN\(COALESCE\(e\.sent_at,\s*e\.created_at\)\)\s+AS\s+earliest_outreach_at/i.test(migration)
      && /COALESCE\(earliest_outreach_at,\s*lead_created_at,\s*now\(\)\)\s+AS\s+claimed_at/i.test(migration),
    'backfill claimed_at must use earliest sent/email history, then lead creation, then now()',
  )
  assert(
    /MAX\(COALESCE\(e\.sent_at,\s*e\.created_at\)\)\s+AS\s+latest_outreach_at/i.test(migration)
      && /COALESCE\(latest_outreach_at,\s*lead_created_at,\s*now\(\)\)\s+AS\s+last_activity_at/i.test(migration),
    'backfill last_activity_at must describe latest known history and remain non-null',
  )
  assert(
    /INSERT\s+INTO\s+recipient_outreach_ownership[\s\S]*?ON\s+CONFLICT\s*\(normalized_email\)\s+DO\s+NOTHING/i.test(migration),
    'backfill must preserve existing ownership on rerun',
  )
  assert(
    /INSERT\s+INTO\s+recipient_outreach_ownership\s*\(normalized_email,\s*owner_lead_id,\s*metadata\)[\s\S]*?ON\s+CONFLICT\s*\(normalized_email\)\s+DO\s+UPDATE\s+SET\s+owner_lead_id\s*=\s*COALESCE\(recipient_outreach_ownership\.owner_lead_id,\s*EXCLUDED\.owner_lead_id\)/i.test(migration),
    'live claims must not overwrite a valid existing owner',
  )
  assert.equal((migration.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi) ?? []).length, 2, 'migration tables are rerunnable')
  assert.equal((migration.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi) ?? []).length, 4, 'migration indexes are rerunnable')
  assert.equal((migration.match(/CREATE\s+TRIGGER\s+/gi) ?? []).length, (migration.match(/DROP\s+TRIGGER\s+IF\s+EXISTS/gi) ?? []).length, 'triggers are replaced without duplication')
  assert.equal((migration.match(/CREATE\s+POLICY\s+/gi) ?? []).length, (migration.match(/DROP\s+POLICY\s+IF\s+EXISTS/gi) ?? []).length, 'policies are replaced without duplication')
  assert(!/CREATE\s+FUNCTION\b/i.test(migration), 'functions use CREATE OR REPLACE on rerun')
  assert(!/ALTER\s+TABLE\s+leads\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i.test(migration), 'lead columns use ADD COLUMN IF NOT EXISTS')
  assert(/claimed_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i.test(migration), 'claimed_at remains NOT NULL with a safe default for live claims')

  const historicalLeads: BackfillLead[] = [
    { id: 'lead-null-sent', normalizedEmail: 'booking@example.test', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'lead-only-null-sent', normalizedEmail: 'contact@example.test', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'lead-all-null', normalizedEmail: 'fallback@example.test', createdAt: null },
  ]
  const historicalEmails: BackfillEmail[] = [
    { leadId: 'lead-null-sent', status: 'sent', sentAt: '2026-01-15T00:00:00.000Z', createdAt: '2026-01-14T00:00:00.000Z' },
    { leadId: 'lead-null-sent', status: 'email_sync_failed', sentAt: null, createdAt: '2026-02-01T00:00:00.000Z' },
    { leadId: 'lead-only-null-sent', status: 'email_sync_failed', sentAt: null, createdAt: '2026-02-02T00:00:00.000Z' },
    { leadId: 'lead-all-null', status: 'email_sync_failed', sentAt: null, createdAt: null },
  ]
  const leadsBefore = structuredClone(historicalLeads)
  const firstBackfill = simulateOwnershipBackfill(historicalLeads, historicalEmails, new Map(), '2026-03-01T00:00:00.000Z')
  assert.equal(firstBackfill.get('booking@example.test')?.claimedAt, '2026-01-15T00:00:00.000Z', 'claimed_at uses the earliest meaningful outreach timestamp')
  assert.equal(firstBackfill.get('booking@example.test')?.lastActivityAt, '2026-02-01T00:00:00.000Z', 'NULL sent_at falls back to email created_at without hiding later activity')
  assert.equal(firstBackfill.get('contact@example.test')?.claimedAt, '2026-02-02T00:00:00.000Z', 'a lead whose only historical sent_at is NULL receives email created_at as claimed_at')
  assert.equal(firstBackfill.get('fallback@example.test')?.claimedAt, '2026-03-01T00:00:00.000Z', 'now() is the final claimed_at fallback when all stored timestamps are NULL')
  assert([...firstBackfill.values()].every((ownership) => ownership.claimedAt != null), 'backfill cannot produce NULL claimed_at')

  const rerun = simulateOwnershipBackfill(historicalLeads, historicalEmails, firstBackfill, '2026-04-01T00:00:00.000Z')
  assert.deepEqual([...rerun], [...firstBackfill], 'rerunning the backfill is a no-op for existing ownership')

  const preserved = new Map<string, Ownership>([[
    'booking@example.test',
    { ownerLeadId: 'existing-owner', claimedAt: '2025-01-01T00:00:00.000Z', lastActivityAt: '2025-02-01T00:00:00.000Z' },
  ]])
  const withPreservedOwnership = simulateOwnershipBackfill(historicalLeads, historicalEmails, preserved, '2026-04-01T00:00:00.000Z')
  assert.deepEqual(withPreservedOwnership.get('booking@example.test'), preserved.get('booking@example.test'), 'backfill does not overwrite an existing ownership record')
  assert.deepEqual(historicalLeads, leadsBefore, 'backfill does not mutate or delete leads')

  const route = read('src/app/api/data-quality/route.ts')
  assert(/supabase\.rpc\('get_data_quality_report(?:_v2)?'/.test(route))
  assert(route.includes("supabase.rpc('get_data_quality_summary'"))
  assert(!route.includes(".from('leads')"), 'report route must not scan leads or perform per-row calls')

  const creationPaths = [
    read('agents/finder.ts'),
    read('src/app/api/leads/import/route.ts'),
    read('src/app/api/leads/route.ts'),
  ]
  assert(creationPaths[0].includes("from('leads').insert"), 'Finder creation path covered by the leads trigger')
  assert(creationPaths[1].includes('createLead(supabase'), 'CSV uses central createLead')
  assert(creationPaths[2].includes('createLead(supabase'), 'manual Add Lead uses central createLead')
  assert(migration.includes('CREATE TRIGGER leads_refresh_data_quality'), 'all lead inserts/updates are classified at the database boundary')

  for (const sendPath of ['agents/sender.ts', 'agents/followup.ts', 'agents/reactivation.ts', 'src/app/api/leads/bulk/route.ts', 'src/app/api/leads/[id]/resend/route.ts']) {
    assert(read(sendPath).includes('claimRecipientOutreach'), `${sendPath} must enforce recipient ownership`)
  }

  console.log('Data-quality tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
