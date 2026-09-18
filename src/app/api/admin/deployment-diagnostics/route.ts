import { NextResponse } from 'next/server'
import { getV2DeploymentDiagnostics } from '@/lib/deployment-diagnostics'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth
  return NextResponse.json(getV2DeploymentDiagnostics(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}
