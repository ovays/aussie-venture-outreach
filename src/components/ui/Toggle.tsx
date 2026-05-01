'use client'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div className="relative">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <div
          className={`w-10 h-6 rounded-full transition-colors ${checked ? 'bg-sky-500' : 'bg-gray-600'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        />
        <div
          className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`}
        />
      </div>
      {label && <span className="text-sm" style={{ color: '#94a3b8' }}>{label}</span>}
    </label>
  )
}
