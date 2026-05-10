import { NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'

export async function GET() {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  return NextResponse.json({
    data: {
      user: auth.user,
      profile: auth.profile,
    },
  })
}
