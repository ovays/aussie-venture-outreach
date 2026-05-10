import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import type { Profile, UserRole } from '@/lib/auth-types'

export interface AuthContext {
  user: {
    id: string
    email?: string
  }
  profile: Profile
}

function isUserRole(role: unknown): role is UserRole {
  return role === 'admin' || role === 'member'
}

function fallbackRole(email?: string): UserRole {
  return email && email.toLowerCase() === process.env.ADMIN_EMAIL?.toLowerCase()
    ? 'admin'
    : 'member'
}

async function ensureProfile(user: { id: string; email?: string; user_metadata?: Record<string, unknown> }) {
  const service = createServiceClient()
  const { data: existing, error: existingError } = await service
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .eq('id', user.id)
    .maybeSingle()

  if (existingError) {
    throw new Error(existingError.message)
  }

  if (existing) return existing as Profile

  const role = fallbackRole(user.email)
  const fullName = typeof user.user_metadata?.full_name === 'string'
    ? user.user_metadata.full_name
    : null

  const { data, error } = await service
    .from('profiles')
    .insert({
      id: user.id,
      email: user.email ?? '',
      full_name: fullName,
      role,
      is_active: true,
    })
    .select('id, email, full_name, role, is_active, created_at')
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return data as Profile
}

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (error || !user) return null

  const profile = await ensureProfile({
    id: user.id,
    email: user.email,
    user_metadata: user.user_metadata,
  })

  if (!isUserRole(profile.role) || !profile.is_active) return null

  return {
    user: {
      id: user.id,
      email: user.email,
    },
    profile,
  }
})

export async function requireUser(): Promise<AuthContext> {
  const context = await getAuthContext()
  if (!context) redirect('/login')
  return context
}

export async function requireAdmin(): Promise<AuthContext> {
  const context = await requireUser()
  if (context.profile.role !== 'admin') redirect('/dashboard')
  return context
}

export async function requireApiUser(): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext()
  if (!context) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  return context
}

export async function requireApiAdmin(): Promise<AuthContext | NextResponse> {
  const context = await getAuthContext()
  if (!context) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  if (context.profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  return context
}

export function isAuthErrorResponse(value: AuthContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}
