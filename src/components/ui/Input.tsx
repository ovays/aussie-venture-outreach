import { useId } from 'react'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Input({ label, className = '', ...props }: InputProps) {
  const generatedId = useId()
  const id = props.id ?? generatedId
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-[var(--text-secondary)]">
          {label}
        </label>
      )}
      <input
        id={id}
        className={`control-field w-full px-3 py-2 text-sm ${className}`}
        {...props}
      />
    </div>
  )
}
