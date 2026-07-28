import * as dotenv from 'dotenv'
import { resolve } from 'path'
dotenv.config({ path: resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
async function main() {
  const { data, error } = await db.from('categories').select('name, status, content_type, cities, city_content_types').order('name')
  if (error) { console.error(error); process.exit(1) }
  for (const c of data!) console.log(JSON.stringify(c))
}
main()
