import { aiRegistry } from './AIRuntime'

export async function extractWebsiteData(websiteContent: string): Promise<{
  description: string
  services: string
  instagram_handle: string | null
  facebook_url: string | null
  other_social: string | null
}> {
  const response = await aiRegistry.generate('website_extraction', {
    maxTokens: 512,
    messages: [
      {
        role: 'user',
        content: `Extract the following from this business website content:
- Brief description (1-2 sentences)
- Main services offered
- Instagram handle (if mentioned, just the handle like @businessname)
- Facebook URL (if mentioned)
- Any other social media

Website content: ${websiteContent.slice(0, 4000)}

Respond in JSON only with keys: description, services, instagram_handle, facebook_url, other_social`,
      },
    ],
  })

  const text = response.text
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        // AI models sometimes return "services" as a list even though the prompt
        // asks for prose — coerce here since this is stored in a TEXT column
        // and interpolated directly into prompt strings by every caller.
        description: coerceToText(parsed.description),
        services: coerceToText(parsed.services),
        instagram_handle: parsed.instagram_handle || null,
        facebook_url: parsed.facebook_url || null,
        other_social: coerceToNullableText(parsed.other_social),
      }
    }
  } catch {
    // fallback
  }
  return {
    description: '',
    services: '',
    instagram_handle: null,
    facebook_url: null,
    other_social: null,
  }
}

function coerceToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(', ')
  return ''
}

function coerceToNullableText(value: unknown): string | null {
  const text = coerceToText(value).trim()
  return text || null
}
