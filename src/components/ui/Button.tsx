import React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'primary', size = 'md', className = '', children, ...props }: ButtonProps) {
  const base = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-transparent font-medium transition-colors disabled:pointer-events-none disabled:opacity-45'

  const variants: Record<string, string> = {
    primary:   'bg-[var(--primary)] text-slate-950 hover:bg-[var(--primary-hover)]',
    secondary: 'border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
    ghost:     'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
    danger:    'border-[rgb(251_113_133_/_20%)] bg-[var(--error-muted)] text-[var(--error)] hover:bg-[rgb(251_113_133_/_18%)]',
  }

  const sizes: Record<string, string> = {
    sm: 'min-h-8 px-3 py-1 text-xs',
    md: 'px-4 py-2 text-sm',
  }

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
