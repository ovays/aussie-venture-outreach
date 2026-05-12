'use client'

import { Suspense } from 'react'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LockKeyhole } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createClient()
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    const res = await fetch('/api/auth/me')
    const body = await res.json()

    if (!res.ok || !body.data?.profile?.is_active) {
      await supabase.auth.signOut()
      setError('This account is inactive. Contact an administrator.')
      setLoading(false)
      return
    }

    if (!remember) {
      window.addEventListener('beforeunload', () => {
        supabase.auth.signOut()
      }, { once: true })
    }

    const next = searchParams.get('next')
    router.push(next?.startsWith('/dashboard') ? next : '/dashboard')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#0f1117' }}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(2,132,199,0.18),transparent_32rem)]" />
      <div className="relative w-full max-w-md px-8 py-10 rounded-xl shadow-2xl" style={{ background: '#1a1d27', border: '1px solid #2a2d3e' }}>
        <div className="mb-8">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300">
            <LockKeyhole size={20} />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">ReachAgent</h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Secure outreach automation workspace</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="admin@company.com"
              className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Password"
              className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>

          <label className="flex items-center gap-3 text-sm" style={{ color: '#94a3b8' }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-950 accent-sky-500"
            />
            Remember this session
          </label>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 px-4 py-2.5 rounded-lg">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg font-semibold text-white transition-opacity disabled:opacity-50"
            style={{ background: '#0284c7' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed" style={{ color: '#64748b' }}>
          Access is restricted to administrator-created accounts. Public signup, OAuth, and magic links are disabled for this internal platform.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
