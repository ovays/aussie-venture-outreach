'use client'

import React from 'react'

interface Props {
  children: React.ReactNode
  label?: string
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-[var(--error-border)] bg-[var(--error-muted)] p-4 text-sm text-[var(--error)]" role="alert">
          {this.props.label ? `${this.props.label} failed to load` : 'This section failed to load'}
          {this.state.message && (
            <span className="mt-1 block text-xs text-[var(--text-secondary)]">
              {this.state.message}
            </span>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
