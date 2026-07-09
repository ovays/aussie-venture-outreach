import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('city_suburbs')
    .select('city')
    .order('city')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const cities = [...new Set((data ?? []).map((r) => r.city))].sort()
  return NextResponse.json({ data: cities })
}
