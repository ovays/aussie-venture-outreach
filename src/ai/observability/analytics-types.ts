export interface AIAnalyticsSummary {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  successRate: number
  averageLatencyMs: number
  averageCostUsd: number | null
  requestsToday: number
  requestsThisMonth: number
}

export interface AIRanking {
  name: string
  count: number
}

export interface AIRecentRequest {
  id: string
  createdAt: string
  workflow: string
  provider: string | null
  model: string | null
  status: 'succeeded' | 'failed'
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  errorMessage: string | null
  retryCount: number
  requestSource: string
}

export interface AIAnalyticsData {
  summary: AIAnalyticsSummary
  topWorkflows: AIRanking[]
  topModels: AIRanking[]
  topProviders: AIRanking[]
  recentRequests: AIRecentRequest[]
}
