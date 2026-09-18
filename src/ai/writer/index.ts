import { writeOutreachEmail } from '@/ai/workflows'

export interface PersonalizedInitialContentInput {
  business_name: string
  category: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
  content_type: string
}

export interface PersonalizedInitialContent {
  subject: string
  body: string
}

export type PersonalizedInitialWriter = (
  input: PersonalizedInitialContentInput,
) => Promise<PersonalizedInitialContent>

/**
 * The canonical AI boundary for personalized initial outreach. It delegates to
 * the configured AI workflow/provider registry and contains no workflow routing.
 */
export async function writePersonalizedInitialContent(
  input: PersonalizedInitialContentInput,
): Promise<PersonalizedInitialContent> {
  return writeOutreachEmail(input)
}
