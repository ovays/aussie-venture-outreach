interface DailyRow {
  date: string
  label: string
  leadsFound: number
  emailsSent: number
  dmsQueued: number
  followupsSent: number
}

interface DailyActivityProps {
  rows: DailyRow[]
}

export function DailyActivity({ rows }: DailyActivityProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
            {['Date', 'Leads Found', 'Emails Sent', 'DMs Queued', 'Follow-ups Sent'].map((h) => (
              <th
                key={h}
                className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider"
                style={{ color: '#64748b' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date} style={{ borderBottom: '1px solid #1e2130' }}>
              <td className="px-4 py-2.5 font-medium text-white">{row.label}</td>
              <td className="px-4 py-2.5" style={{ color: row.leadsFound > 0 ? '#4ade80' : '#64748b' }}>
                {row.leadsFound}
              </td>
              <td className="px-4 py-2.5" style={{ color: row.emailsSent > 0 ? '#38bdf8' : '#64748b' }}>
                {row.emailsSent}
              </td>
              <td className="px-4 py-2.5" style={{ color: row.dmsQueued > 0 ? '#f472b6' : '#64748b' }}>
                {row.dmsQueued}
              </td>
              <td className="px-4 py-2.5" style={{ color: row.followupsSent > 0 ? '#a78bfa' : '#64748b' }}>
                {row.followupsSent}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
