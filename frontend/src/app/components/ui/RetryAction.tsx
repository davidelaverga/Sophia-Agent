"use client";

import { cn } from "../../lib/utils";

interface RetryActionProps {
  message: string;
  onRetry: () => void;
  onDismiss?: () => void;
  retryLabel?: string;
  dismissLabel?: string;
  className?: string;
}

export function RetryAction({
  message,
  onRetry,
  onDismiss,
  retryLabel = "Retry",
  dismissLabel = "Dismiss",
  className,
}: RetryActionProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-sophia-surface-border bg-sophia-surface/70 px-4 py-3",
        "shadow-soft",
        "motion-safe:animate-fadeIn",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <p className="text-sm text-sophia-text2">{message}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium",
            "bg-sophia-purple text-white",
            "transition-all hover:bg-sophia-purple/90 active:scale-[0.98]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
          )}
        >
          {retryLabel}
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium",
              "text-sophia-text2 hover:bg-sophia-surface-alt",
            "transition-all active:scale-[0.98]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            )}
          >
            {dismissLabel}
          </button>
        )}
      </div>
    </div>
  );
}
