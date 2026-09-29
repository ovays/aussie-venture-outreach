import { loadAISettings } from '@/ai/settings'
import { AISettings } from '@/components/settings/AISettings'
import TopBar from '@/components/layout/TopBar'
import { requireInternalPage } from '@/lib/page-access'
import Link from 'next/link'

export const revalidate = 0

export default async function AISettingsPage() {
  await requireInternalPage()
  const settings = await loadAISettings()

  return (
    <div>
      <TopBar title="AI Settings" />
      <div className="page-content max-w-6xl">
        <div className="mb-4 flex justify-end">
          <Link
            href="/dashboard/settings/ai/analytics"
            className="control-field inline-flex items-center px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            View AI Analytics
          </Link>
        </div>
        <AISettings initialSettings={settings} canEdit />
      </div>
    </div>
  )
}
