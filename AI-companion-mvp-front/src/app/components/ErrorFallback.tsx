"use client"

import { useEffect, useMemo } from "react"
import { RefreshCw, Home, MessageSquare } from "lucide-react"
import { useCopy, useTranslation } from "../copy"
import { logger } from "../lib/error-logger"

type ErrorFallbackProps = {
  error?: Error
  errorMessage?: string
  errorType?: "network" | "timeout" | "serverError" | "voiceError" | "processingError" | "unexpected"
  onReset?: () => void
  showHomeLink?: boolean
}

/**
 * Fallback UI shown when a component crashes
 * 
 * Features:
 * - Personalized error messages with Sophia's voice
 * - Reset/retry action
 * - Navigation options
 * - Maintains Sophia's gentle aesthetic
 */
export function ErrorFallback({
  error,
  errorMessage,
  errorType,
  onReset,
  showHomeLink = true,
}: ErrorFallbackProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  useEffect(() => {
    // Log error details (can be sent to monitoring service)
    logger.logError(error, { component: 'ErrorFallback', action: 'render' })
  }, [error])

  // Get personalized error message based on type
  const errorContent = useMemo(() => {
    if (errorMessage) {
      return { title: t("errorFallback.unknownTitle"), message: errorMessage }
    }
    
    if (errorType && copy.errors[errorType]) {
      return copy.errors[errorType]
    }
    
    // Default to unexpected error
    return copy.errors.unexpected
  }, [copy.errors, errorMessage, errorType, t])

  return (
    <div className="flex min-h-[400px] items-center justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-6 rounded-3xl bg-sophia-surface p-6 text-center shadow-soft">
        {/* Icon */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sophia-error/10">
          <MessageSquare className="h-8 w-8 text-sophia-error" />
        </div>

        {/* Title */}
        <div>
          <h2 className="text-xl font-semibold text-sophia-text">
            {errorContent.title}
          </h2>
          <p className="mt-2 text-sm text-sophia-text2">
            {errorContent.message}
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-sophia-purple px-6 py-3 text-sm font-medium text-white shadow-md transition-all hover:scale-[1.02] hover:shadow-lg active:scale-[0.98]"
            >
              <RefreshCw className="h-4 w-4" />
              {t("errorFallback.tryAgain")}
            </button>
          )}

          {showHomeLink && (
            <a
              href="/"
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-sophia-surface-border bg-sophia-button px-6 py-3 text-sm font-medium text-sophia-text transition-all hover:border-sophia-purple/40 hover:bg-sophia-button-hover"
            >
              <Home className="h-4 w-4" />
              {t("errorFallback.goHome")}
            </a>
          )}
        </div>

        {/* Development info */}
        {process.env.NODE_ENV === 'development' && error?.stack && (
          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-xs text-sophia-text2 hover:text-sophia-text">
              {t("errorFallback.devInfoSummary")}
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-sophia-bg p-3 text-[10px] text-sophia-text2">
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
