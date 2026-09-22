import type { ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info } from 'lucide-react'

export function Toast({ children, tone = 'info' }: { children: ReactNode; tone?: 'success' | 'error' | 'info' }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertCircle : Info
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl border bg-[var(--surface-raised)] p-4 shadow-lg ${tone === 'success' ? 'border-[var(--success-border)] text-[var(--success)]' : tone === 'error' ? 'border-[var(--error-border)] text-[var(--error)]' : 'border-[var(--info-border)] text-[var(--info)]'}`}><Icon size={18} className="mt-0.5 shrink-0" /><div className="text-sm text-[var(--text-primary)]">{children}</div></div>
}
