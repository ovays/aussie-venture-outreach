'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, CheckCircle2, LockKeyhole } from 'lucide-react'
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
    e.preventDefault(); setLoading(true); setError('')
    const supabase = createClient()
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) { setError(authError.message); setLoading(false); return }
    const res = await fetch('/api/auth/me'); const body = await res.json()
    if (!res.ok || !body.data?.profile?.is_active) { await supabase.auth.signOut(); setError('This account is inactive. Contact an administrator.'); setLoading(false); return }
    if (!remember) window.addEventListener('beforeunload', () => { supabase.auth.signOut() }, { once: true })
    const next = searchParams.get('next'); router.push(next?.startsWith('/dashboard') || next === '/onboarding' ? next : '/dashboard'); router.refresh()
  }

  return <main className="grid min-h-screen bg-[#F7F8FC] lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.75fr)]">
    <section className="relative hidden overflow-hidden bg-[#111827] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(79,70,229,.42),transparent_28rem),radial-gradient(circle_at_80%_90%,rgba(6,182,212,.2),transparent_28rem)]" />
      <div className="relative flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500 font-black shadow-[0_10px_30px_rgb(79_70_229_/_35%)]">R</span><span className="text-base font-semibold">ReachAgent</span></div>
      <div className="relative max-w-xl"><p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Outreach, clearly managed</p><h1 className="text-4xl font-semibold leading-tight tracking-[-0.04em] xl:text-5xl">Turn lead activity into focused, consistent action.</h1><p className="mt-5 max-w-lg text-base leading-7 text-slate-400">One workspace for leads, outreach, campaigns, and the signals that matter.</p><div className="mt-8 flex flex-wrap gap-5 text-sm text-slate-300">{['Workspace scoped', 'Operationally clear', 'Built for teams'].map((label) => <span key={label} className="flex items-center gap-2"><CheckCircle2 size={15} className="text-cyan-400" />{label}</span>)}</div></div>
      <p className="relative text-xs text-slate-600">ReachAgent · Aussie Venture</p>
    </section>
    <section className="flex items-center justify-center px-5 py-10 sm:px-10">
      <div className="w-full max-w-md"><div className="mb-8 lg:hidden"><div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 font-black text-white">R</div><p className="text-sm font-semibold text-slate-900">ReachAgent</p></div><div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-[0_20px_60px_rgb(15_23_42_/_8%)] sm:p-8"><div className="mb-7"><div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><LockKeyhole size={19} /></div><h2 className="text-2xl font-semibold tracking-[-0.03em] text-slate-900">Welcome back</h2><p className="mt-1 text-sm text-slate-500">Sign in to your outreach workspace.</p></div>
        <form onSubmit={handleSubmit} className="space-y-4"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Email address</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@company.com" className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" placeholder="Enter your password" className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" /></label><label className="flex items-center gap-2.5 text-sm text-slate-600"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-indigo-600" />Remember this session</label>{error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}<button type="submit" disabled={loading} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50">{loading ? 'Signing in…' : 'Sign in'}{!loading && <ArrowRight size={16} />}</button></form>
        <p className="mt-6 text-xs leading-5 text-slate-400">Access is limited to administrator-created accounts. Contact your workspace administrator if you need access.</p>
      </div></div>
    </section>
  </main>
}

export default function LoginPage() { return <Suspense fallback={<div className="min-h-screen bg-[#F7F8FC]" />}><LoginForm /></Suspense> }
