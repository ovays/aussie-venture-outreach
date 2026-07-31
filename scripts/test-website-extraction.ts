import assert from 'node:assert/strict'
import { aiRegistry } from '@/ai/AIRuntime'
import { extractWebsiteData } from '@/ai/website-extraction'

const responses = [
  {
    description: 'A business',
    services: 'A service',
    instagram_handle: null,
    facebook_url: null,
    other_social: [],
  },
  {
    description: 'A business',
    services: 'A service',
    instagram_handle: null,
    facebook_url: null,
    other_social: ['TikTok', 'LinkedIn'],
  },
  {
    description: 'A business',
    services: 'A service',
    instagram_handle: null,
    facebook_url: null,
    other_social: '@business',
  },
]

aiRegistry.generate = async () => ({
  text: JSON.stringify(responses.shift()),
})

async function main(): Promise<void> {
  const empty = await extractWebsiteData('website content')
  const populated = await extractWebsiteData('website content')
  const text = await extractWebsiteData('website content')

  assert.equal(empty.other_social, null)
  assert.equal(populated.other_social, 'TikTok, LinkedIn')
  assert.equal(text.other_social, '@business')

  console.log('Website extraction normalization tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
