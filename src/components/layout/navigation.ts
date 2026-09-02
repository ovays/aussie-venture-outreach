import {
  Activity,
  BarChart3,
  Bot,
  CircleDollarSign,
  GitBranch,
  LayoutDashboard,
  Mail,
  MailWarning,
  MessageSquare,
  Settings,
  Shield,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavigationItem {
  href: string
  label: string
  icon: LucideIcon
  adminOnly?: boolean
}

export interface NavigationSection {
  label: string
  items: NavigationItem[]
}

export const navigationSections: NavigationSection[] = [
  {
    label: 'Core',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/leads', label: 'Leads', icon: Users },
      { href: '/dashboard/pipeline', label: 'Pipeline', icon: GitBranch },
      { href: '/dashboard/deals', label: 'Deals', icon: CircleDollarSign },
    ],
  },
  {
    label: 'Outreach',
    items: [
      { href: '/dashboard/dm-queue', label: 'DM Queue', icon: MessageSquare },
      { href: '/dashboard/email-log', label: 'Email Log', icon: Mail },
      { href: '/dashboard/email-report', label: 'Email Report', icon: BarChart3 },
      { href: '/dashboard/delivery-failures', label: 'Delivery Failures', icon: MailWarning },
      { href: '/dashboard/lifecycle', label: 'Lifecycle', icon: Activity },
    ],
  },
]

export const adminNavigation: NavigationItem[] = [
  { href: '/dashboard/admin', label: 'User Management', icon: Shield, adminOnly: true },
  { href: '/dashboard/admin/data-quality', label: 'Data Quality', icon: ShieldCheck, adminOnly: true },
  { href: '/dashboard/settings/ai/analytics', label: 'AI Analytics', icon: BarChart3, adminOnly: true },
]

export const utilityNavigation: NavigationItem[] = [
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
  { href: '/dashboard/settings/ai', label: 'AI Settings', icon: Bot },
]

export function isRouteActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === href
  if (href === '/dashboard/admin') return pathname === href
  if (href === '/dashboard/settings') return pathname === href
  if (href === '/dashboard/settings/ai') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function isAdminRoute(pathname: string): boolean {
  return adminNavigation.some((item) => isRouteActive(pathname, item.href))
}
