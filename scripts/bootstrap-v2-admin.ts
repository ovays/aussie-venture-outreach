import { createClient } from '@supabase/supabase-js'
import { validateV2DeploymentEnvironment } from '../src/lib/v2-runtime-safety'

validateV2DeploymentEnvironment()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
const email = process.env.V2_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.V2_BOOTSTRAP_ADMIN_PASSWORD
if (!serviceRoleKey || !email || !password || password.length < 12) {
  throw new Error('Set V2-only SUPABASE_SERVICE_ROLE_KEY, V2_BOOTSTRAP_ADMIN_EMAIL, and a 12+ character V2_BOOTSTRAP_ADMIN_PASSWORD.')
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: listed, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listError) throw new Error(listError.message)
  let user = listed.users.find((candidate) => candidate.email?.toLowerCase() === email)

  if (user) {
    const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
      user_metadata: { full_name: 'V2 Test Admin' },
    })
    if (error || !data.user) throw new Error(error?.message ?? 'V2 test admin update failed.')
    user = data.user
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'V2 Test Admin' },
    })
    if (error || !data.user) throw new Error(error?.message ?? 'V2 test admin creation failed.')
    user = data.user
  }

  const { error: profileError } = await supabase.from('profiles').upsert({
    id: user.id,
    email,
    full_name: 'V2 Test Admin',
    role: 'admin',
    is_active: true,
  }, { onConflict: 'id' })
  if (profileError) throw new Error(profileError.message)

  const { error: membershipError } = await supabase.from('workspace_members').upsert({
    workspace_id: '00000000-0000-0000-0000-000000000001',
    user_id: user.id,
    role: 'owner',
    status: 'active',
  }, { onConflict: 'workspace_id,user_id' })
  if (membershipError) throw new Error(membershipError.message)

  console.log(`REACHAGENT_V2_ADMIN_BOOTSTRAP_PASS user_id=${user.id}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
