import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

const protectedPrefixes = ['/dashboard', '/api']
const publicApiPrefixes = ['/api/webhooks']
const adminPrefixes = [
  '/dashboard/admin',
  '/api/admin',
]

function isProtectedPath(pathname: string) {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function isPublicApiPath(pathname: string) {
  return publicApiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function isAdminPath(pathname: string) {
  return adminPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

function unauthorized() {
  return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
}

function forbidden() {
  return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
}

async function getLiveProfileRole(userId: string) {
  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', userId)
    .single()

  if (error) {
    console.log('Admin role check', {
      userId,
      role: null,
      error: error.message,
    })
    return null
  }

  console.log('Admin role check', {
    userId,
    role: profile?.role,
  })

  return profile
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (pathname === '/login' && user) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (!isProtectedPath(pathname) || isPublicApiPath(pathname)) {
    return response
  }

  if (!user) {
    return pathname.startsWith('/api') ? unauthorized() : redirectToLogin(request)
  }

  const profile = await getLiveProfileRole(user.id)

  if (!profile || !profile.is_active) {
    return pathname.startsWith('/api') ? unauthorized() : redirectToLogin(request)
  }

  if (isAdminPath(pathname) && profile?.role !== 'admin') {
    return pathname.startsWith('/api') ? forbidden() : NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
