import { loadAISettings } from '@/ai/settings'
import { AISettings } from '@/components/settings/AISettings'
import TopBar from '@/components/layout/TopBar'
import { requireUser } from '@/lib/auth'
import Link from 'next/link'

export const revalidate = 0

export default async function AISettingsPage() {
  const { profile } = await requireUser()
  const settings = await loadAISettings()

  return (
    <div>
      <TopBar title="AI Settings" />
      <div className="page-content max-w-6xl">
        {profile.role === 'admin' && (
          <div className="mb-4 flex justify-end">
            <Link
              href="/dashboard/settings/ai/analytics"
              className="control-field inline-flex items-center px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              View AI Analytics
            </Link>
          </div>
        )}
        <AISettings initialSettings={settings} canEdit={profile.role === 'admin'} />
      </div>
    </div>
  )
}
