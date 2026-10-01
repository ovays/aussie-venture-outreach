import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { followUpOrderValid, onboardingDestination, parseOnboardingStep } from '../src/lib/onboarding'

const root=path.resolve(import.meta.dirname,'..')
const read=(file:string)=>fs.readFileSync(path.join(root,file),'utf8')
const migration=read('supabase-v2/migrations/00000000000020_customer_signup_and_onboarding.sql')
const signup=read('src/app/signup/page.tsx'), provision=read('src/app/api/workspace/provision/route.ts'), api=read('src/app/api/onboarding/route.ts')

assert.match(signup,/Full name/);assert.match(signup,/Business \/ workspace name/);assert.match(signup,/signUp/);assert.match(signup,/Check your email/)
assert.match(provision,/requireApiUser/);assert.doesNotMatch(provision,/request\.json/);assert.match(migration,/auth\.uid\(\)/);assert.match(migration,/pg_advisory_xact_lock/)
assert.match(migration,/provision_customer_workspace\(\)/);assert.match(migration,/REVOKE ALL ON FUNCTION public\.provision_customer_workspace\(\) FROM PUBLIC, anon/)
assert.match(migration,/external_beta/);assert.ok(migration.indexOf("INSERT INTO public.entitlement_profiles")<migration.indexOf('CREATE FUNCTION public.provision_customer_workspace'))
assert.match(migration,/INSERT INTO public\.workspace_members[\s\S]*'owner', 'active'/);assert.match(migration,/system_active', 'false'/)
assert.doesNotMatch(migration,/00000000-0000-0000-0000-000000000001/);assert.doesNotMatch(migration,/internal_beta/)
assert.match(api,/\.eq\('workspace_id',ws\.workspaceId\)/);assert.match(api,/status:'paused'/);assert.match(api,/workspace_invitations/)
assert.equal(parseOnboardingStep('7'),7);assert.equal(onboardingDestination('dashboard','in_progress'),'/onboarding');assert.equal(onboardingDestination('onboarding','completed'),'/dashboard')
assert.equal(followUpOrderValid({first:7,second:14,final:21,reconnect:90}),true);assert.equal(followUpOrderValid({first:14,second:7,final:21,reconnect:90}),false)
for(const forbidden of ['Finder','Researcher','Writer','Decision Engine','Orchestrator','follow_up_1','follow_up_2','follow_up_3'])assert.doesNotMatch(read('src/components/onboarding/OnboardingFlow.tsx'),new RegExp(forbidden))
console.log('Prompt 3 customer onboarding contract tests passed')
