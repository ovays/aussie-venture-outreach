import { z } from 'zod'

export const ONBOARDING_SETTING_KEYS = {
  status: 'onboarding_status', currentStep: 'onboarding_current_step', completedAt: 'onboarding_completed_at',
  website: 'workspace_website', industry: 'workspace_industry', country: 'workspace_country', primaryCity: 'workspace_primary_city',
  timezone: 'workspace_timezone', brandName: 'outreach_brand_name', companyDescription: 'outreach_company_description', primaryGoal: 'outreach_primary_goal',
  senderName: 'outreach_sender_name', contactEmail: 'workspace_contact_email', mailboxSkipped: 'mailbox_skipped',
  mode: 'initial_email_mode', automaticFollowups: 'automatic_followups_enabled', first: 'follow_up_1_days', second: 'follow_up_2_days',
  final: 'follow_up_3_days', reconnect: 'reactivation_delay_days', activeCities: 'active_cities', systemActive: 'system_active', reactivationEnabled: 'reactivation_enabled',
} as const
export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed'
export type OnboardingStep = 1|2|3|4|5|6|7|8|9
export interface OnboardingState {
  status: OnboardingStatus; currentStep: OnboardingStep; completedAt: string|null; workspaceName: string; website: string; industry: string; country: string; primaryCity: string; senderName: string; contactEmail: string; timezone:string; brandName:string; companyDescription:string; primaryGoal:string;
  mailboxSkipped: boolean; mailboxConnected: boolean; categories: Array<{id:string;name:string}>; locations: Array<{id:string;city:string;suburb:string}>;
  mode: 'template'|'ai_personalised'; automaticFollowups: boolean; first: number; second: number; final: number; reconnect: number;
  team: Array<{id:string;name:string;email:string;role:string;status:string;pending?:boolean}>;
}
const text = (label:string, max=120) => z.string().trim().min(1, `${label} is required`).max(max)
const website = z.string().trim().max(300).refine(v => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Enter a full website URL beginning with http:// or https://')
const business = z.object({ workspaceName:text('Business name'), website, industry:text('Business type'), country:text('Country'), primaryCity:text('Primary city'), senderName:text('Sender name'), contactEmail:z.string().trim().email() })
export const INDUSTRY_OPTIONS=[{value:'professional_services',label:'Professional services'},{value:'technology',label:'Technology'},{value:'retail_ecommerce',label:'Retail & e-commerce'},{value:'hospitality',label:'Hospitality'},{value:'health_wellness',label:'Health & wellness'},{value:'property_construction',label:'Property & construction'},{value:'other',label:'Other'}] as const
export const COUNTRY_OPTIONS=[{value:'AU',label:'Australia'},{value:'NZ',label:'New Zealand'},{value:'US',label:'United States'},{value:'GB',label:'United Kingdom'},{value:'CA',label:'Canada'},{value:'SG',label:'Singapore'}] as const
export const OUTREACH_GOAL_OPTIONS=[{value:'book_meetings',label:'Book qualified meetings'},{value:'generate_leads',label:'Generate new leads'},{value:'build_partnerships',label:'Build partnerships'},{value:'win_customers',label:'Win new customers'}] as const
export const workspaceStepSchema=z.object({workspaceName:text('Workspace name'),website,industry:z.string().min(1),country:z.string().min(1),primaryCity:z.string().trim().max(120).optional(),contactEmail:z.string().trim().email().optional(),timezone:z.string().min(1)})
export const profileStepSchema=z.object({senderName:text('Sender name'),brandName:text('Brand name'),companyDescription:z.string().trim().max(500),primaryGoal:z.string().min(1)})
export const preferencesStepSchema=z.object({primaryMarket:text('Primary market')})
const categories = z.object({ names:z.array(text('Category',80)).min(1,'Choose at least one category').max(20) })
const locations = z.object({ locations:z.array(z.object({city:text('City'),suburb:z.string().trim().max(120)})).min(1,'Add at least one location').max(50) })
const followups = z.object({ automaticFollowups:z.boolean(), first:z.number().int().min(1).max(365), second:z.number().int().min(1).max(365), final:z.number().int().min(1).max(365), reconnect:z.number().int().min(1).max(730) }).refine(v=>v.first<v.second&&v.second<v.final&&v.final<v.reconnect,{message:'Follow-up days must increase in order',path:['first']})
export const onboardingRequestSchema = z.union([
  z.object({action:z.literal('navigate'),step:z.number().int().min(1).max(9)}),
  z.object({action:z.literal('advance'),step:z.literal(1),data:business}),
  z.object({action:z.literal('advance'),step:z.literal(2),data:z.object({skip:z.boolean()})}),
  z.object({action:z.literal('advance'),step:z.literal(3),data:categories}),
  z.object({action:z.literal('advance'),step:z.literal(4),data:locations}),
  z.object({action:z.literal('advance'),step:z.literal(5),data:z.object({mode:z.enum(['template','ai_personalised'])})}),
  z.object({action:z.literal('advance'),step:z.literal(6),data:followups}),
  z.object({action:z.literal('advance'),step:z.literal(7),data:z.object({invite:z.object({email:z.string().email(),role:z.enum(['admin','member'])}).optional()})}),
  z.object({action:z.literal('advance'),step:z.literal(8)}), z.object({action:z.literal('complete'),step:z.literal(9)}),
])
export function parseOnboardingStatus(v?:string):OnboardingStatus{return v==='completed'||v==='in_progress'?v:'not_started'}
export function parseOnboardingStep(v?:string):OnboardingStep{const n=Number(v);return Number.isInteger(n)&&n>=1&&n<=9?n as OnboardingStep:1}
export function onboardingDestination(path:'dashboard'|'onboarding',status:OnboardingStatus){if(path==='dashboard'&&status!=='completed')return'/onboarding';if(path==='onboarding'&&status==='completed')return'/dashboard';return null}
export function followUpOrderValid(v:Pick<OnboardingState,'first'|'second'|'final'|'reconnect'>){return v.first<v.second&&v.second<v.final&&v.final<v.reconnect}
export function timezoneOptions(){const preferred=['Australia/Sydney','Australia/Melbourne','Australia/Brisbane','Australia/Perth','Pacific/Auckland'];return [...preferred,...Intl.supportedValuesOf('timeZone').filter(v=>!preferred.includes(v))].map(value=>({value,label:value.replaceAll('_',' ')}))}
