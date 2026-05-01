interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Input({ label, className = '', ...props }: InputProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium" style={{ color: '#94a3b8' }}>
          {label}
        </label>
      )}
      <input
        className={`w-full px-3 py-2 rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-sky-500 ${className}`}
        style={{ background: '#0f1117', border: '1px solid #2a2d3e' }}
        {...props}
      />
    </div>
  )
}
