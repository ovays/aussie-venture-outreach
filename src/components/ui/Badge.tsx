import { statusColor, statusLabel } from '@/lib/utils'

interface BadgeProps {
  status: string
  className?: string
}

export function StatusBadge({ status, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColor(status)} ${className}`}
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
    instagram: 'bg-pink-500/20 text-pink-400',
    facebook: 'bg-blue-500/20 text-blue-400',
  }
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[platform]}`}>
      {platform.charAt(0).toUpperCase() + platform.slice(1)}
    </span>
  )
}
