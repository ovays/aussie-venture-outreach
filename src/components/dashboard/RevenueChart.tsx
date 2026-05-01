'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface WeeklyRevenue {
  week: string
  revenue: number
}

interface RevenueChartProps {
  data: WeeklyRevenue[]
}

export function RevenueChart({ data }: RevenueChartProps) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: '#64748b' }}>
        No revenue data yet
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
        <XAxis
          dataKey="week"
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={{ stroke: '#2a2d3e' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `$${v}`}
        />
        <Tooltip
          contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3e', borderRadius: '8px', color: '#e2e8f0' }}
          formatter={(v) => [`$${v}`, 'Revenue']}
        />
        <Line
          type="monotone"
          dataKey="revenue"
          stroke="#38bdf8"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: '#38bdf8' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
