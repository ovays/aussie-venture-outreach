import { NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { adminListBillingAccounts } from '@/lib/billing/service'

export async function GET(): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  try {
    return NextResponse.json({ data: await adminListBillingAccounts() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load billing administration' }, { status: 500 })
  }
}
