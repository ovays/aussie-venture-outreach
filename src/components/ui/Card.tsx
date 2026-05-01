interface CardProps {
  children: React.ReactNode
  className?: string
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div
      className={`rounded-xl p-5 ${className}`}
      style={{ background: '#1e2130', border: '1px solid #2a2d3e' }}
    >
      {children}
    </div>
  )
}
