import { statusColor, statusLabel } from '@/lib/utils'

interface BadgeProps {
  status: string
  className?: string
}

export function StatusBadge({ status, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-full border border-current/15 px-2.5 py-0.5 text-[11px] font-medium leading-none ${statusColor(status)} ${className}`}
    >
      {statusLabel(status)}
    </span>
  )
}

interface PlatformBadgeProps {
  platform: 'instagram' | 'facebook'
}

export function PlatformBadge({ platform }: PlatformBadgeProps) {
  const styles = {
    instagram: 'bg-pink-500/10 text-pink-300',
    facebook: 'bg-blue-500/10 text-blue-300',
  }
  return (
    <span className={`inline-flex min-h-6 items-center rounded-full border border-current/15 px-2.5 py-0.5 text-[11px] font-medium ${styles[platform]}`}>
      {platform.charAt(0).toUpperCase() + platform.slice(1)}
    </span>
  )
}
