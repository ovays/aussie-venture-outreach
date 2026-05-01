import { createClient } from '@/lib/supabase/server'
import TopBar from '@/components/layout/TopBar'
import { SystemSettings } from '@/components/settings/SystemSettings'
import { CategoriesTable } from '@/components/settings/CategoriesTable'
import { Card } from '@/components/ui/Card'

export const revalidate = 0

export default async function SettingsPage() {
  const supabase = await createClient()

  const [{ data: settings }, { data: categories }] = await Promise.all([
    supabase.from('settings').select('*').order('key'),
    supabase.from('categories').select('*').order('name'),
  ])

  return (
    <div>
      <TopBar title="Settings" />
      <div className="p-6 space-y-6 max-w-4xl">
        <Card>
          <SystemSettings initialSettings={settings ?? []} />
        </Card>

        <Card>
          <CategoriesTable initialCategories={categories ?? []} />
        </Card>
      </div>
    </div>
  )
}
