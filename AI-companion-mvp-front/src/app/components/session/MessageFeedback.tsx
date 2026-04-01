/**
 * MessageFeedback Component
 * Sprint 1+ - Feedback UI for learning loop
 * 
 * Allows users to rate Sophia's responses as helpful/not helpful.
 * Feedback is stored locally and sent to backend when available.
 */

'use client';

import { useState, useCallback } from 'react';
import { ThumbsUp, ThumbsDown, Flag, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { FeedbackType } from '../../types/sophia-ui-message';

interface MessageFeedbackProps {
  messageId: string;
  currentFeedback?: FeedbackType;
  onFeedback: (messageId: string, feedback: FeedbackType) => void;
  className?: string;
  /** Show in compact mode (just icons) */
  compact?: boolean;
}

export function MessageFeedback({
  messageId,
  currentFeedback,
  onFeedback,
  className,
  compact = true,
}: MessageFeedbackProps) {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pendingFeedback, setPendingFeedback] = useState<FeedbackType | null>(null);

  const handleFeedback = useCallback((type: FeedbackType) => {
    if (type === 'inappropriate') {
      // Show confirmation for inappropriate flag
      setPendingFeedback(type);
      setShowConfirmation(true);
    } else {
      onFeedback(messageId, type);
    }
  }, [messageId, onFeedback]);

  const confirmFeedback = useCallback(() => {
    if (pendingFeedback) {
      onFeedback(messageId, pendingFeedback);
      setShowConfirmation(false);
      setPendingFeedback(null);
    }
  }, [messageId, pendingFeedback, onFeedback]);

  const cancelConfirmation = useCallback(() => {
    setShowConfirmation(false);
    setPendingFeedback(null);
  }, []);

  // Confirmation dialog for inappropriate flag
  if (showConfirmation) {
    return (
      <div className={cn(
        "flex items-center gap-2 p-2 bg-sophia-surface rounded-lg border border-sophia-surface-border",
        className
      )}>
        <span className="text-xs text-sophia-text2">Flag as inappropriate?</span>
        <button
          onClick={confirmFeedback}
          className="text-xs px-2 py-1 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
        >
          Confirm
        </button>
        <button
          onClick={cancelConfirmation}
          className="p-1 text-sophia-text2 hover:text-sophia-text transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center gap-1",
      compact ? "opacity-0 group-hover:opacity-100 transition-opacity" : "",
      className
    )}>
      {/* Helpful */}
      <FeedbackButton
        icon={ThumbsUp}
        isActive={currentFeedback === 'helpful'}
        onClick={() => handleFeedback('helpful')}
        label="Helpful"
        activeColor="text-green-500"
        compact={compact}
      />
      
      {/* Not helpful */}
      <FeedbackButton
        icon={ThumbsDown}
        isActive={currentFeedback === 'not_helpful'}
        onClick={() => handleFeedback('not_helpful')}
        label="Not helpful"
        activeColor="text-orange-500"
        compact={compact}
      />
      
      {/* Inappropriate (only show on hover in compact mode) */}
      {!compact && (
        <FeedbackButton
          icon={Flag}
          isActive={currentFeedback === 'inappropriate'}
          onClick={() => handleFeedback('inappropriate')}
          label="Inappropriate"
          activeColor="text-red-500"
          compact={compact}
        />
      )}
    </div>
  );
}

interface FeedbackButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
  onClick: () => void;
  label: string;
  activeColor: string;
  compact: boolean;
}

function FeedbackButton({
  icon: Icon,
  isActive,
  onClick,
  label,
  activeColor,
  compact,
}: FeedbackButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded transition-all",
        compact 
          ? "p-1.5 hover:bg-sophia-surface" 
          : "px-2 py-1 hover:bg-sophia-surface text-xs",
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
        isActive ? activeColor : "text-sophia-text2 hover:text-sophia-text"
      )}
      aria-label={label}
      aria-pressed={isActive}
    >
      <Icon className={cn("w-3.5 h-3.5", isActive && "fill-current")} />
      {!compact && <span>{label}</span>}
    </button>
  );
}

// =============================================================================
// FEEDBACK TOAST (confirmation after feedback)
// =============================================================================

interface FeedbackToastProps {
  feedback: FeedbackType;
  onClose: () => void;
}

export function FeedbackToast({ feedback, onClose }: FeedbackToastProps) {
  const messages: Record<FeedbackType, string> = {
    helpful: "Thanks! This helps Sophia learn.",
    not_helpful: "Got it. Sophia will try to do better.",
    inappropriate: "Flagged for review. Thank you.",
  };

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 animate-fadeIn">
      <div className="flex items-center gap-2 px-4 py-2 bg-sophia-surface border border-sophia-surface-border rounded-full shadow-lg">
        <span className="text-sm text-sophia-text">{messages[feedback]}</span>
        <button
          onClick={onClose}
          className="p-1 text-sophia-text2 hover:text-sophia-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple rounded"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
