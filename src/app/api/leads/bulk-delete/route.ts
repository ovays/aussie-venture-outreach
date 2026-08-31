import { NextRequest } from 'next/server'
import { isAuthErrorResponse, requireApiUser } from '@/lib/auth'
import { handleBulkDeleteRequest } from '@/lib/bulk-delete-request'
import { createClient } from '@/lib/supabase/server'

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleBulkDeleteRequest(request, {
    authenticate: async () => {
      const auth = await requireApiUser()
      return isAuthErrorResponse(auth) ? auth : null
    },
    createClient,
    logError: (message, context) => console.error(message, context),
  })
}
