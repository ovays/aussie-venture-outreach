import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string
  noPadding?: boolean
}

export function Card({ children, className = '', title, noPadding }: CardProps) {
  return (
    <div
      className={`rounded-xl ${noPadding ? '' : 'p-4 md:p-5'} ${className}`}
      style={{ background: '#1e2130', border: '1px solid #2a2d3e' }}
    >
      {title && (
        <h3 className="text-sm font-semibold text-white mb-3 md:mb-4">{title}</h3>
      )}
      {children}
    </div>
  )
}
