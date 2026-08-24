/**
 * Error logging and tracking utilities
 * 
 * Centralized error handling for:
 * - User-facing error messages
 * - Telemetry/monitoring
 * - Development debugging
 */

import * as Sentry from "@sentry/nextjs"

import { debugLog } from "./debug-logger"
import {
  ordinaryAnalyticsSinkAllowed,
  ordinaryServerErrorSinkAllowed,
} from "./synthetic-isolation-policy"

type ErrorContext = {
  component?: string
  action?: string
  userId?: string
  metadata?: Record<string, unknown>
  context?: string
  /** Server API routes pass their request so HttpOnly Voice Lab state can fence Sentry. */
  request?: Pick<Request, 'headers'>
  [key: string]: unknown
}

type TelemetryWindow = Window & {
  emitTelemetry?: (eventName: string, payload?: Record<string, unknown>) => void
}

type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info'

function errorSinkAllowed(context?: ErrorContext): boolean {
  return typeof window === 'undefined'
    ? ordinaryServerErrorSinkAllowed(context?.request, context?.userId)
    : ordinaryAnalyticsSinkAllowed()
}

class ErrorLogger {
  private static instance: ErrorLogger
  
  private constructor() {
    // Initialize Sentry or other monitoring service here
    this.initializeMonitoring()
  }
  
  static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger()
    }
    return ErrorLogger.instance
  }
  
  private initializeMonitoring() {
    // Sentry is initialized via sentry.client.config.ts and sentry.server.config.ts
    // This is just a marker for additional monitoring setup
  }
  
  /**
   * Log an error with context
   */
  logError(
    error: Error | unknown,
    context: ErrorContext = {},
    severity: ErrorSeverity = 'error'
  ) {
    if (!errorSinkAllowed(context)) return
    const errorMessage = error instanceof Error ? error.message : String(error)
    const { request: _request, ...safeContext } = context
    
    // Send to monitoring service (Sentry)
    try {
      // Only send to Sentry if DSN is configured
      if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
        const sentryLevel = severity === 'fatal' ? 'fatal' : severity
        
        Sentry.captureException(error, {
          level: sentryLevel,
          tags: {
            component: safeContext.component,
            action: safeContext.action,
            context: safeContext.context,
          },
          user: safeContext.userId ? { id: safeContext.userId } : undefined,
          extra: safeContext.metadata || safeContext,
        })
      }
      
      // Emit telemetry for internal tracking
      if (typeof window !== 'undefined' && 'emitTelemetry' in window) {
        ;(window as TelemetryWindow).emitTelemetry?.('error', {
          message: errorMessage,
          severity,
          component: safeContext.component,
          action: safeContext.action,
        })
      }
    } catch {
      // Never let error logging crash the app
    }
  }
  
  /**
   * Log a fatal error (app-breaking)
   */
  fatal(error: Error | unknown, context: ErrorContext = {}) {
    this.logError(error, context, 'fatal')
  }
  
  /**
   * Log a standard error (recoverable)
   */
  error(error: Error | unknown, context: ErrorContext = {}) {
    this.logError(error, context, 'error')
  }
  
  /**
   * Log a warning (potential issue)
   */
  warn(message: string, context: ErrorContext = {}) {
    this.logError(new Error(message), context, 'warning')
  }
  
  /**
   * Log informational message
   */
  info(message: string, context: ErrorContext = {}) {
    this.logError(new Error(message), context, 'info')
  }
  
  /**
   * Debug logging - only outputs in development
   * Use this for development debugging
   */
  debug(tag: string, message: string, data?: Record<string, unknown>) {
    if (process.env.NODE_ENV === 'development') {
      debugLog(tag, message, data)
    }
  }

  /**
   * Add breadcrumb for debugging context
   */
  addBreadcrumb(
    message: string,
    data?: Record<string, unknown>,
    request?: Pick<Request, 'headers'>,
    userId?: string,
  ) {
    if (!errorSinkAllowed({ request, userId })) return
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      Sentry.addBreadcrumb({
        message,
        data,
        timestamp: Date.now() / 1000, // Sentry expects seconds
      })
    }
  }
  
  /**
   * Set user context for error tracking
   */
  setUser(userId: string | null, email?: string, username?: string, request?: Pick<Request, 'headers'>) {
    if (!errorSinkAllowed({ request, userId: userId ?? undefined })) return
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      Sentry.setUser(userId ? { 
        id: userId,
        email,
        username,
      } : null)
    }
  }
}

// Export singleton instance
export const logger = ErrorLogger.getInstance()

// Export types for consumers
export type { ErrorContext, ErrorSeverity }
