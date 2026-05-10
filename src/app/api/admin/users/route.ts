import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(1).max(120),
  role: z.enum(['admin', 'member']),
})

const updateUserSchema = z.object({
  userId: z.string().uuid(),
  full_name: z.string().min(1).max(120).optional(),
  role: z.enum(['admin', 'member']).optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
})

export async function GET() {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const parsed = createUserSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { email, password, full_name, role } = parsed.data
  const supabase = createServiceClient()

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role },
  })

  if (createError || !created.user) {
    return NextResponse.json({ error: createError?.message ?? 'Unable to create user' }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('profiles')
    .upsert({
      id: created.user.id,
      email,
      full_name,
      role,
      is_active: true,
    })
    .select('id, email, full_name, role, is_active, created_at')
    .single()

  if (error) {
    await supabase.auth.admin.deleteUser(created.user.id)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const parsed = updateUserSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { userId, full_name, role, is_active, password } = parsed.data
  if (userId === auth.user.id && (role === 'member' || is_active === false)) {
    return NextResponse.json({ error: 'Admins cannot remove their own admin access' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const profileUpdates: Record<string, unknown> = {}
  const authUpdates: {
    password?: string
    user_metadata?: Record<string, unknown>
    ban_duration?: string
  } = {}

  if (full_name !== undefined) profileUpdates.full_name = full_name
  if (role !== undefined) profileUpdates.role = role
  if (is_active !== undefined) {
    profileUpdates.is_active = is_active
    authUpdates.ban_duration = is_active ? 'none' : '876000h'
  }
  if (password !== undefined) authUpdates.password = password
  if (full_name !== undefined || role !== undefined) {
    authUpdates.user_metadata = {
      ...(full_name !== undefined ? { full_name } : {}),
      ...(role !== undefined ? { role } : {}),
    }
  }

  if (Object.keys(authUpdates).length > 0) {
    const { error } = await supabase.auth.admin.updateUserById(userId, authUpdates)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  if (Object.keys(profileUpdates).length > 0) {
    const { data, error } = await supabase
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)
      .select('id, email, full_name, role, is_active, created_at')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .eq('id', userId)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(request: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  const userId = new URL(request.url).searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }
  if (userId === auth.user.id) {
    return NextResponse.json({ error: 'Admins cannot delete their own account' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase.auth.admin.deleteUser(userId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
