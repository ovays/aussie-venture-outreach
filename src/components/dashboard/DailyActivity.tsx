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
    <div className="overflow-x-auto -mx-4 md:-mx-5">
      <table className="w-full text-sm min-w-[480px]">
        <thead>
          <tr style={{ borderBottom: '1px solid #2a2d3e' }}>
            {['Date', 'Leads', 'Emails', 'DMs', 'Follow-ups'].map((h) => (
              <th
                key={h}
                className="px-4 md:px-5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider"
                style={{ color: '#475569' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.date}
              className={i % 2 === 0 ? '' : ''}
              style={{ borderBottom: '1px solid #1a1d27' }}
            >
              <td className="px-4 md:px-5 py-2.5 font-medium text-white whitespace-nowrap">{row.label}</td>
              <td className="px-4 md:px-5 py-2.5 tabular-nums" style={{ color: row.leadsFound  > 0 ? '#4ade80' : '#475569' }}>{row.leadsFound}</td>
              <td className="px-4 md:px-5 py-2.5 tabular-nums" style={{ color: row.emailsSent  > 0 ? '#38bdf8' : '#475569' }}>{row.emailsSent}</td>
              <td className="px-4 md:px-5 py-2.5 tabular-nums" style={{ color: row.dmsQueued   > 0 ? '#f472b6' : '#475569' }}>{row.dmsQueued}</td>
              <td className="px-4 md:px-5 py-2.5 tabular-nums" style={{ color: row.followupsSent > 0 ? '#a78bfa' : '#475569' }}>{row.followupsSent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
