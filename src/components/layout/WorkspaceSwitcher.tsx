import { Building2 } from 'lucide-react'

export function WorkspaceSwitcher({ name, compact = false }: { name: string; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300" title={name} aria-label={`Current workspace: ${name}`}>
        <Building2 size={17} aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.055] px-3 py-2.5" aria-label={`Current workspace: ${name}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-slate-200">
        <Building2 size={16} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">Workspace</span>
        <span className="block truncate text-xs font-semibold text-slate-100">{name}</span>
      </span>
    </div>
  )
}
