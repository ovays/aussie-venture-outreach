interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  options: Array<{ value: string; label: string }>
  placeholder?: string
}

export function Select({ label, options, placeholder, className = '', ...props }: SelectProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium" style={{ color: '#94a3b8' }}>
          {label}
        </label>
      )}
      <select
        className={`w-full px-3 py-2 rounded-lg text-sm text-white outline-none focus:ring-2 focus:ring-sky-500 ${className}`}
        style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
