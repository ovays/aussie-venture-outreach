import { NextRequest, NextResponse } from 'next/server'
import { handleStripeWebhookRequest } from '@/lib/billing/webhook'

export const runtime = 'nodejs'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = await handleStripeWebhookRequest(request)
  return new NextResponse(response.body, { status: response.status, headers: response.headers })
}
