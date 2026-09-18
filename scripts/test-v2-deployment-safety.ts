import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KNOWN_V1_SUPABASE_PROJECT_REF,
  KNOWN_V1_TRIGGER_PROJECT_REF,
  assertV2SupabaseTarget,
  assertV2TriggerDeploymentTarget,
  readV2GateState,
  validateV2DeploymentEnvironment,
} from '../src/lib/v2-runtime-safety'
import { readV2BrowserEnvironment } from '../src/lib/v2-browser-environment'
import {
  assertFinderScheduleEnabled,
  assertHostingerMutationsEnabled,
  assertOutreachSendEnabled,
  assertTriggerJobsEnabled,
} from '../src/lib/side-effect-safety'

const safe = (overrides: Record<string, string | undefined> = {}) => ({
  REACHAGENT_ENV: 'v2_staging',
  NEXT_PUBLIC_REACHAGENT_RUNTIME: 'v2',
  NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-anon-value',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-value',
  TRIGGER_V2_PROJECT_REF: 'proj_v2synthetic',
  TRIGGER_SECRET_KEY: 'tr_dev_synthetic',
  V2_DEPLOYMENT_BRANCH: 'reachagent-v2-application',
  V2_VERCEL_PROJECT_NAME: 'reachagent-v2-staging',
  NEXT_PUBLIC_APP_URL: 'https://reachagent-v2-staging.example.test',
  REACHAGENT_NODE_VERSION: '24.0.0',
  ORCHESTRATOR_ENABLED: 'false',
  ORCHESTRATOR_SHADOW: 'false',
  OUTREACH_SEND_ENABLED: 'false',
  TRIGGER_JOBS_ENABLED: 'false',
  FINDER_SCHEDULE_ENABLED: 'false',
  HOSTINGER_MUTATIONS_ENABLED: 'false',
  SHADOW_OBSERVABILITY_WRITE_ENABLED: 'false',
  V2_SHADOW_ALLOW_PRODUCTION_READS: 'false',
  ...overrides,
})

validateV2DeploymentEnvironment(safe())
assert.doesNotThrow(() => assertV2SupabaseTarget(safe()))
assert.throws(() => assertV2SupabaseTarget(safe({ NEXT_PUBLIC_REACHAGENT_RUNTIME: undefined })), /NEXT_PUBLIC_REACHAGENT_RUNTIME=v2/)
assert.throws(() => assertV2SupabaseTarget(safe({ NEXT_PUBLIC_REACHAGENT_RUNTIME: 'v1' })), /NEXT_PUBLIC_REACHAGENT_RUNTIME=v2/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ NEXT_PUBLIC_SUPABASE_URL: `https://${KNOWN_V1_SUPABASE_PROJECT_REF}.supabase.co`, NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: KNOWN_V1_SUPABASE_PROJECT_REF })), /V1 production Supabase/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ TRIGGER_V2_PROJECT_REF: KNOWN_V1_TRIGGER_PROJECT_REF })), /V1 production Trigger/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: undefined })), /explicit matching V2 project/)
assert.throws(() => assertV2TriggerDeploymentTarget(safe({ TRIGGER_V2_PROJECT_REF: undefined })), /explicit V2 project reference/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ OUTREACH_SEND_ENABLED: 'true' })), /must remain false/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ TRIGGER_SECRET_KEY_PROD: 'must-not-be-used' })), /production credential alias/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ V2_SHADOW_SUPABASE_READ_KEY: 'must-not-be-present' })), /forbids all production-shadow credentials/)
assert.throws(() => validateV2DeploymentEnvironment(safe({ VERCEL_GIT_COMMIT_REF: 'main' })), /non-V2 branch/)
assert.deepEqual(Object.values(readV2GateState({})), Array(8).fill(false))

const prior = { ...process.env }
Object.assign(process.env, safe())
try {
  assert.throws(() => assertOutreachSendEnabled('test'), /OUTREACH_SEND_ENABLED=true/)
  assert.throws(() => assertTriggerJobsEnabled('test'), /TRIGGER_JOBS_ENABLED=true/)
  assert.throws(() => assertFinderScheduleEnabled('test'), /FINDER_SCHEDULE_ENABLED=true/)
  assert.throws(() => assertHostingerMutationsEnabled('test'), /HOSTINGER_MUTATIONS_ENABLED=true/)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in prior)) delete process.env[name]
  Object.assign(process.env, prior)
}

