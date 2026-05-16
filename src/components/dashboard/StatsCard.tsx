interface StatsCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: string
}

export function StatsCard({ label, value, sub, accent = '#e2e8f0' }: StatsCardProps) {
  return (
    <div
      className="rounded-xl p-4 md:p-5 flex flex-col"
      style={{
        background: '#1e2130',
        border: '1px solid #2a2d3e',
        borderTop: `2px solid ${accent}`,
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#64748b' }}>
        {label}
      </p>
      <p className="text-2xl md:text-3xl font-bold leading-none" style={{ color: accent }}>
        {value}
      </p>
      {sub && (
        <p className="text-xs mt-1.5" style={{ color: '#475569' }}>{sub}</p>
      )}
    </div>
  )
}
