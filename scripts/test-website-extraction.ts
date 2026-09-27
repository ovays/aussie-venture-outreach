import assert from 'node:assert/strict'
import { extractWebsiteData } from '@/ai/website-extraction'
import type { AIExecuteWorkflow } from '@/ai/harness'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

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

const execute: AIExecuteWorkflow = async (input) => {
  const value = responses.shift()!
  return {
    output: value,
    rawText: JSON.stringify(value),
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    promptVersion: input.promptVersion,
    schemaValidated: true,
    contextSize: null,
    contextTruncated: false,
    retryCount: 0,
  }
}

async function main(): Promise<void> {
  const empty = await extractWebsiteData('website content', execute, WORKSPACE_ID)
  const populated = await extractWebsiteData('website content', execute, WORKSPACE_ID)
  const text = await extractWebsiteData('website content', execute, WORKSPACE_ID)

  assert.equal(empty.other_social, null)
  assert.equal(populated.other_social, 'TikTok, LinkedIn')
  assert.equal(text.other_social, '@business')

  console.log('Website extraction normalization tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
