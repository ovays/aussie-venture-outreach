import { z } from 'zod'

export const categoryFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').optional(),
  halal_filter: z.boolean().optional(),
  cities: z.enum(['sydney_only', 'all', 'custom']).optional(),
  custom_cities: z.array(z.string()).nullable().optional(),
  content_type: z.enum(['visit', 'remote', 'both']).optional(),
  city_content_types: z.record(z.string(), z.enum(['visit', 'remote'])).nullable().optional(),
  pitch_template: z.string().nullable().optional(),
  dm_template: z.string().nullable().optional(),
  search_keywords: z.array(z.string()).nullable().optional(),
  use_priority_suburbs: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
})

const templatePatchSchema = z.object({
  subject_template: z.string().nullable().optional(),
  body_template: z.string().nullable().optional(),
}).strict()

const templatesSchema = z.object({
  initial_pitch: templatePatchSchema.optional(),
  follow_up_1: templatePatchSchema.optional(),
  follow_up_2: templatePatchSchema.optional(),
  follow_up_3: templatePatchSchema.optional(),
  reactivation: templatePatchSchema.optional(),
}).strict()

export const createCategorySchema = categoryFieldsSchema.extend({
  name: z.string().trim().min(1, 'Category name is required'),
  templates: templatesSchema.optional(),
})

export const updateCategorySchema = categoryFieldsSchema.extend({
  id: z.string().uuid(),
  templates: templatesSchema.optional(),
})
