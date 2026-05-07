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
        <div
          style={{
            padding: '16px',
            borderRadius: '8px',
            border: '1px solid #7f1d1d',
            background: '#450a0a',
            color: '#f87171',
            fontSize: '14px',
          }}
        >
          {this.props.label ? `${this.props.label} failed to load` : 'This section failed to load'}
          {this.state.message && (
            <span style={{ display: 'block', fontSize: '12px', color: '#fca5a5', marginTop: '4px' }}>
              {this.state.message}
            </span>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
