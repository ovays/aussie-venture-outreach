import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'
import { createCheckoutSession } from '@/lib/billing/service'

const schema = z.object({ planCode: z.enum(['starter', 'growth', 'pro']) }).strict()

export async function POST(request: NextRequest): Promise<NextResponse> {
  const context = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(context)) return context
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'A known internal plan code is required' }, { status: 400 })
  try {
    const url = await createCheckoutSession(
      context.workspace.workspaceId, context.auth.user.email, parsed.data.planCode,
    )
    return NextResponse.json({ data: { url } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create Checkout session' }, { status: 502 })
  }
}
