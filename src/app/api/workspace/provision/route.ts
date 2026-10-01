import { NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { getWorkspaceContext } from '@/lib/workspace-context'

export async function POST(): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth
  if (auth.profile.role === 'admin') return NextResponse.json({ data: { destination: '/dashboard', created: false } })

  try {
    const existing = await getWorkspaceContext(auth)
    return NextResponse.json({ data: { workspaceId: existing.workspaceId, destination: '/onboarding', created: false } })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'No workspace membership') {
      return NextResponse.json({ error: 'Unable to verify workspace access. Please try again.' }, { status: 500 })
    }
  }

  const supabase = await createClient()
  const { data, error } = await (supabase.rpc as unknown as (name: string) => Promise<{ data: Array<{ workspace_id: string; created: boolean }> | null; error: { message: string } | null }>)('provision_customer_workspace')
  if (error || !data?.[0]) return NextResponse.json({ error: error?.message ?? 'Workspace provisioning failed. Please retry.' }, { status: 500 })
  return NextResponse.json({ data: { workspaceId: data[0].workspace_id, destination: '/onboarding', created: data[0].created } })
}
