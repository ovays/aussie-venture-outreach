export interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
}

export type PricingCatalog = Readonly<Record<string, Readonly<Record<string, ModelPricing>>>>

// Standard, non-batch API list prices. Update this catalogue when vendor prices change.
export const AI_PRICING: PricingCatalog = {
  anthropic: {
    'claude-haiku-4-5-20251001': {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
    },
    'claude-sonnet-4-6': {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
  },
  openai: {
    'gpt-5': {
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
    },
    'gpt-5-mini': {
      inputUsdPerMillionTokens: 0.25,
      outputUsdPerMillionTokens: 2,
    },
  },
  gemini: {
    'gemini-2.5-pro': {
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
    },
    'gemini-2.5-flash': {
      inputUsdPerMillionTokens: 0.3,
      outputUsdPerMillionTokens: 2.5,
    },
  },
}

export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  catalog: PricingCatalog = AI_PRICING
): number | null {
  const pricing = catalog[provider]?.[model]
  if (!pricing || inputTokens == null || outputTokens == null) return null
  if (inputTokens < 0 || outputTokens < 0) return null

  return (
    inputTokens * pricing.inputUsdPerMillionTokens
    + outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000
}
