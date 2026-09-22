import {
  Activity,
  BarChart3,
  Bot,
  Building2,
  CircleDollarSign,
  DatabaseZap,
  FileText,
  GitBranch,
  Home,
  ListFilter,
  Mail,
  MailWarning,
  MapPinned,
  MessageSquare,
  Settings,
  Shield,
  ShieldCheck,
  Tags,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavigationItem {
  href: string
  label: string
  icon: LucideIcon
  exact?: boolean
  adminOnly?: boolean
}

export interface NavigationSection {
  label: string
  icon: LucideIcon
  href?: string
  items?: NavigationItem[]
}

export const navigationSections: NavigationSection[] = [
  { label: 'Home', icon: Home, href: '/dashboard' },
  {
    label: 'Leads',
    icon: Users,
    items: [
      { href: '/dashboard/leads', label: 'All Leads', icon: Users },
      { href: '/dashboard/lifecycle', label: 'Lifecycle', icon: Activity },
      { href: '/dashboard/deals', label: 'Deals', icon: CircleDollarSign },
      { href: '/dashboard/admin/data-quality', label: 'Data Quality', icon: DatabaseZap, adminOnly: true },
    ],
  },
  {
    label: 'Outreach',
    icon: MessageSquare,
    items: [
      { href: '/dashboard/pipeline', label: 'Outreach Pipeline', icon: GitBranch },
      { href: '/dashboard/dm-queue', label: 'DM Queue', icon: MessageSquare },
      { href: '/dashboard/email-log', label: 'Email Log', icon: Mail },
      { href: '/dashboard/email-report', label: 'Email Report', icon: BarChart3 },
      { href: '/dashboard/delivery-failures', label: 'Delivery Failures', icon: MailWarning },
    ],
  },
  {
    label: 'Campaigns',
    icon: Tags,
    items: [
      { href: '/dashboard/settings#categories', label: 'Categories', icon: Tags },
      { href: '/dashboard/settings#email-templates', label: 'Email Templates', icon: FileText },
      { href: '/dashboard/settings#sequences', label: 'Sequences', icon: ListFilter },
      { href: '/dashboard/settings#suburbs', label: 'Suburbs', icon: MapPinned },
      { href: '/dashboard/settings#targeting', label: 'Targeting', icon: Building2 },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    items: [
      { href: '/dashboard/settings', label: 'Workspace Settings', icon: Settings, exact: true },
      { href: '/dashboard/settings/ai', label: 'AI Settings', icon: Bot },
    ],
  },
]

export const adminNavigation: NavigationItem[] = [
  { href: '/dashboard/admin', label: 'Team & Members', icon: Shield, adminOnly: true, exact: true },
  { href: '/dashboard/admin/data-quality', label: 'Data Quality', icon: ShieldCheck, adminOnly: true },
  { href: '/dashboard/settings/ai/analytics', label: 'AI Analytics', icon: BarChart3, adminOnly: true },
]

// Kept as a stable export for older shell tests and imports.
export const utilityNavigation: NavigationItem[] = []

export function stripHash(href: string): string {
  return href.split('#')[0].split('?')[0]
}

export function isRouteActive(pathname: string, href: string, exact = false): boolean {
  const route = stripHash(href)
  const exactRoutes = ['/dashboard', '/dashboard/admin', '/dashboard/settings', '/dashboard/settings/ai']
  if (exact || exactRoutes.includes(route)) return pathname === route
  return pathname === route || pathname.startsWith(`${route}/`)
}

export function isSectionActive(pathname: string, section: NavigationSection): boolean {
  if (section.href) return isRouteActive(pathname, section.href, section.href === '/dashboard')
  return section.items?.some((item) => isRouteActive(pathname, item.href, item.exact)) ?? false
}

export function isAdminRoute(pathname: string): boolean {
  return adminNavigation.some((item) => isRouteActive(pathname, item.href, item.exact))
}
