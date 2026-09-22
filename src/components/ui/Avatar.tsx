interface AvatarProps {
  name?: string | null
  email?: string | null
  size?: 'sm' | 'md'
}

export function Avatar({ name, email, size = 'md' }: AvatarProps) {
  const source = name?.trim() || email?.trim() || 'ReachAgent User'
  const initials = source
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-muted)] font-semibold text-[var(--primary)] ${size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-xs'}`}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}
