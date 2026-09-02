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

assert.equal(navigationSections[0].label, 'Core')
assert.deepEqual(navigationSections[0].items.map((item) => item.label), ['Dashboard', 'Leads', 'Pipeline', 'Deals'])
assert.equal(navigationSections[1].label, 'Outreach')
assert.deepEqual(
  navigationSections[1].items.map((item) => item.label),
  ['DM Queue', 'Email Log', 'Email Report', 'Delivery Failures', 'Lifecycle'],
)
assert.deepEqual(adminNavigation.map((item) => item.label), ['User Management', 'Data Quality', 'AI Analytics'])
assert.deepEqual(utilityNavigation.map((item) => item.label), ['Settings', 'AI Settings'])

assert.equal(isRouteActive('/dashboard', '/dashboard'), true)
assert.equal(isRouteActive('/dashboard/leads', '/dashboard'), false)
assert.equal(isRouteActive('/dashboard/admin/data-quality', '/dashboard/admin/data-quality'), true)
assert.equal(isRouteActive('/dashboard/settings/ai/analytics', '/dashboard/settings/ai'), false)
assert.equal(isAdminRoute('/dashboard/admin/data-quality'), true, 'active Admin child highlights its parent')
assert.equal(isAdminRoute('/dashboard/settings/ai/analytics'), true, 'AI Analytics activates Admin')
assert.equal(isAdminRoute('/dashboard/leads'), false)

assert.match(sidebar, /md:w-60/, 'expanded desktop sidebar width is present')
assert.match(sidebar, /md:w-\[4\.5rem\]/, 'collapsed desktop sidebar width is present')
assert.match(sidebar, /title=\{collapsed \? item\.label/, 'collapsed links expose hover labels')
assert.match(sidebar, /aria-label=\{collapsed \? item\.label/, 'collapsed links retain accessible names')
assert.match(sidebar, /aria-expanded=\{adminOpen\}/, 'Admin disclosure exposes its state')
assert.match(sidebar, /sessionStorage\.setItem\(ADMIN_OPEN_KEY/, 'Admin state lasts for the current session')
assert.match(sidebarContext, /localStorage\.setItem/, 'desktop collapse preference persists locally')
assert.match(sidebar, /event\.key === 'Escape'/, 'mobile drawer supports keyboard dismissal')
assert.match(sidebar, /onClick=\{onNavigate\}/, 'navigation links call their route-selection handler')
assert.match(sidebar, /handleNavigate = useCallback\(\(\) => close\(\)/, 'route selection closes the mobile drawer')
assert.match(sidebar, /utilityNavigation\.map/, 'Settings render in the pinned utility section')
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
