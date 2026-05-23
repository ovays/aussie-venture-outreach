'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

interface ActionQueueCardProps {
  icon: ReactNode
  count: number
  title: string
  subtitle: string
  detail?: string
  ctaLabel: string
  ctaHref: string
  accent: string
  urgency: 'critical' | 'high' | 'medium' | 'normal'
}

const urgencyDot: Record<string, string> = {
  critical: '#f87171',
  high:     '#fb923c',
  medium:   '#fbbf24',
  normal:   '#34d399',
}

export function ActionQueueCard({
  icon,
  count,
  title,
  subtitle,
  detail,
  ctaLabel,
  ctaHref,
  accent,
  urgency,
}: ActionQueueCardProps) {
  const [hovered, setHovered] = useState(false)
  const dotColor = count === 0 ? '#1e2d3d' : urgencyDot[urgency]
  const hasPulse = count > 0 && (urgency === 'critical' || urgency === 'high')

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? `linear-gradient(145deg, #161927 0%, ${accent}0d 100%)`
          : 'linear-gradient(145deg, #161927 0%, #1a1d2e 100%)',
        border: `1px solid ${hovered ? `${accent}45` : 'rgba(255,255,255,0.055)'}`,
        boxShadow: hovered
          ? `0 0 40px ${accent}1c, 0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)`
          : '0 2px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)',
        transition: 'all 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
      className="rounded-2xl p-6 flex flex-col relative overflow-hidden min-h-[216px]"
    >
      {/* Top accent gradient line */}
      <div
        style={{
          background: `linear-gradient(90deg, ${accent} 0%, transparent 70%)`,
          opacity: hovered ? 1 : 0.4,
          transition: 'opacity 0.22s',
        }}
        className="absolute top-0 left-0 right-0 h-px"
      />

      {/* Icon + urgency dot */}
      <div className="flex items-start justify-between mb-5">
        <div
          style={{
            background: `${accent}16`,
            color: accent,
            boxShadow: hovered ? `0 0 16px ${accent}28` : 'none',
            transition: 'box-shadow 0.22s',
          }}
          className="rounded-xl p-2.5 flex-shrink-0"
        >
          {icon}
        </div>

        <span className="relative flex items-center justify-center mt-1.5 flex-shrink-0">
          {hasPulse && (
            <span
              style={{ background: dotColor, opacity: 0.35 }}
              className="absolute w-4 h-4 rounded-full animate-ping"
            />
          )}
          <span
            style={{
              background: dotColor,
              boxShadow: count > 0 ? `0 0 8px ${dotColor}60` : 'none',
            }}
            className="relative w-2 h-2 rounded-full block"
          />
        </span>
      </div>

      {/* Count */}
      <span
        style={{
          color: hovered ? accent : '#f1f5f9',
          transition: 'color 0.22s',
          fontVariantNumeric: 'tabular-nums',
        }}
        className="text-5xl font-bold leading-none tracking-tight"
      >
        {count.toLocaleString()}
      </span>

      {/* Title + subtitle */}
      <p className="text-[0.8125rem] font-semibold mt-3 mb-0.5 leading-snug" style={{ color: '#cbd5e1' }}>
        {title}
      </p>
      <p className="text-xs leading-relaxed" style={{ color: '#475569' }}>
        {subtitle}
      </p>

      {/* Breakdown detail */}
      {detail && (
        <p
          className="text-[0.6875rem] mt-2 font-mono tracking-wide"
          style={{ color: '#334155' }}
        >
          {detail}
        </p>
      )}

      <div className="flex-1" />

      {/* CTA */}
      <Link
        href={ctaHref}
        style={{
          color: accent,
          borderColor: `${accent}22`,
          background: hovered ? `${accent}18` : `${accent}0a`,
          transition: 'all 0.18s ease',
        }}
        className="mt-4 text-xs font-semibold border rounded-xl px-3.5 py-2.5 flex items-center gap-2"
      >
        <span className="flex-1">{ctaLabel}</span>
        <ArrowRight
          size={11}
          style={{
            transform: hovered ? 'translateX(3px)' : 'translateX(0)',
            transition: 'transform 0.18s ease',
          }}
        />
      </Link>
    </div>
  )
}
