import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { emailBodyToHtml } from '@/lib/utils'

const patchSchema = z.object({
  subject: z.string().min(1),
  body_text: z.string().min(1),
})

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const raw = await request.json()
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { subject, body_text } = parsed.data

  const { data: existing, error: fetchErr } = await supabase
    .from('emails')
    .select('id, status')
    .eq('id', id)
    .single()

  if (fetchErr || !existing) {
    return NextResponse.json({ error: 'Email not found' }, { status: 404 })
  }

  if (existing.status !== 'pending_send') {
    return NextResponse.json({ error: 'Only pending emails can be edited' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('emails')
    .update({
      subject,
      body_text,
      body_html: emailBodyToHtml(body_text),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
