import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string
  noPadding?: boolean
}

export function Card({ children, className = '', title, noPadding }: CardProps) {
  return (
    <div className={`surface ${noPadding ? '' : 'p-4 md:p-5'} ${className}`}>
      {title && (
        <h3 className="mb-3 text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)] md:mb-4">{title}</h3>
      )}
      {children}
    </div>
  )
}
