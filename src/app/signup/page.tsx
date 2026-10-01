'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, UserPlus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function SignupPage() {
  const router = useRouter()
  const [form, setForm] = useState({ fullName: '', email: '', password: '', workspaceName: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState(false)
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value })

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    if (form.fullName.trim().length < 2 || form.workspaceName.trim().length < 2) { setError('Enter your full name and business name.'); setBusy(false); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters.'); setBusy(false); return }
    const supabase = createClient()
    const { data, error: signupError } = await supabase.auth.signUp({
      email: form.email.trim().toLowerCase(), password: form.password,
      options: { data: { full_name: form.fullName.trim(), workspace_name: form.workspaceName.trim() }, emailRedirectTo: `${window.location.origin}/login` },
    })
    if (signupError) { setError(signupError.message); setBusy(false); return }
    if (!data.session) { setConfirmation(true); setBusy(false); return }
    router.push('/no-workspace'); router.refresh()
  }

  if (confirmation) return <main className="flex min-h-dvh items-center justify-center bg-[#F7F8FC] px-5"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><h1 className="text-2xl font-semibold text-slate-900">Check your email</h1><p className="mt-3 text-sm leading-6 text-slate-600">Confirm your email address, then sign in. Your private workspace will be created after authentication.</p><Link href="/login" className="mt-6 inline-flex text-sm font-semibold text-indigo-600">Back to sign in</Link></section></main>

  return <main className="flex min-h-dvh items-center justify-center bg-[#F7F8FC] px-5 py-10"><section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_20px_60px_rgb(15_23_42_/_8%)] sm:p-8"><div className="mb-7"><span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><UserPlus size={19} /></span><h1 className="text-2xl font-semibold text-slate-900">Create your ReachAgent account</h1><p className="mt-1 text-sm text-slate-500">Your business gets a new, isolated workspace.</p></div><form onSubmit={submit} className="space-y-4">
    <Field label="Full name" value={form.fullName} onChange={set('fullName')} autoComplete="name" />
    <Field label="Email" value={form.email} onChange={set('email')} type="email" autoComplete="email" />
    <Field label="Password" value={form.password} onChange={set('password')} type="password" autoComplete="new-password" hint="At least 8 characters" />
    <Field label="Business / workspace name" value={form.workspaceName} onChange={set('workspaceName')} autoComplete="organization" />
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Creating account…' : 'Create account'}{!busy && <ArrowRight size={16} />}</button>
  </form><p className="mt-6 text-center text-sm text-slate-500">Already have an account? <Link href="/login" className="font-semibold text-indigo-600">Sign in</Link></p></section></main>
}

function Field({ label, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span><input {...props} required className="h-11 w-full rounded-lg border border-slate-300 px-3.5 text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" />{hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}</label>
}
