import { NextRequest, NextResponse } from 'next/server'
import { isApiWorkspaceError, requireApiWorkspaceContentReader } from '@/lib/api-workspace'
import { CUSTOMER_INBOX_PAGE_SIZE, listCustomerConversations } from '@/lib/customer-inbox'
import { resolvePagination } from '@/lib/pagination'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await requireApiWorkspaceContentReader()
  if (isApiWorkspaceError(access)) return access
  const pagination = resolvePagination({
    page: request.nextUrl.searchParams.get('page'),
    pageSize: request.nextUrl.searchParams.get('page_size'),
  }, { defaultPageSize: CUSTOMER_INBOX_PAGE_SIZE, maxPageSize: CUSTOMER_INBOX_PAGE_SIZE })
  try { return NextResponse.json(await listCustomerConversations(access.supabase, pagination)) }
  catch { return NextResponse.json({ error: 'Unable to load Inbox' }, { status: 500 }) }
}
