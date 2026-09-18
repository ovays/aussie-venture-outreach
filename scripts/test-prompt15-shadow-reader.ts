import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { decideNextAction, type LeadDecisionContext } from '@/domain/decision-engine'
import { createReadOnlySupabaseClient } from '@/domain/shadow-readiness/read-only-client'

const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe'
const DB = 'prompt15_shadow_rehearsal'
const DB_PORT = '55432'
const API_URL = 'http://127.0.0.1:55433'
const ROLE = 'reachagent_prompt15_shadow_reader'
const VIEW_OWNER = 'reachagent_prompt15_shadow_view_owner'
const PUBLISHABLE_KEY = 'sb_publishable_prompt15_local_rehearsal'
const JWT_SECRET = 'prompt15-local-only-jwt-secret-at-least-thirty-two-bytes'

function sql(statement: string): string {
  return execFileSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', 'postgres', '-d', DB, '-Atc', statement], { encoding: 'utf8' }).trim()
}

function sqlFails(statement: string, pattern: RegExp): void {
  try {
    sql(statement)
    assert.fail(`Expected SQL to fail: ${statement}`)
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? error)
    assert.match(detail, pattern)
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function signToken(role = ROLE, lifetimeSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ role, iat: now, exp: now + lifetimeSeconds, jti: randomUUID() }))
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function claims(token: string): { role?: string; iat?: number; exp?: number } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

function validateCredentials(apiKey: string, token: string): void {
  assert.match(apiKey, /^sb_publishable_/)
  assert.doesNotMatch(apiKey, /^sb_secret_/)
  assert.notEqual(apiKey, token)
  const payload = claims(token)
  assert.equal(payload.role, ROLE)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(payload.exp && payload.exp > now)
  assert.ok(payload.exp - now <= 7200)
}

