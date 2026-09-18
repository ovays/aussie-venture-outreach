import { createClient } from '@supabase/supabase-js'
import { validateV2DeploymentEnvironment } from '../src/lib/v2-runtime-safety'

validateV2DeploymentEnvironment()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
if (!key) throw new Error('V2 synthetic seed requires SUPABASE_SERVICE_ROLE_KEY.')
const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

const ids = {
  categories: ['91000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002'],
  suburbs: ['92000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000003'],
  leads: ['93000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000003', '93000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000005'],
  emails: ['94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000003'],
  followUps: ['95000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002'],
}

function check(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`${operation} failed: ${error.message}`)
}

async function reset(): Promise<void> {
  check((await db.from('follow_ups').delete().in('id', ids.followUps)).error, 'delete synthetic follow-ups')
  check((await db.from('emails').delete().in('id', ids.emails)).error, 'delete synthetic emails')
  check((await db.from('leads').delete().in('id', ids.leads)).error, 'delete synthetic leads')
  check((await db.from('category_email_templates').delete().in('category_id', ids.categories)).error, 'delete synthetic templates')
  check((await db.from('city_suburbs').delete().in('id', ids.suburbs)).error, 'delete synthetic suburbs')
  check((await db.from('categories').delete().in('id', ids.categories)).error, 'delete synthetic categories')
  check((await db.from('settings').delete().eq('key', 'v2_synthetic_seed_marker')).error, 'delete synthetic marker')
}

async function seed(): Promise<void> {
  await reset()
  check((await db.from('categories').upsert([
    { id: ids.categories[0], name: 'Synthetic Bakeries', content_type: 'remote', search_keywords: ['synthetic bakery'], status: 'active' },
    { id: ids.categories[1], name: 'Synthetic Cafes', content_type: 'visit', search_keywords: ['synthetic cafe'], status: 'active' },
  ])).error, 'seed categories')
  check((await db.from('city_suburbs').upsert([
    { id: ids.suburbs[0], city: 'Sydney', suburb: 'Testville', priority: 1, active: true },
    { id: ids.suburbs[1], city: 'Melbourne', suburb: 'Example Park', priority: 2, active: true },
    { id: ids.suburbs[2], city: 'Brisbane', suburb: 'Fixture Bay', priority: 3, active: true },
  ])).error, 'seed suburbs')
  check((await db.from('category_email_templates').upsert([
    { id: '91500000-0000-0000-0000-000000000001', category_id: ids.categories[0], template_type: 'initial_pitch', subject_template: 'Synthetic hello to {{business_name}}', body_template: 'This is provider-free synthetic test content.' },
    { id: '91500000-0000-0000-0000-000000000002', category_id: ids.categories[0], template_type: 'follow_up_1', subject_template: 'Synthetic follow-up', body_template: 'Synthetic follow-up only; never send.' },
  ])).error, 'seed templates')
  const statuses = ['new', 'researched', 'email_ready', 'contacted', 'interested']
  check((await db.from('leads').upsert(ids.leads.map((id, index) => ({
    id,
    business_name: `Synthetic Business ${index + 1}`,
    category_id: ids.categories[index % ids.categories.length],
    category_name: index % 2 === 0 ? 'Synthetic Bakeries' : 'Synthetic Cafes',
    city: index % 2 === 0 ? 'Sydney' : 'Melbourne',
    suburb: index % 2 === 0 ? 'Testville' : 'Example Park',
    email: `lead${index + 1}@example.test`,
    website: `https://business-${index + 1}.example.test`,
    status: statuses[index],
    source: 'manual',
    description: 'SYNTHETIC_V2_TEST_DATA',
  })))).error, 'seed leads')
  check((await db.from('emails').upsert([
    { id: ids.emails[0], lead_id: ids.leads[2], type: 'initial_pitch', subject: 'Synthetic draft', body_html: '<p>Synthetic only</p>', body_text: 'Synthetic only', status: 'pending_send', generation_source: 'template' },
    { id: ids.emails[1], lead_id: ids.leads[3], type: 'initial_pitch', subject: 'Synthetic historical email', body_html: '<p>Synthetic only</p>', body_text: 'Synthetic only', status: 'sent', sent_at: '2026-01-01T00:00:00.000Z', resend_id: 'synthetic-v2-never-sent-1', generation_source: 'template' },
    { id: ids.emails[2], lead_id: ids.leads[4], type: 'follow_up_1', subject: 'Synthetic follow-up draft', body_html: '<p>Synthetic only</p>', body_text: 'Synthetic only', status: 'pending_send', generation_source: 'template' },
  ])).error, 'seed emails')
  check((await db.from('follow_ups').upsert([
    { id: ids.followUps[0], lead_id: ids.leads[3], follow_up_number: 1, scheduled_at: '2099-01-01T00:00:00.000Z', status: 'scheduled' },
    { id: ids.followUps[1], lead_id: ids.leads[4], follow_up_number: 2, scheduled_at: '2099-01-02T00:00:00.000Z', status: 'cancelled', email_id: ids.emails[2] },
  ])).error, 'seed follow-ups')
  check((await db.from('settings').upsert({ key: 'v2_synthetic_seed_marker', value: 'SYNTHETIC_V2_ONLY', description: 'Removable Prompt 14 test-data marker' }, { onConflict: 'key' })).error, 'seed marker')
}

async function main(): Promise<void> {
  if (process.argv.includes('--reset')) {
    await reset()
    console.log('REACHAGENT_V2_SYNTHETIC_RESET_PASS')
  } else {
    await seed()
    console.log('REACHAGENT_V2_SYNTHETIC_SEED_PASS')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
