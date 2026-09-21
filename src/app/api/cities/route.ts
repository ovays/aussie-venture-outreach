import { NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceUser } from '@/lib/api-workspace'

export async function GET() {
  const access = await requireApiWorkspaceUser()
  if (isApiWorkspaceError(access)) return access
  const { supabase } = access
  const { data, error } = await supabase
    .from('city_suburbs')
    .select('city')
    .order('city')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const cities = [...new Set((data ?? []).map((r) => r.city))].sort()
  return NextResponse.json({ data: cities })
}