async function main() {
  const expectedRoleFlags = 'f|f|f|f|f|f'
  for (const role of [ROLE, VIEW_OWNER]) {
    assert.equal(sql(`select rolcanlogin, rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname='${role}'`), expectedRoleFlags)
    assert.equal(sql(`select pg_has_role('${role}', 'authenticated', 'MEMBER')`), 'f')
    assert.equal(sql(`select pg_has_role('${role}', 'service_role', 'MEMBER')`), 'f')
    assert.equal(sql(`select pg_has_role('${role}', 'anon', 'MEMBER')`), 'f')
  }

  // This is the production blocker V2 must tolerate: public schema USAGE is
  // inherited through PostgreSQL PUBLIC by both custom roles.
  assert.equal(sql(`select exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname='public' and a.grantee=0 and a.privilege_type='USAGE')`), 't')
  assert.equal(sql(`select has_schema_privilege('${ROLE}', 'public', 'USAGE')`), 't')
  assert.equal(sql(`select has_schema_privilege('${VIEW_OWNER}', 'public', 'USAGE')`), 't')
  assert.equal(sql(`select has_schema_privilege('${ROLE}', 'reachagent_prompt15_shadow', 'USAGE')`), 't')
  assert.equal(sql(`select has_schema_privilege('${ROLE}', 'reachagent_prompt15_shadow', 'CREATE')`), 'f')
  assert.equal(sql(`select has_schema_privilege('${VIEW_OWNER}', 'reachagent_prompt15_shadow', 'USAGE')`), 'f')
  assert.equal(sql(`select pg_has_role('${ROLE}', 'authenticated', 'MEMBER')`), 'f')
  assert.equal(sql(`select pg_has_role('${ROLE}', 'service_role', 'MEMBER')`), 'f')
  assert.equal(sql(`select pg_has_role('authenticator', '${ROLE}', 'MEMBER')`), 't')
  assert.equal(sql(`select pg_has_role('authenticator', '${VIEW_OWNER}', 'MEMBER')`), 'f')
  assert.equal(sql(`select pg_has_role('${ROLE}', '${VIEW_OWNER}', 'MEMBER')`), 'f')

  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('${ROLE}', c.oid, 'SELECT')`), '0')
  assert.equal(sql(`select count(*) from information_schema.column_privileges where grantee='${ROLE}' and table_schema='public' and privilege_type='SELECT'`), '0')
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('${VIEW_OWNER}', c.oid, 'SELECT')`), '0')
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relowner=(select oid from pg_roles where rolname='${VIEW_OWNER}')`), '0')
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity`), '0')
  assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and policyname like 'prompt15_shadow_%' and roles=array['reachagent_prompt15_shadow_view_owner']::name[]`), '9')
  assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and policyname like 'prompt15_shadow_%' and roles && array['reachagent_prompt15_shadow_reader']::name[]`), '0')
  assert.equal(sql(`select count(*) from pg_views where schemaname='reachagent_prompt15_shadow' and viewowner='${VIEW_OWNER}'`), '7')
  assert.equal(sql(`select count(*) from information_schema.role_table_grants where grantee='${ROLE}' and table_schema='reachagent_prompt15_shadow' and privilege_type='SELECT'`), '7')
  assert.equal(sql(`select count(*) from information_schema.role_table_grants where grantee='${ROLE}' and table_schema='reachagent_prompt15_shadow' and privilege_type<>'SELECT'`), '0')
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='reachagent_prompt15_shadow' and c.relkind='v' and coalesce(c.reloptions,'{}') @> array['security_invoker=true']`), '0')
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='reachagent_prompt15_shadow' and c.relkind='v' and coalesce(c.reloptions,'{}') @> array['security_barrier=true']`), '7')

  const ownerColumns = sql(`select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name) from information_schema.column_privileges where grantee='${VIEW_OWNER}' and table_schema='public' and privilege_type='SELECT'`)
  assert.equal(ownerColumns, [
    'activity_log.created_at','activity_log.event_type','activity_log.lead_id','activity_log.metadata',
    'categories.id',
    'category_email_templates.body_template','category_email_templates.category_id','category_email_templates.subject_template','category_email_templates.template_type',
    'deals.lead_id',
    'emails.created_at','emails.lead_id','emails.replied_at','emails.sent_at','emails.status','emails.type',
    'lead_data_quality_flags.issue_type','lead_data_quality_flags.lead_id','lead_data_quality_flags.status',
    'leads.business_name','leads.category_id','leads.category_name','leads.city','leads.delivery_suppressed_emails','leads.email','leads.id','leads.normalized_email','leads.outreach_suppressed_at','leads.outreach_suppression_reason','leads.reactivation_sent_at','leads.source','leads.status','leads.updated_at','leads.website',
    'recipient_outreach_ownership.normalized_email','recipient_outreach_ownership.owner_lead_id',
    'settings.key','settings.value',
  ].join(','))

  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.lead_facts`), '2')
  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.email_facts`), '1')
  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.decision_settings`), '8')
  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.mode_snapshots`), '1')
  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.duplicate_flags`), '1')
  assert.equal(sql(`set role ${ROLE}; select count(*) from reachagent_prompt15_shadow.deal_leads`), '1')
  assert.equal(sql(`set role ${ROLE}; select template_ready from reachagent_prompt15_shadow.category_initial_template_facts`), 't')

  // PUBLIC schema USAGE does not help without table/column SELECT privileges.
  for (const table of sql(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname`).split(/\r?\n/)) {
    sqlFails(`set role ${ROLE}; select * from public.${table} limit 1`, /permission denied for table/i)
  }
  sqlFails(`set role ${ROLE}; select id from public.leads`, /permission denied for table leads/i)
  sqlFails(`set role ${ROLE}; select * from public.emails`, /permission denied for table emails/i)
  sqlFails(`set role ${ROLE}; select * from public.settings`, /permission denied for table settings/i)
  sqlFails(`set role ${ROLE}; select * from public.activity_log`, /permission denied for table activity_log/i)

  // The view owner can read only policy-allowed rows. The hidden draft proves
  // that normal view-owner execution is subject to RLS, independently of the
  // production view's own WHERE clause.
  assert.equal(sql(`set role ${VIEW_OWNER}; select count(*) from public.emails`), '1')
  assert.equal(sql(`set role ${VIEW_OWNER}; select count(*) from public.emails where type='internal_draft'`), '0')
  assert.equal(sql(`set role ${VIEW_OWNER}; select count(*) from public.settings`), '8')
  assert.equal(sql(`set role ${VIEW_OWNER}; select count(*) from public.activity_log`), '1')
  assert.equal(sql(`set role ${VIEW_OWNER}; select count(*) from public.lead_data_quality_flags`), '1')
  sqlFails(`set role ${VIEW_OWNER}; set row_security=off; select count(*) from public.emails`, /query would be affected by row-level security/i)
  sqlFails(`set role ${VIEW_OWNER}; select subject from public.emails`, /permission denied for table emails/i)
  sqlFails(`set role ${VIEW_OWNER}; select deal_value from public.deals`, /permission denied for table deals/i)

  sqlFails(`set role ${ROLE}; insert into reachagent_prompt15_shadow.lead_facts(id) values ('90000000-0000-0000-0000-000000000001')`, /permission denied|cannot insert/i)
  sqlFails(`set role ${ROLE}; update reachagent_prompt15_shadow.lead_facts set status='dead'`, /permission denied|cannot update/i)
  sqlFails(`set role ${ROLE}; insert into public.settings(key,value) values ('x','x') on conflict(key) do update set value=excluded.value`, /permission denied for table settings/i)
  sqlFails(`set role ${ROLE}; delete from reachagent_prompt15_shadow.lead_facts`, /permission denied|cannot delete/i)
  sqlFails(`set role ${ROLE}; truncate public.leads`, /permission denied for table leads/i)
  sqlFails(`set role ${ROLE}; select nextval('public.danger_sequence')`, /permission denied for sequence danger_sequence/i)
  sqlFails(`set role ${ROLE}; select public.claim_recipient_outreach('20000000-0000-0000-0000-000000000001')`, /permission denied for function claim_recipient_outreach/i)
  sqlFails(`set role ${ROLE}; lock table public.leads in access exclusive mode`, /permission denied for table leads/i)
  sqlFails(`set role ${ROLE}; select * from public.ai_provider_credentials`, /permission denied for table ai_provider_credentials/i)

  for (const role of [ROLE, VIEW_OWNER]) {
    assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and (has_table_privilege('${role}',c.oid,'INSERT') or has_table_privilege('${role}',c.oid,'UPDATE') or has_table_privilege('${role}',c.oid,'DELETE') or has_table_privilege('${role}',c.oid,'TRUNCATE'))`), '0')
    assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','reachagent_prompt15_shadow') and c.relkind='S' and (has_sequence_privilege('${role}',c.oid,'USAGE') or has_sequence_privilege('${role}',c.oid,'SELECT') or has_sequence_privilege('${role}',c.oid,'UPDATE'))`), '0')
    assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','reachagent_prompt15_shadow') and has_function_privilege('${role}',p.oid,'EXECUTE')`), '0')
  }
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='reachagent_prompt15_shadow' and (has_table_privilege('${ROLE}',c.oid,'INSERT') or has_table_privilege('${ROLE}',c.oid,'UPDATE') or has_table_privilege('${ROLE}',c.oid,'DELETE') or has_table_privilege('${ROLE}',c.oid,'TRUNCATE'))`), '0')
  sqlFails(`set role ${VIEW_OWNER}; update public.leads set status='dead'`, /permission denied for table leads/i)
  sqlFails(`set role ${VIEW_OWNER}; delete from public.emails`, /permission denied for table emails/i)
  sqlFails(`set role ${VIEW_OWNER}; truncate public.settings`, /permission denied for table settings/i)
  sqlFails(`set role ${VIEW_OWNER}; select nextval('public.danger_sequence')`, /permission denied for sequence danger_sequence/i)
  sqlFails(`set role ${VIEW_OWNER}; select public.claim_recipient_outreach('20000000-0000-0000-0000-000000000001')`, /permission denied for function claim_recipient_outreach/i)
  sqlFails(`set role ${VIEW_OWNER}; lock table public.leads in access exclusive mode`, /permission denied for table leads/i)
  sqlFails(`set role ${VIEW_OWNER}; update reachagent_prompt15_shadow.decision_settings set value='0'`, /permission denied for schema reachagent_prompt15_shadow|permission denied for table settings|cannot update view/i)

  // Existing application roles retain their original fixture behavior.
  assert.equal(sql(`set role authenticated; select count(*) from public.leads`), '2')
  sql(`set role authenticated; update public.leads set status=status where id='20000000-0000-0000-0000-000000000001'`)
  assert.equal(sql(`set role service_role; select count(*) from public.ai_provider_credentials`), '1')
  sqlFails(`set role anon; select count(*) from public.leads`, /permission denied/i)

  const token = signToken()
  validateCredentials(PUBLISHABLE_KEY, token)
  assert.throws(() => validateCredentials('sb_secret_forbidden', token))
  assert.throws(() => validateCredentials(PUBLISHABLE_KEY, signToken('service_role')))
  assert.throws(() => validateCredentials(PUBLISHABLE_KEY, signToken(ROLE, 7201)))

  const captured: Array<{ method: string; apikey: string | null; authorization: string | null }> = []
  const getOnlyFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`Prompt 15 network guard blocked ${method}`)
    const headers = new Headers(init?.headers)
    captured.push({ method, apikey: headers.get('apikey'), authorization: headers.get('Authorization') })
    // A hosted Supabase URL serves PostgREST below /rest/v1. The standalone
    // rehearsal binary serves the identical API at its root.
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    url.pathname = url.pathname.replace(/^\/rest\/v1(?=\/|$)/, '') || '/'
    return fetch(url, init)
  }

  const raw = createClient<any, 'reachagent_prompt15_shadow'>(API_URL, PUBLISHABLE_KEY, {
    db: { schema: 'reachagent_prompt15_shadow' },
    accessToken: async () => token,
    global: { fetch: getOnlyFetch },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const audit = { blockedMutationAttempts: 0, allowedMethodCalls: 0 }
  const client = createReadOnlySupabaseClient(raw as never, audit) as unknown as typeof raw

  const leadResult = await client.from('lead_facts').select('*').order('id')
  assert.equal(leadResult.error, null)
  assert.equal(leadResult.data?.length, 2)
  assert.deepEqual(Object.keys(leadResult.data?.[0] ?? {}).sort(), [
    'category_id','has_business_name','has_category_name','has_city','has_email',
    'has_website','id','reactivation_sent_at','recipient_ownership','source','status',
    'suppressed','updated_at',
  ].sort())
  assert.equal(JSON.stringify(leadResult.data).includes('@example.invalid'), false)

  const emailResult = await client.from('email_facts').select('*')
  assert.equal(emailResult.error, null)
  assert.equal(emailResult.data?.length, 1)
  assert.equal(JSON.stringify(emailResult.data).includes('SECRET CUSTOMER EMAIL BODY'), false)

  const settingsResult = await client.from('decision_settings').select('*')
  assert.equal(settingsResult.error, null)
  assert.equal(settingsResult.data?.length, 8)
  assert.equal(settingsResult.data?.some((row: { key: string }) => row.key === 'openai_api_key'), false)

  const modeResult = await client.from('mode_snapshots').select('*')
  assert.equal(modeResult.error, null)
  assert.equal(JSON.stringify(modeResult.data).includes('SECRET PROMPT'), false)

  const templateResult = await client.from('category_initial_template_facts').select('*')
  assert.equal(templateResult.error, null)
  assert.equal(JSON.stringify(templateResult.data).includes('private template body'), false)

  const duplicateResult = await client.from('duplicate_flags').select('*')
  assert.equal(duplicateResult.error, null)
  const dealResult = await client.from('deal_leads').select('*')
  assert.equal(dealResult.error, null)

  const exposedPayload = JSON.stringify([
    leadResult.data, emailResult.data, settingsResult.data, modeResult.data,
    duplicateResult.data, dealResult.data, templateResult.data,
  ])
  for (const forbidden of [
    'owner@example.invalid', 'Visible Business', 'Shared Recipient',
    '+61 400', 'Secret Street', 'Sydney', 'visible.invalid', 'shared.invalid',
    'SECRET SUBJECT', 'SECRET CUSTOMER EMAIL BODY', 'HIDDEN DRAFT',
    'provider-secret-id', 'SECRET PROMPT', 'SECRET AI PROMPT',
    'SECRET AI RESPONSE', 'private template body', 'PROVIDER-CREDENTIAL',
    'sk-secret-provider-key', 'SECRET SYSTEM PROMPT',
  ]) {
    assert.equal(exposedPayload.includes(forbidden), false, `exposed forbidden value: ${forbidden}`)
  }

  // Reconstruct one complete Decision Engine context using only derived facts.
  const lead = leadResult.data?.[0]
  assert.ok(lead)
  const settings = new Map(settingsResult.data?.map((row: { key: string; value: string }) => [row.key, row.value]))
  const initial = emailResult.data?.find((row: { lead_id: string; type: string }) => row.lead_id === lead.id && row.type === 'initial_pitch')
  const template = templateResult.data?.find((row: { category_id: string }) => row.category_id === lead.category_id)
  const required = new Set<string>(template?.required_placeholders ?? [])
  const fieldAvailable: Record<string, boolean> = {
    business_name: lead.has_business_name,
    contact_name: false,
    category_name: lead.has_category_name,
    city: lead.has_city,
    website: lead.has_website,
  }
  const context: LeadDecisionContext = {
    leadId: lead.id,
    status: lead.status,
    email: lead.has_email ? 'redacted@shadow.invalid' : null,
    duplicate: duplicateResult.data?.some((row: { lead_id: string }) => row.lead_id === lead.id) ?? false,
    suppressed: lead.suppressed,
    dealState: dealResult.data?.some((row: { lead_id: string }) => row.lead_id === lead.id) ? 'closed' : 'none',
    initialEmailMode: modeResult.data?.find((row: { lead_id: string }) => row.lead_id === lead.id)?.initial_email_mode ?? settings.get('initial_email_mode') ?? 'ai_personalised',
    research: { contactDiscoveryComplete: lead.has_email || lead.status !== 'new', personalisationComplete: lead.status !== 'new', canSupplyTemplateFields: false },
    template: { available: template?.template_ready === true, requiredDataAvailable: [...required].every((name) => fieldAvailable[name] === true) },
    initialEmail: initial?.sent_at ? { state: 'sent', sentAt: initial.sent_at } : { state: 'missing', sentAt: null },
    followUps: {
      followUp1: { state: 'missing', sentAt: null },
      followUp2: { state: 'missing', sentAt: null },
      followUp3: { state: 'missing', sentAt: null },
    },
    reply: { received: false, classification: null },
    reactivation: { enabled: settings.get('reactivation_enabled') === 'true', sentAt: lead.reactivation_sent_at },
    schedule: {
      followUp1Days: Number(settings.get('follow_up_1_days')),
      followUp2Days: Number(settings.get('follow_up_2_days')),
      followUp3Days: Number(settings.get('follow_up_3_days')),
      deadLeadDays: Number(settings.get('dead_lead_days')),
      reactivationDelayDays: Number(settings.get('reactivation_delay_days')),
      deadAfterReactivationDays: Number(settings.get('dead_after_reactivation_days')),
    },
    asOf: new Date().toISOString(),
    manualOverride: null,
    operationalFacts: {
      categoryIdPresent: !!lead.category_id,
      hasUsableCategoryContext: !!lead.category_id && !!template,
      manualSource: lead.source === 'manual',
      recipientOwnership: lead.recipient_ownership,
      openDuplicateFlag: false,
    },
  }
  assert.equal(decideNextAction(context).action, 'STOP')

  const unrelated = await client.from('ai_provider_credentials').select('*')
  assert.ok(unrelated.error)
  const bodyColumn = await client.from('email_facts').select('body_html')
  assert.ok(bodyColumn.error)
  const rpcResponse = await fetch(`${API_URL}/rpc/claim_recipient_outreach`, {
    method: 'GET',
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Accept-Profile': 'reachagent_prompt15_shadow' },
  })
  assert.equal(rpcResponse.status, 404)

  assert.ok(captured.length >= 6)
  for (const request of captured) {
    assert.ok(request.method === 'GET' || request.method === 'HEAD')
    assert.equal(request.apikey, PUBLISHABLE_KEY)
    assert.equal(request.authorization, `Bearer ${token}`)
    assert.notEqual(request.apikey, token)
    assert.notEqual(request.authorization, `Bearer ${PUBLISHABLE_KEY}`)
  }

  assert.throws(() => client.from('lead_facts').insert({ id: randomUUID() }), /blocked Supabase mutation method: insert/)
  assert.throws(() => client.from('lead_facts').upsert({ id: randomUUID() }), /blocked Supabase mutation method: upsert/)
  assert.throws(() => client.from('lead_facts').update({ status: 'dead' }), /blocked Supabase mutation method: update/)
  assert.throws(() => client.from('lead_facts').delete(), /blocked Supabase mutation method: delete/)
  assert.throws(() => client.rpc('claim_recipient_outreach'), /blocked Supabase mutation method: rpc/)
  assert.equal(audit.blockedMutationAttempts, 5)

  const networkOnly = createClient<any, 'reachagent_prompt15_shadow'>(API_URL, PUBLISHABLE_KEY, {
    db: { schema: 'reachagent_prompt15_shadow' },
    accessToken: async () => token,
    global: { fetch: getOnlyFetch },
  })
  const blockedNetworkMutation = await networkOnly.from('lead_facts').insert({ id: randomUUID() })
  assert.match(blockedNetworkMutation.error?.message ?? '', /network guard blocked POST/i)

  console.log(JSON.stringify({
    status: 'PASS',
    publicSchemaUsageThroughPublic: true,
    readerUnderlyingTablePrivileges: 0,
    viewOwnerUnderlyingWritePrivileges: 0,
    viewOwnerUnderlyingColumnSelectPrivileges: ownerColumns.split(',').length,
    viewReads: 7,
    sqlWriteAndPrivilegeDenials: 22,
    rlsChecks: 6,
    clientMutationBlocks: audit.blockedMutationAttempts,
    postgrestRpcStatus: rpcResponse.status,
    capturedRequests: captured.length,
    reconstructedDecisionContext: true,
    credentialModel: 'publishable apikey + custom-role bearer JWT',
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
