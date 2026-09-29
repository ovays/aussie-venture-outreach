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
  Mail,
  MailWarning,
  MessageSquare,
  Settings,
  Shield,
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
  { label: 'Dashboard', icon: Home, href: '/dashboard' },
  { label: 'Leads', icon: Users, href: '/dashboard/leads' },
  { label: 'Outreach', icon: MessageSquare, href: '/dashboard/outreach' },
  { label: 'Inbox', icon: Mail, href: '/dashboard/inbox' },
  { label: 'Analytics', icon: BarChart3, href: '/dashboard/analytics' },
  { label: 'Settings', icon: Settings, href: '/dashboard/settings' },
]

export const adminNavigation: NavigationItem[] = [
  { href: '/dashboard/lifecycle', label: 'Lifecycle', icon: Activity, adminOnly: true },
  { href: '/dashboard/pipeline', label: 'Pipeline', icon: GitBranch, adminOnly: true },
  { href: '/dashboard/dm-queue', label: 'DM Queue', icon: MessageSquare, adminOnly: true },
  { href: '/dashboard/email-log', label: 'Email Log', icon: Mail, adminOnly: true },
  { href: '/dashboard/email-report', label: 'Email Report', icon: BarChart3, adminOnly: true },
  { href: '/dashboard/delivery-failures', label: 'Delivery Failures', icon: MailWarning, adminOnly: true },
  { href: '/dashboard/deals', label: 'Deals', icon: CircleDollarSign, adminOnly: true },
  { href: '/dashboard/settings/ai', label: 'AI Settings', icon: Bot, adminOnly: true, exact: true },
  { href: '/dashboard/settings/ai/analytics', label: 'AI Analytics', icon: BarChart3, adminOnly: true },
  { href: '/dashboard/admin/data-quality', label: 'Data Quality', icon: DatabaseZap, adminOnly: true },
  { href: '/dashboard/admin/workspaces', label: 'Workspaces', icon: Building2, adminOnly: true },
  { href: '/dashboard/admin', label: 'Users', icon: Shield, adminOnly: true, exact: true },
  { href: '/dashboard/admin/usage', label: 'Usage / Admin', icon: CircleDollarSign, adminOnly: true },
  { href: '/dashboard/admin/audit', label: 'Audit', icon: FileText, adminOnly: true },
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
