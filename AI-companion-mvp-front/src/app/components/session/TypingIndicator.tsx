/**
 * TypingIndicator Component
 * Sprint 1+ - Subtle breathing dots while Sophia thinks
 * 
 * Features:
 * - Very slow, calming pulse animation
 * - Sophia's signature purple
 * - Minimal, non-distracting
 * - Optional cancel button for stream interruption
 */

'use client';

import { cn } from '../../lib/utils';

interface TypingIndicatorProps {
  /** Additional CSS classes */
  className?: string;
  /** Optional callback to cancel/stop streaming */
  onCancel?: () => void;
  /** Label for cancel button (optional, defaults to "Cancel") */
  cancelLabel?: string;
}

export function TypingIndicator({ className, onCancel, cancelLabel = "Cancel" }: TypingIndicatorProps) {
  return (
    <div 
      className={cn(
        "inline-flex items-center gap-3 py-2 px-3 bg-sophia-surface/60 rounded-2xl",
        className
      )}
      role="status"
      aria-live="polite"
      aria-label="Sophia is thinking"
    >
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-2 h-2 rounded-full bg-sophia-purple"
            style={{
              animation: 'sophiaBounce 1.4s ease-in-out infinite',
              animationDelay: `${i * 160}ms`,
            }}
          />
        ))}
      </div>
      
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="ml-2 text-xs font-medium text-sophia-text2 hover:text-sophia-purple transition-colors px-2 py-1 rounded hover:bg-sophia-surface"
          aria-label={cancelLabel}
        >
          {cancelLabel}
        </button>
      )}
      
      <style jsx>{`
        @keyframes sophiaBounce {
          0%, 80%, 100% {
            transform: scale(0.6);
            opacity: 0.5;
          }
          40% {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
