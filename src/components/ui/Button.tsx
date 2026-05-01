import React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'primary', size = 'md', className = '', children, ...props }: ButtonProps) {
  const variants = {
    primary: 'bg-sky-600 hover:bg-sky-500 text-white',
    secondary: 'text-white hover:text-white',
    ghost: 'hover:text-white',
    danger: 'bg-red-600/20 hover:bg-red-600/30 text-red-400',
  }
  const secondaryStyle = variant === 'secondary' ? { background: '#2a2d3e' } : {}
  const ghostStyle = variant === 'ghost' ? { color: '#94a3b8' } : {}

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
  }

  return (
    <button
      className={`inline-flex items-center gap-2 rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${className}`}
      style={{ ...secondaryStyle, ...ghostStyle }}
      {...props}
    >
      {children}
    </button>
  )
}
