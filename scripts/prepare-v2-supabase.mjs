import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = join(repositoryRoot, '.v2-local')
const linkPath = join(runtimeRoot, 'supabase')
const targetPath = realpathSync(join(repositoryRoot, 'supabase-v2'))

mkdirSync(runtimeRoot, { recursive: true })

try {
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) throw new Error(`${linkPath} exists but is not a link`)
  const linkedTarget = realpathSync(resolve(dirname(linkPath), readlinkSync(linkPath)))
  if (linkedTarget !== targetPath) throw new Error(`${linkPath} points to an unexpected target`)
  console.log(`V2 Supabase runtime link already targets ${targetPath}`)
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`Created V2 Supabase runtime link: ${linkPath} -> ${targetPath}`)
  } else {
    throw error
  }
}
