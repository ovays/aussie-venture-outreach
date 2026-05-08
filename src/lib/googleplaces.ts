import type { OutscraperResult } from './outscraper'

interface GooglePlace {
  id?: string
  displayName?: { text: string }
  formattedAddress?: string
  nationalPhoneNumber?: string
  websiteUri?: string
  rating?: number
  userRatingCount?: number
}

interface GoogleSearchResponse {
  places?: GooglePlace[]
  nextPageToken?: string
}

function mapGooglePlace(place: GooglePlace): OutscraperResult {
  const parts = (place.formattedAddress ?? '').split(',').map((s) => s.trim())
  return {
    name: place.displayName?.text ?? '',
    address: place.formattedAddress ?? '',
    borough: '',
    city: parts.length >= 2 ? parts[parts.length - 2] : '',
    postal_code: '',
    country_code: 'AU',
    phone: place.nationalPhoneNumber ?? '',
    website: place.websiteUri ?? '',
    email: '',
    rating: place.rating ?? 0,
    reviews: place.userRatingCount ?? 0,
    latitude: 0,
    longitude: 0,
  }
}

export async function searchBusinessesGoogle(query: string, limit: number): Promise<OutscraperResult[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured')

  const results: OutscraperResult[] = []
  let nextPageToken: string | undefined

  while (results.length < limit) {
    const body: Record<string, unknown> = {
      textQuery: query,
      maxResultCount: Math.min(20, limit - results.length),
      languageCode: 'en',
      regionCode: 'AU',
    }
    if (nextPageToken) body.pageToken = nextPageToken

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.id,nextPageToken',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Google Places API ${response.status}: ${text.slice(0, 300)}`)
    }

    const data = await response.json() as GoogleSearchResponse
    if (!data.places?.length) break

    results.push(...data.places.map(mapGooglePlace))
    nextPageToken = data.nextPageToken
    if (!nextPageToken) break
  }

  return results.slice(0, limit)
}
