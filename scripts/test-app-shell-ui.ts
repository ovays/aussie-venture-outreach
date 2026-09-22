import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  adminNavigation,
  isAdminRoute,
  isRouteActive,
  navigationSections,
  utilityNavigation,
} from '../src/components/layout/navigation'

const source = (path: string) => readFileSync(resolve(path), 'utf8')
const sidebar = source('src/components/layout/Sidebar.tsx')
const sidebarContext = source('src/components/layout/SidebarContext.tsx')
const topBar = source('src/components/layout/TopBar.tsx')
const globals = source('src/app/globals.css')

assert.equal(navigationSections[0]?.label, 'Home')
assert.deepEqual(navigationSections.map((section) => section.label), ['Home', 'Leads', 'Outreach', 'Campaigns', 'Settings'])
assert.deepEqual(navigationSections[1]?.items?.map((item) => item.label), ['All Leads', 'Lifecycle', 'Deals', 'Data Quality'])
assert.equal(navigationSections[2]?.label, 'Outreach')
assert.deepEqual(
  navigationSections[2]?.items?.map((item) => item.label),
  ['Outreach Pipeline', 'DM Queue', 'Email Log', 'Email Report', 'Delivery Failures'],
)
assert.deepEqual(adminNavigation.map((item) => item.label), ['Team & Members', 'Data Quality', 'AI Analytics'])
assert.deepEqual(utilityNavigation, [])

assert.equal(isRouteActive('/dashboard', '/dashboard'), true)
assert.equal(isRouteActive('/dashboard/leads', '/dashboard'), false)
assert.equal(isRouteActive('/dashboard/admin/data-quality', '/dashboard/admin/data-quality'), true)
assert.equal(isRouteActive('/dashboard/settings/ai/analytics', '/dashboard/settings/ai'), false)
assert.equal(isAdminRoute('/dashboard/admin/data-quality'), true, 'active Admin child highlights its parent')
assert.equal(isAdminRoute('/dashboard/settings/ai/analytics'), true, 'AI Analytics activates Admin')
assert.equal(isAdminRoute('/dashboard/leads'), false)

assert.match(sidebar, /md:w-64/, 'expanded desktop sidebar width is present')
assert.match(sidebar, /md:w-\[4\.5rem\]/, 'collapsed desktop sidebar width is present')
assert.match(sidebar, /title=\{collapsed \? item\.label/, 'collapsed links expose hover labels')
assert.match(sidebar, /aria-label=\{collapsed \? item\.label/, 'collapsed links retain accessible names')
assert.match(sidebar, /aria-expanded=\{adminOpen\}/, 'Admin disclosure exposes its state')
assert.match(sidebarContext, /localStorage\.setItem/, 'desktop collapse preference persists locally')
assert.match(sidebar, /event\.key === 'Escape'/, 'mobile drawer supports keyboard dismissal')
assert.match(sidebar, /onClick=\{onNavigate\}/, 'navigation links call their route-selection handler')
assert.match(sidebar, /handleNavigate = useCallback\(\(\) => close\(\)/, 'route selection closes the mobile drawer')
assert.match(sidebar, /navigationSections\.map/, 'primary product areas render from shared navigation')
assert.match(sidebar, /Sign out/, 'account control renders in the pinned utility section')
assert.match(topBar, /md:hidden/, 'mobile menu button is limited to mobile widths')
assert.match(topBar, /aria-controls="app-sidebar"/, 'mobile menu button identifies its drawer')
assert.match(globals, /--page-gutter: clamp/, 'page shell spacing responds continuously to viewport width')
assert.match(globals, /prefers-reduced-motion/, 'shell motion respects reduced-motion preferences')
assert.match(sidebarContext, /SIDEBAR_COLLAPSED_KEY/, 'collapse preference has a stable storage key')

const majorRoutes = [
  'src/app/dashboard/page.tsx',
  'src/app/dashboard/leads/page.tsx',
  'src/app/dashboard/dm-queue/page.tsx',
  'src/app/dashboard/pipeline/page.tsx',
  'src/app/dashboard/email-log/page.tsx',
  'src/app/dashboard/email-report/page.tsx',
  'src/app/dashboard/delivery-failures/page.tsx',
  'src/app/dashboard/lifecycle/page.tsx',
  'src/app/dashboard/deals/page.tsx',
  'src/app/dashboard/settings/page.tsx',
  'src/app/dashboard/settings/ai/page.tsx',
  'src/app/dashboard/settings/ai/analytics/page.tsx',
  'src/app/dashboard/admin/page.tsx',
  'src/app/dashboard/admin/data-quality/page.tsx',
]

for (const route of majorRoutes) {
  assert.equal(existsSync(resolve(route)), true, `${route} remains available`)
  assert.match(source(route), /TopBar title=/, `${route} uses the shared page header`)
}

console.log('Responsive app shell UI tests passed')
