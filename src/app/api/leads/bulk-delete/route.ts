import { NextRequest, NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import {
  deleteLeads,
  LeadIdsValidationError,
  normalizeLeadIds,
} from '@/lib/delete-leads'
import { createClient } from '@/lib/supabase/server'

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await requireApiUser()
  if (isAuthErrorResponse(auth)) return auth

  try {
    const body = await request.json() as { lead_ids?: unknown }
    const leadIds = normalizeLeadIds(body.lead_ids)
    const result = await deleteLeads(await createClient(), leadIds)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof LeadIdsValidationError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message || 'Invalid JSON body' }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not delete leads' },
      { status: 500 },
    )
  }
}
