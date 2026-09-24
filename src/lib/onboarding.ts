import { z } from 'zod'

export const ONBOARDING_SETTING_KEYS = {
  status: 'onboarding_status',
  currentStep: 'onboarding_current_step',
  completedAt: 'onboarding_completed_at',
  website: 'workspace_website',
  industry: 'workspace_industry',
  country: 'workspace_country',
  timezone: 'workspace_timezone',
  senderName: 'outreach_sender_name',
  brandName: 'outreach_brand_name',
  companyDescription: 'outreach_company_description',
  primaryGoal: 'outreach_primary_goal',
  primaryMarket: 'active_cities',
} as const

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed'
export type OnboardingStep = 1 | 2 | 3 | 4 | 5

export interface OnboardingState {
  status: OnboardingStatus
  currentStep: OnboardingStep
  completedAt: string | null
  workspaceName: string
  website: string
  industry: string
  country: string
  timezone: string
  senderName: string
  brandName: string
  companyDescription: string
  primaryGoal: string
  primaryMarket: string
}

export const INDUSTRY_OPTIONS = [
  { value: 'professional_services', label: 'Professional services' },
  { value: 'technology', label: 'Technology' },
  { value: 'retail_ecommerce', label: 'Retail & e-commerce' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'health_wellness', label: 'Health & wellness' },
  { value: 'property_construction', label: 'Property & construction' },
  { value: 'other', label: 'Other' },
] as const

export const COUNTRY_OPTIONS = [
  { value: 'AU', label: 'Australia' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'SG', label: 'Singapore' },
] as const

export const OUTREACH_GOAL_OPTIONS = [
  { value: 'book_meetings', label: 'Book qualified meetings' },
  { value: 'generate_leads', label: 'Generate new leads' },
  { value: 'build_partnerships', label: 'Build partnerships' },
  { value: 'win_customers', label: 'Win new customers' },
] as const

const industryValues = INDUSTRY_OPTIONS.map((option) => option.value) as [string, ...string[]]
const countryValues = COUNTRY_OPTIONS.map((option) => option.value) as [string, ...string[]]
const goalValues = OUTREACH_GOAL_OPTIONS.map((option) => option.value) as [string, ...string[]]

function isKnownTimezone(value: string): boolean {
  try {
    return Intl.supportedValuesOf('timeZone').includes(value)
  } catch {
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: value }).format()
      return true
    } catch {
      return false
    }
  }
}

const trimmed = (minimum: number, maximum: number, label: string) => z.string()
  .trim()
  .min(minimum, `${label} is required`)
  .max(maximum, `${label} must be ${maximum} characters or fewer`)

const optionalWebsite = z.string().trim().max(300, 'Website must be 300 characters or fewer').refine((value) => {
  if (!value) return true
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}, 'Enter a full website URL beginning with http:// or https://')

export const workspaceStepSchema = z.object({
  workspaceName: trimmed(1, 120, 'Workspace name'),
  website: optionalWebsite,
  industry: z.enum(industryValues, { message: 'Select a valid industry' }),
  country: z.enum(countryValues, { message: 'Select a valid country' }),
  timezone: z.string().trim().max(100).refine(isKnownTimezone, 'Select a valid timezone'),
})

export const profileStepSchema = z.object({
  senderName: trimmed(1, 120, 'Sender name'),
  brandName: trimmed(1, 120, 'Brand name'),
  companyDescription: z.string().trim().max(500, 'Company description must be 500 characters or fewer'),
  primaryGoal: z.enum(goalValues, { message: 'Select a valid outreach goal' }),
})

export const preferencesStepSchema = z.object({
  primaryMarket: trimmed(1, 120, 'Primary market'),
})

export const onboardingRequestSchema = z.union([
  z.object({ action: z.literal('advance'), step: z.literal(1) }),
  z.object({ action: z.literal('advance'), step: z.literal(2), data: workspaceStepSchema }),
  z.object({ action: z.literal('advance'), step: z.literal(3), data: profileStepSchema }),
  z.object({ action: z.literal('advance'), step: z.literal(4), data: preferencesStepSchema }),
  z.object({ action: z.literal('navigate'), step: z.number().int().min(1).max(5) }),
  z.object({ action: z.literal('complete'), step: z.literal(5) }),
])

export function parseOnboardingStatus(value?: string): OnboardingStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'not_started'
}

export function parseOnboardingStep(value?: string): OnboardingStep {
  const parsed = Number(value)
  return parsed >= 1 && parsed <= 5 && Number.isInteger(parsed) ? parsed as OnboardingStep : 1
}

export function shouldRouteToOnboarding(status: OnboardingStatus): boolean {
  return status !== 'completed'
}

export function onboardingDestination(path: 'dashboard' | 'onboarding', status: OnboardingStatus): string | null {
  if (path === 'dashboard' && shouldRouteToOnboarding(status)) return '/onboarding'
  if (path === 'onboarding' && !shouldRouteToOnboarding(status)) return '/dashboard'
  return null
}

export function timezoneOptions(): Array<{ value: string; label: string }> {
  const preferred = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Pacific/Auckland']
  const supported = Intl.supportedValuesOf('timeZone')
  return [...preferred, ...supported.filter((zone) => !preferred.includes(zone))]
    .map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }))
}
