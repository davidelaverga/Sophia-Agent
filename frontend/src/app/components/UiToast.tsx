'use client'

import { CheckCircle, Info, AlertTriangle, XCircle, X } from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'

import { cn } from '../lib/utils'
import { useUiStore as useUiToastStore } from '../stores/ui-store'

export function UiToast() {
  const toast = useUiToastStore((s) => s.toast)
  const dismissToast = useUiToastStore((s) => s.dismissToast)
  const [isExiting, setIsExiting] = useState(false)
  const isCritical = toast?.variant === 'error' || toast?.variant === 'warning'

  const handleDismiss = useCallback(() => {
    setIsExiting(true)
    setTimeout(() => {
      dismissToast()
      setIsExiting(false)
    }, 200)
  }, [dismissToast])

  useEffect(() => {
    if (!toast) return
    setIsExiting(false)
    const effectiveDuration = isCritical
      ? Math.max(toast.durationMs, 5200)
      : toast.durationMs
    const t = setTimeout(() => handleDismiss(), effectiveDuration)
    return () => clearTimeout(t)
  }, [toast, handleDismiss, isCritical])

  if (!toast) return null

  const icon =
    toast.variant === 'success' ? <CheckCircle className="h-4 w-4" /> :
    toast.variant === 'warning' ? <AlertTriangle className="h-4 w-4" /> :
    toast.variant === 'error' ? <XCircle className="h-4 w-4" /> :
    <Info className="h-4 w-4" />

  const accent =
    toast.variant === 'success' ? 'text-emerald-500' :
    toast.variant === 'warning' ? 'text-amber-500' :
    toast.variant === 'error' ? 'text-sophia-error' :
    'text-sophia-purple/80'

  const title =
    toast.variant === 'success' ? 'Sophia remembers' :
    toast.variant === 'warning' ? 'Sophia heads-up' :
    toast.variant === 'error' ? 'Sophia couldn’t complete this yet' :
    'Sophia update'

  return (
    <>
      {isCritical && (
        <div className="pointer-events-none fixed inset-0 z-40 bg-sophia-bg/20 backdrop-blur-[1.5px]" aria-hidden="true" />
      )}

      <div className="pointer-events-none fixed top-4 left-0 right-0 z-50 flex justify-center px-4 pt-[env(safe-area-inset-top)]">
        <div
          className={cn(
            'pointer-events-auto w-full max-w-xl rounded-2xl border p-4 shadow-soft',
            'bg-sophia-surface/90 backdrop-blur-md',
            'transition-all duration-200 ease-out',
            isCritical && 'ring-1 ring-sophia-purple/25',
            isExiting
              ? 'opacity-0 -translate-y-2'
              : 'motion-safe:animate-fadeIn'
          )}
          role={isCritical ? 'alert' : 'status'}
          aria-live={isCritical ? 'assertive' : 'polite'}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span className={cn('shrink-0', accent)}>{icon}</span>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-sophia-text2/85">{title}</p>
              </div>
              <p className="min-w-0 text-sm text-sophia-text break-words leading-relaxed">{toast.message}</p>
            </div>

            <div className="flex items-center gap-2">
              {toast.action && (
                <button
                  type="button"
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-sophia-purple hover:bg-sophia-purple/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
                  onClick={() => {
                    toast.action?.onClick()
                    handleDismiss()
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                className="rounded-full border border-transparent p-1 text-sophia-text2 hover:text-sophia-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
                onClick={handleDismiss}
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
