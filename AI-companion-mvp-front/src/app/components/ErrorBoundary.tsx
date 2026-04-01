"use client"

import React, { Component, ReactNode } from "react"
import { ErrorFallback } from "./ErrorFallback"
//import { logger } from "../lib/error-logger"

type ErrorBoundaryProps = {
  children: ReactNode
  fallback?: ReactNode
  componentName?: string
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

type ErrorBoundaryState = {
  hasError: boolean
  error?: Error
}

/**
 * Reusable Error Boundary component
 * 
 * Wraps components that might crash and shows a fallback UI instead of
 * breaking the entire app. Useful for modals, panels, and isolated features.
 * 
 * Usage:
 * <ErrorBoundary componentName="ProfilePanel">
 *   <ProfilePanel />
 * </ErrorBoundary>
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error }
  }

  // componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
  //   // Log error to monitoring service
  //   logger.error(error, {
  //     component: this.props.componentName || 'ErrorBoundary',
  //     metadata: {
  //       componentStack: errorInfo.componentStack,
  //     },
  //   })

  //   // Call optional error callback
  //   this.props.onError?.(error, errorInfo)
  // }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback or default ErrorFallback
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorFallback
          error={this.state.error}
          onReset={this.handleReset}
          showHomeLink={false}
        />
      )
    }

    return this.props.children
  }
}
