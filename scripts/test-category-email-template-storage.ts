import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INITIAL_EMAIL_MODES, SETTINGS_DEFAULTS, isInitialEmailMode } from '../src/lib/settingsDefaults'
import { EMAIL_TEMPLATE_TYPES } from '../src/lib/email-template-types'

const root = resolve(__dirname, '..')
const migration = readFileSync(resolve(root, 'supabase/migrations/037_category_email_template_storage.sql'), 'utf8')

assert.deepEqual(INITIAL_EMAIL_MODES, ['ai_personalised', 'template'])
assert.equal(SETTINGS_DEFAULTS.initial_email_mode.value, 'ai_personalised')
assert.equal(isInitialEmailMode('ai_personalised'), true)
assert.equal(isInitialEmailMode('template'), true)
assert.equal(isInitialEmailMode('unsupported'), false)

assert.deepEqual(EMAIL_TEMPLATE_TYPES, [
  'initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation',
])

assert.match(migration, /category_id UUID NOT NULL REFERENCES categories\(id\) ON DELETE CASCADE/)
assert.match(migration, /UNIQUE \(category_id, template_type\)/)
assert.match(migration, /FROM categories\s+CROSS JOIN/)
assert.doesNotMatch(migration, /INSERT INTO categories/i)
assert.match(migration, /ON CONFLICT \(category_id, template_type\) DO UPDATE SET/)
assert.match(migration, /COALESCE\(category_email_templates\.body_template, EXCLUDED\.body_template\)/)
assert.doesNotMatch(migration, /\(\s*'initial_pitch',\s*'Re:/)

assert.match(migration, /'initial_email_mode',\s*'ai_personalised'/)
assert.match(migration, /ON CONFLICT \(key\) DO NOTHING/)
assert.match(migration, /value IN \('ai_personalised', 'template'\)/)

assert.match(migration, /ADD COLUMN generation_source TEXT/)
assert.match(migration, /generation_source IS NULL OR generation_source IN \('ai', 'template'\)/)
assert.doesNotMatch(migration, /UPDATE emails[\s\S]*generation_source/i)

assert.match(migration, /lower\(btrim\(name\)\)/)
assert.match(migration, /WHERE type = 'initial_pitch' AND status = 'pending_send'/)
assert.match(migration, /IF EXISTS \([\s\S]*HAVING count\(\*\) > 1[\s\S]*RAISE NOTICE/)

for (const wording of [
  'I emailed you last week but it may not have reached you.',
  "I was asking whether you'd want to do a collab with us.",
  'Would you be interested?',
  'Checking once more in case my earlier emails got buried.',
  "Is a collab something you'd be interested in? A yes or no is all I need.",
  "If a collab is something you'd want to look at later, reply any time and I'll pick it back up.",
  'I emailed you about a collab a few months back and never heard anything. {{reactivation_context}}',
]) {
  assert.ok(migration.includes(wording), `migration preserves: ${wording}`)
}

for (const path of [
  'src/ai/email-generation.ts',
  'src/ai/workflows.ts',
  'src/lib/followup-email-templates.ts',
  'src/lib/followup-generation.ts',
  'src/lib/write-lead.ts',
  'agents/writer.ts',
  'trigger/daily-pipeline.ts',
]) {
  const source = readFileSync(resolve(root, path), 'utf8')
  assert.equal(source.includes('category_email_templates'), false, `${path} must not read new template storage yet`)
  assert.equal(source.includes('initial_email_mode'), false, `${path} must not route on Initial Email Mode yet`)
  assert.equal(source.includes('generation_source'), false, `${path} must not populate generation_source yet`)
}

console.log('Category email template storage checks passed')
