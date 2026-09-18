/**
 * Prompt 15 local rehearsal for the one-time sanitized snapshot.
 *
 * Rebuilds the disposable fixture, proves the SQL safety validator fails closed,
 * runs the exact production statement against schema-compatible local data, and
 * scans the result for anything that must never leave V1.
 *
 * Nothing in this file connects to V1 production.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { validateSnapshotQuery, validateSnapshotRows } from './prompt15-snapshot-safety'
import { compareSnapshot, buildReport, type SnapshotRow } from './prompt15-offline-comparison'

const PSQL = process.env.PROMPT15_PSQL ?? 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe'
const QUERY_PATH = 'scripts/prompt15-sanitized-snapshot.sql'
const FIXTURE_PATH = 'scripts/prompt15-snapshot-fixture.sql'
const OUTPUT_PATH = '.v2-local/prompt15-fixture-snapshot.json'
const CONNECTION = ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'prompt15_snapshot_fixture']

const psql = (args: string[]): string =>
  execFileSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...CONNECTION, ...args], { encoding: 'utf8' }).trim()

/** psql emits CRLF on Windows; split and trim so values compare cleanly. */
const psqlLines = (args: string[]): string[] =>
  psql(args).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

// ── 1. Rebuild the disposable fixture ───────────────────────────────────────
psql(['-f', FIXTURE_PATH])

// ── 2. The validator must fail closed ───────────────────────────────────────
const sql = readFileSync(QUERY_PATH, 'utf8')
const { queryHash } = validateSnapshotQuery(sql)

const rejected: Array<[string, string]> = [
  ['insert', 'insert into public.leads (id) values (gen_random_uuid()) returning id limit 100;'],
  ['update', 'update public.leads set status = \'dead\' returning id limit 100;'],
  ['delete', 'delete from public.leads returning id limit 100;'],
  ['create', 'create view v as select 1 limit 100;'],
  ['drop', 'drop table public.leads; select 1 limit 100;'],
  ['grant', 'grant select on public.leads to public; select 1 limit 100;'],
  ['revoke', 'revoke select on public.leads from public; select 1 limit 100;'],
  ['truncate', 'truncate public.leads; select 1 limit 100;'],
  ['copy', 'copy public.leads to stdout; select 1 limit 100;'],
  ['do block', 'do $$ begin end $$; select 1 limit 100;'],
  ['call', 'call public.claim_recipient_outreach(null); select 1 limit 100;'],
  ['comment', 'comment on table public.leads is \'x\'; select 1 limit 100;'],
  ['mutating rpc', 'select public.claim_recipient_outreach(id) from public.leads limit 100;'],
  ['sequence advance', 'select nextval(\'public.danger_sequence\') limit 100;'],
  ['advisory lock', 'select pg_advisory_lock(1) limit 100;'],
  ['second statement', 'select 1 limit 100; select 2;'],
  ['missing limit', 'select id from public.leads;'],
  ['oversized limit', 'with selected_ids as (select 1 limit 100) select 1 limit 500;'],
  ['comment-hidden mutation', '/* select */ delete from public.leads returning 1 limit 100;'],
  ['string-disguised keyword', "with selected_ids as (select 1 as lead_id limit 100) select 'drop table x' as note from selected_ids limit 100"],
]
let rejectedCount = 0
for (const [label, candidate] of rejected) {
  if (label === 'string-disguised keyword') {
    // A forbidden word inside a string literal is data, not a statement: it must pass.
    validateSnapshotQuery(candidate)
    continue
  }
  assert.throws(() => validateSnapshotQuery(candidate), new RegExp('.'), `Validator accepted ${label}`)
  rejectedCount++
}

// ── 3. Run the exact production statement against the fixture ───────────────
const statement = sql.trim().replace(/;$/, '')
const wrapped = `select coalesce(jsonb_agg(row_to_json(snapshot)), '[]'::jsonb)::text from (${statement}) snapshot`
const rows = JSON.parse(psql(['-Atc', wrapped])) as unknown
validateSnapshotRows(rows)
const snapshot = rows as unknown as SnapshotRow[]

// ── 4. Representativeness ───────────────────────────────────────────────────
const populationStatuses = psqlLines(['-Atc', 'select distinct status from public.leads order by 1'])
const populationTotal = Number(psql(['-Atc', 'select count(*) from public.leads']))
assert.ok(populationTotal > 100, 'Fixture must exceed the 100-row cap to exercise the sampler')
assert.equal(snapshot.length, 100, `Expected the hard cap of 100 rows, received ${snapshot.length}`)
assert.equal(new Set(snapshot.map((row) => row.lead_id)).size, 100, 'Snapshot contains duplicate leads')