const resendSource = readFileSync('src/lib/resend.ts', 'utf8')
assert.ok(resendSource.indexOf("assertOutreachSendEnabled('Resend email delivery')") < resendSource.indexOf('const { messageId, headers }'))
const testEmailSource = readFileSync('src/app/api/test-email/route.ts', 'utf8')
assert.ok(testEmailSource.indexOf("assertOutreachSendEnabled('test email delivery')") < testEmailSource.indexOf('const resend = getResend()'))
const pipelineSource = readFileSync('trigger/daily-pipeline.ts', 'utf8')
assert.match(pipelineSource, /assertTriggerJobsEnabled\('scheduled daily pipeline'\)/)
assert.match(pipelineSource, /assertFinderScheduleEnabled\('scheduled Finder run'\)/)
const triggerConfig = readFileSync('trigger.config.ts', 'utf8')
assert.match(triggerConfig, /assertV2TriggerDeploymentTarget\(\)/)
assert.match(triggerConfig, /runtime: "node-24"/)
assert.doesNotMatch(triggerConfig, new RegExp(KNOWN_V1_TRIGGER_PROJECT_REF))
const seedSource = readFileSync('scripts/seed-v2-test-data.ts', 'utf8')
assert.ok(seedSource.indexOf('validateV2DeploymentEnvironment()') < seedSource.indexOf('createClient(url, key'))
assert.doesNotMatch(seedSource, /RESEND_API_KEY|OUTSCRAPER_API_KEY|GOOGLE_MAPS_API_KEY|HOSTINGER_MAIL_API_TOKEN/)
const diagnosticsSource = readFileSync('src/lib/deployment-diagnostics.ts', 'utf8')
assert.doesNotMatch(diagnosticsSource, /SERVICE_ROLE_KEY|SECRET_KEY|API_KEY|MAIL_API_TOKEN/)

const browserEnvironmentSource = readFileSync('src/lib/v2-browser-environment.ts', 'utf8')
for (const name of [
  'NEXT_PUBLIC_REACHAGENT_RUNTIME',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF',
]) {
  assert.match(browserEnvironmentSource, new RegExp(`process\\.env\\.${name}`))
}
assert.doesNotMatch(browserEnvironmentSource, /process\.env\s*\[/)
assert.doesNotMatch(browserEnvironmentSource, /\b(?:SUPABASE_SERVICE_ROLE_KEY|TRIGGER_SECRET_KEY|RESEND_API_KEY)\b/)
const browserClientSource = readFileSync('src/lib/supabase/client.ts', 'utf8')
assert.match(browserClientSource, /assertV2SupabaseTarget\(readV2BrowserEnvironment\(\)\)/)
assert.doesNotMatch(browserClientSource, /assertV2SupabaseTarget\(\s*\)/)

const priorPublicEnvironment = {
  NEXT_PUBLIC_REACHAGENT_RUNTIME: process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF: process.env.NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF,
}
try {
  process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME = 'v2'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co'
  process.env.NEXT_PUBLIC_REACHAGENT_V2_SUPABASE_PROJECT_REF = 'abcdefghijklmnopqrst'
  assert.doesNotThrow(() => assertV2SupabaseTarget(readV2BrowserEnvironment()))

  delete process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME
  assert.throws(() => assertV2SupabaseTarget(readV2BrowserEnvironment()), /NEXT_PUBLIC_REACHAGENT_RUNTIME=v2/)

  process.env.NEXT_PUBLIC_REACHAGENT_RUNTIME = 'not-v2'
  assert.throws(() => assertV2SupabaseTarget(readV2BrowserEnvironment()), /NEXT_PUBLIC_REACHAGENT_RUNTIME=v2/)
} finally {
  for (const [name, value] of Object.entries(priorPublicEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

console.log('REACHAGENT_V2_DEPLOYMENT_SAFETY_PASS')
