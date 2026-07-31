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
      <div className="p-3 md:p-6 max-w-6xl">
        {profile.role === 'admin' && (
          <div className="mb-4 flex justify-end">
            <Link
              href="/dashboard/settings/ai/analytics"
              className="rounded-lg border px-3 py-2 text-sm text-slate-300 hover:text-white"
              style={{ borderColor: '#2a2d3e', background: '#11141d' }}
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
