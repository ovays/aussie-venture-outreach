import { createServiceClient } from '@/lib/supabase/server'
import { searchBusinesses } from '@/lib/outscraper'

export async function runFinderAgent(): Promise<number> {
  const supabase = createServiceClient()

  // 🔹 Check system active
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System paused')
    return 0
  }

  // 🔹 Read limits from settings
  const { data: leadSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_lead_limit')
    .single()

  const { data: emailSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_email_limit')
    .single()

  const { data: dmSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_dm_limit')
    .single()

  const TOTAL_TARGET = parseInt(leadSetting?.value ?? '5', 10)
  const EMAIL_TARGET = parseInt(emailSetting?.value ?? '4', 10)
  const INSTA_TARGET = parseInt(dmSetting?.value ?? '1', 10)

  console.log("Targets:", { TOTAL_TARGET, EMAIL_TARGET, INSTA_TARGET })

  // 🔹 Get active categories
  const { data: categories } = await supabase
    .from('categories')
    .select('*')
    .eq('status', 'active')

  if (!categories?.length) {
    console.log('No active categories')
    return 0
  }

  let totalFound = 0

  for (const category of categories) {
    if (totalFound >= TOTAL_TARGET) break

    const keywords: string[] = category.search_keywords ?? []

    for (const keyword of keywords) {
      if (totalFound >= TOTAL_TARGET) break

      // 🔥 Single broad query (cheap & effective)
      const query = `${keyword} Sydney NSW`

      let emailCount = 0
      let instaCount = 0

      let batch = 0
      const MAX_BATCHES = 3   // 🔥 limits cost
      const BATCH_SIZE = 10   // 🔥 small = cheaper

      while (
        (emailCount < EMAIL_TARGET || instaCount < INSTA_TARGET) &&
        batch < MAX_BATCHES
      ) {
        console.log(`Batch ${batch + 1}: ${query}`)

        const results = await searchBusinesses(query, BATCH_SIZE)

        if (!results.length) break

        for (const result of results) {
          if (totalFound >= TOTAL_TARGET) break

          let email = result.email

          // 🔥 HUMAN BEHAVIOUR: try website for email
          if (!email && result.site) {
            try {
              const res = await fetch(result.site)
              const html = await res.text()

              const match = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
              if (match) email = match[0]
            } catch {}
          }

          // ✅ EMAIL FIRST
          if (email && emailCount < EMAIL_TARGET) {
            const { data: existing } = await supabase
              .from('leads')
              .select('id')
              .eq('business_name', result.name)
              .limit(1)

            if (existing?.length) continue

            await supabase.from('leads').insert({
              business_name: result.name,
              category_id: category.id,
              category_name: category.name,
              halal: category.halal_filter,
              address: result.full_address,
              city: 'Sydney',
              phone: result.phone || null,
              email,
              website: result.site || null,
              google_rating: result.rating || null,
              google_reviews_count: result.reviews || null,
              status: 'new',
            })

            emailCount++
            totalFound++

            console.log("✅ EMAIL:", result.name)
            continue
          }

          // ✅ INSTAGRAM ONLY AFTER EMAIL DONE
          if (!email && emailCount >= EMAIL_TARGET && instaCount < INSTA_TARGET) {
            await supabase.from('leads').insert({
              business_name: result.name,
              category_id: category.id,
              category_name: category.name,
              halal: category.halal_filter,
              address: result.full_address,
              city: 'Sydney',
              phone: result.phone || null,
              email: null,
              website: result.site || null,
              google_rating: result.rating || null,
              google_reviews_count: result.reviews || null,
              status: 'new',
            })

            instaCount++
            totalFound++

            console.log("📱 INSTA:", result.name)
          }

          if (emailCount >= EMAIL_TARGET && instaCount >= INSTA_TARGET) break
        }

        batch++
      }

      console.log(`Finished keyword → Emails: ${emailCount}, Insta: ${instaCount}`)
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'finder_complete',
    description: `Finder completed - ${totalFound} leads`,
    metadata: { totalFound }
  })

  console.log("TOTAL FOUND:", totalFound)
  return totalFound
}