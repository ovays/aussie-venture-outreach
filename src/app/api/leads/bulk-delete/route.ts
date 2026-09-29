import { NextRequest } from 'next/server'
import { handleBulkDeleteRequest } from '@/lib/bulk-delete-request'
import { isApiWorkspaceError, requireApiWorkspaceAdmin } from '@/lib/api-workspace'

export async function DELETE(request: NextRequest): Promise<Response> {
  const access = await requireApiWorkspaceAdmin()
  if (isApiWorkspaceError(access)) return access

  return handleBulkDeleteRequest(request, {
    authenticate: async () => null,
    createClient: async () => access.supabase,
    logError: (message, context) => console.error(message, context),
  })
}
