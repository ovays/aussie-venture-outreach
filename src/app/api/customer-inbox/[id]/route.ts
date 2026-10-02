import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isApiWorkspaceError, requireApiWorkspaceContentReader } from '@/lib/api-workspace'
import { getCustomerConversation } from '@/lib/customer-inbox'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const access = await requireApiWorkspaceContentReader()
  if (isApiWorkspaceError(access)) return access
  const id = z.string().uuid().safeParse((await params).id)
  if (!id.success) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const conversation = await getCustomerConversation(access.supabase, id.data)
    return conversation ? NextResponse.json({ data: conversation }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  } catch { return NextResponse.json({ error: 'Unable to load conversation' }, { status: 500 }) }
}
