'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0f1117' }}>
      <div className="w-full max-w-md px-8 py-10 rounded-2xl" style={{ background: '#1a1d27', border: '1px solid #2a2d3e' }}>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Aussie Venture</h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Outreach System — Admin Panel</p>
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
              placeholder="hello@aussieventure.com"
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
              placeholder="••••••••"
              className="w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500"
              style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
            />
          </div>

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
      </div>
    </div>
  )
}
