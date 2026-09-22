export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`block animate-pulse rounded-lg bg-[var(--surface-hover)] ${className}`} aria-hidden="true" />
}