const sampledStatuses = new Set(snapshot.map((row) => row.status))
for (const status of populationStatuses) {
  assert.ok(sampledStatuses.has(status), `Status ${status} exists in the population but is missing from the sample`)
}

const REQUIRED_COHORTS = [
  'suppression', 'duplicate_or_shared_recipient', 'template_mode', 'personalised_mode',
  'missing_research', 'completed_research', 'fu1_eligible', 'fu2_eligible', 'fu3_eligible',
  'reactivation_eligible', 'reply_present', 'null_category_id', 'send_uncertainty', 'template_ready',
  'broken_followup_sequence', 'post_reactivation_window', 'manual_source',
]
const sampledCohorts = new Set(snapshot.flatMap((row) => row.cohorts))
for (const cohort of REQUIRED_COHORTS) {
  assert.ok(sampledCohorts.has(cohort), `Cohort ${cohort} is missing from the representative sample`)
}
assert.ok(snapshot.every((row) => row.population_total === populationTotal - Number(psql(['-Atc',
  "select count(*) from public.leads where status is null or status not in ('new','researched','email_ready','contacted','replied','interested','negotiating','closed','closed_manual','dead')"]))),
  'Reported population total does not reconcile with the fixture')

// ── 5. Privacy: no fixture secret may appear anywhere ───────────────────────
const serialized = JSON.stringify(snapshot)
const secrets = psqlLines(['-Atc', `
  select value from (
    select business_name as value from public.leads
    union all select email from public.leads where email is not null
    union all select phone from public.leads where phone is not null
    union all select address from public.leads where address is not null
    union all select website from public.leads where website is not null
    union all select city from public.leads
    union all select subject from public.emails
    union all select body_text from public.emails
    union all select message_id from public.emails where message_id is not null
    union all select subject_template from public.category_email_templates
    union all select body_template from public.category_email_templates
    union all select api_key from public.ai_provider_credentials
    union all select metadata::text from public.activity_log where metadata is not null
    union all select notes from public.deals where notes is not null
  ) markers where length(value) > 3
`])
assert.ok(secrets.length > 50, 'Expected a large set of sensitive fixture markers to test against')
for (const secret of secrets) {
  assert.ok(!serialized.includes(secret), `Snapshot leaked a sensitive source value (${secret.slice(0, 12)}...)`)
}

// The row scanner itself must reject a poisoned snapshot.
for (const [label, poison] of [
  ['unapproved field', [{ ...snapshot[0], business_name: 'Bondi Spice House' }]],
  ['email value', [{ ...snapshot[0], recipient_ownership: 'owner@example.com' }]],
  ['url value', [{ ...snapshot[0], recipient_ownership: 'https://bondispice.com.au' }]],
  ['phone value', [{ ...snapshot[0], recipient_ownership: '+61 2 9130 1111' }]],
  ['oversized sample', Array.from({ length: 101 }, () => snapshot[0])],
] as Array<[string, unknown]>) {
  assert.throws(() => validateSnapshotRows(poison), new RegExp('.'), `Row scanner accepted ${label}`)
}

// ── 6. Offline comparison over the fixture sample ───────────────────────────
const cases = compareSnapshot(snapshot)
const report = buildReport(snapshot, cases, 'local-fixture')
assert.equal(report.classifications.BUG_IN_NEW_ENGINE, 0, 'Fixture rehearsal produced BUG_IN_NEW_ENGINE')
const failedRules = report.rules.filter((rule) => !rule.pass)
assert.equal(failedRules.length, 0, `Rule verification failed: ${failedRules.map((rule) => `${rule.id}:${rule.detail}`).join('; ')}`)

mkdirSync('.v2-local', { recursive: true })
writeFileSync(OUTPUT_PATH, `${JSON.stringify({ meta: { source: 'local-fixture', queryHash }, rows: snapshot }, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  status: 'PASS',
  queryHash,
  validatorRejections: rejectedCount,
  fixturePopulation: populationTotal,
  rows: snapshot.length,
  sampledStatuses: [...sampledStatuses].sort(),
  sampledCohorts: [...sampledCohorts].sort(),
  sensitiveMarkersTested: secrets.length,
  sensitiveMarkersLeaked: 0,
  classifications: report.classifications,
  rulesPassed: report.rules.length - failedRules.length,
  rulesFailed: failedRules.length,
  hardMaximum: 100,
}, null, 2))
