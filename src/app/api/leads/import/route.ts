import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { createLead, type CreateLeadResult } from '@/lib/create-lead'
import { STAGE_VALUES } from '@/lib/stage-import'
import { readInitialEmailMode } from '@/lib/initial-email-router'
import { initialEmailPolicyForCsvImport } from '@/lib/initial-email-mode-snapshot'

// Rows are already normalized/defaulted client-side (blank rows dropped,
// stage labels resolved, city/category defaults applied) — this schema is a
// defense-in-depth check, not the primary validation surface.
const importRowSchema = z.object({
  row_num: z.number().int().positive(),
  business_name: z.string().min(1),
  email: z.string().min(1),
  website: z.string().optional(),
  suburb: z.string().optional(),
  city: z.string().min(1),
  category_name: z.string().min(1),
  current_stage: z.enum(STAGE_VALUES),
  stage_completed_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(500),
})

type FailedRow = { row_num: number; business_name: string; email: string; reason: string }

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'global'
  const { allowed } = checkRateLimit(`leads-import:${ip}`, 5)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = createServiceClient()
  const raw = await request.json()

  const parsed = importSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 })
  }

  const { rows } = parsed.data
  const initialEmailMode = await readInitialEmailMode(supabase)

  const { data: categories, error: categoriesErr } = await supabase
    .from('categories')
    .select('id, name, content_type, city_content_types')

  if (categoriesErr) {
    return NextResponse.json({ error: categoriesErr.message }, { status: 500 })
  }

  const categoryByName = new Map((categories ?? []).map((c) => [c.name.trim().toLowerCase(), c]))

  let imported = 0
  let duplicates = 0
  const failed: FailedRow[] = []

  for (const row of rows) {
    const emailCheck = z.string().email().safeParse(row.email)
    if (!emailCheck.success) {
      failed.push({ row_num: row.row_num, business_name: row.business_name, email: row.email, reason: 'Invalid email address' })
      continue
    }

    const category = categoryByName.get(row.category_name.trim().toLowerCase())
    if (!category) {
      failed.push({ row_num: row.row_num, business_name: row.business_name, email: row.email, reason: `Unknown category "${row.category_name}"` })
      continue
    }

    let result: CreateLeadResult
    try {
      result = await createLead(supabase, {
        business_name: row.business_name,
        email: row.email,
        website: row.website || undefined,
        suburb: row.suburb || '',
        city: row.city,
        category_id: category.id,
        category_name: category.name,
        force: true,
        current_stage: row.current_stage,
        stage_completed_date: row.stage_completed_date,
        source: 'manual',
        initialEmail: initialEmailPolicyForCsvImport(initialEmailMode),
      })
    } catch (error) {
      failed.push({
        row_num: row.row_num,
        business_name: row.business_name,
        email: row.email,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (result.ok) {
      imported++
      if (result.generationError) failed.push({ row_num: row.row_num, business_name: row.business_name, email: row.email, reason: result.generationError })
      continue
    }

    if (result.status === 409) {
      duplicates++
      continue
    }

    failed.push({ row_num: row.row_num, business_name: row.business_name, email: row.email, reason: result.error })
  }

  return NextResponse.json({ total: rows.length, imported, duplicates, failed, mode: initialEmailMode })
}
