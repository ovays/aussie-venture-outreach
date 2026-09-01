import { NextResponse } from 'next/server'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'
import { duplicateConsolidationPreviewSchema } from '@/lib/duplicate-consolidation'
import { createDuplicateConsolidationPreview } from '@/lib/duplicate-consolidation-preview'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const parsed = duplicateConsolidationPreviewSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({
      error: 'Select one keep lead and at least one distinct redundant lead from the same duplicate group.',
    }, { status: 400 })
  }

  try {
    const preview = await createDuplicateConsolidationPreview(createServiceClient(), parsed.data)
    return NextResponse.json(preview, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('Duplicate consolidation preview failed', { userId: auth.user.id, error })
    return NextResponse.json({ error: 'Unable to build the read-only consolidation preview.' }, { status: 500 })
  }
}
