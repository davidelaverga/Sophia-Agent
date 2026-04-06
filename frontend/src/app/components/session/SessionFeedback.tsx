/**
 * Session Feedback
 * Sprint 1+ - End-of-session feedback collection
 * 
 * Appears on recap page or session completion.
 * Collects:
 * - Overall session rating (1-5 stars or thumbs)
 * - Optional freeform comment
 * - Quick tags (felt heard, new perspective, etc.)
 * 
 * Data persists to store and queues for backend sync.
 */

'use client';

import { useState, useCallback } from 'react';

import { cn } from '../../lib/utils';
import { useFeedbackStore } from '../../stores/feedback-store';
import type { FeedbackType } from '../../types/sophia-ui-message';

// =============================================================================
// TYPES
// =============================================================================

type SessionRating = 1 | 2 | 3 | 4 | 5;

interface QuickTag {
  id: string;
  label: string;
  emoji: string;
}

const QUICK_TAGS: QuickTag[] = [
  { id: 'felt_heard', label: 'Felt heard', emoji: '👂' },
  { id: 'new_perspective', label: 'New perspective', emoji: '💡' },
  { id: 'calmer_now', label: 'Calmer now', emoji: '😌' },
  { id: 'more_clear', label: 'More clear', emoji: '🎯' },
  { id: 'was_rushed', label: 'Felt rushed', emoji: '⏱️' },
  { id: 'want_more', label: 'Want more', emoji: '📖' },
];

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface SessionFeedbackProps {
  /** Session ID for this feedback */
  sessionId: string;
  /** Callback when feedback is submitted */
  onSubmit?: (data: SessionFeedbackData) => void;
  /** Optional: Skip to just show thank you */
  alreadySubmitted?: boolean;
  /** Variant */
  variant?: 'full' | 'compact' | 'inline';
  /** Additional CSS classes */
  className?: string;
}

export interface SessionFeedbackData {
  session_id: string;
  rating?: SessionRating;
  tags: string[];
  comment?: string;
  submitted_at: string;
}

export function SessionFeedback({
  sessionId,
  onSubmit,
  alreadySubmitted = false,
  variant = 'full',
  className,
}: SessionFeedbackProps) {
  const [rating, setRating] = useState<SessionRating | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(alreadySubmitted);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const { setFeedback } = useFeedbackStore();
  
  const handleTagToggle = useCallback((tagId: string) => {
    setSelectedTags(prev => 
      prev.includes(tagId)
        ? prev.filter(t => t !== tagId)
        : [...prev, tagId]
    );
  }, []);
  
  const handleSubmit = useCallback(async () => {
    if (!rating && selectedTags.length === 0 && !comment.trim()) {
      // Nothing to submit
      return;
    }
    
    setIsSubmitting(true);
    
    const feedbackData: SessionFeedbackData = {
      session_id: sessionId,
      rating: rating ?? undefined,
      tags: selectedTags,
      comment: comment.trim() || undefined,
      submitted_at: new Date().toISOString(),
    };
    
    // Store in feedback store (converts to message format for now)
    const feedbackType: FeedbackType = rating && rating >= 4 ? 'helpful' : 
                                       rating && rating <= 2 ? 'not_helpful' : 'helpful';
    
    setFeedback(`session-${sessionId}`, feedbackType);
    
    // Callback
    onSubmit?.(feedbackData);
    
    // Small delay for animation
    await new Promise(r => setTimeout(r, 300));
    
    setSubmitted(true);
    setIsSubmitting(false);
  }, [sessionId, rating, selectedTags, comment, setFeedback, onSubmit]);
  
  // ─────────────────────────────────────────────────────────────────────────
  // Submitted State
  // ─────────────────────────────────────────────────────────────────────────
  
  if (submitted) {
    return (
      <div className={cn(
        'text-center py-4 animate-fadeIn',
        className
      )}>
        <span className="text-2xl">🙏</span>
        <p className="text-sm text-sophia-text2 mt-2">
          Thanks for the feedback
        </p>
      </div>
    );
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // Compact Variant
  // ─────────────────────────────────────────────────────────────────────────
  
  if (variant === 'compact') {
    return (
      <div className={cn('space-y-2', className)}>
        <p className="text-xs text-sophia-text2">How was this session?</p>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => {
                setRating(star as SessionRating);
                // Auto-submit on compact
                setTimeout(() => {
                  void handleSubmit();
                }, 100);
              }}
              disabled={isSubmitting}
              className={cn(
                'text-lg transition-transform hover:scale-110',
                rating && star <= rating ? 'opacity-100' : 'opacity-30'
              )}
            >
              ⭐
            </button>
          ))}
        </div>
      </div>
    );
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // Full Variant
  // ─────────────────────────────────────────────────────────────────────────
  
  return (
    <div className={cn(
      'p-4 rounded-xl space-y-4',
      'bg-sophia-surface/50 border border-sophia-surface-border',
      className
    )}>
      {/* Header */}
      <div className="text-center">
        <h3 className="text-sm font-medium text-sophia-text">
          How was this session?
        </h3>
        <p className="text-xs text-sophia-text2 mt-1">
          Your feedback helps Sophia grow
        </p>
      </div>
      
      {/* Star Rating */}
      <div className="flex justify-center gap-2">
        {([1, 2, 3, 4, 5] as SessionRating[]).map((star) => (
          <button
            key={star}
            onClick={() => setRating(star)}
            disabled={isSubmitting}
            className={cn(
              'text-2xl transition-all duration-200',
              'hover:scale-125 active:scale-95',
              rating && star <= rating
                ? 'opacity-100 drop-shadow-glow'
                : 'opacity-30 grayscale'
            )}
            aria-label={`${star} stars`}
          >
            ⭐
          </button>
        ))}
      </div>
      
      {/* Quick Tags */}
      <div className="flex flex-wrap gap-2 justify-center">
        {QUICK_TAGS.map((tag) => (
          <button
            key={tag.id}
            onClick={() => handleTagToggle(tag.id)}
            disabled={isSubmitting}
            className={cn(
              'px-2 py-1 rounded-full text-xs transition-all duration-150',
              'border',
              selectedTags.includes(tag.id)
                ? 'bg-sophia-purple/10 border-sophia-purple/30 text-sophia-purple'
                : 'bg-sophia-surface border-sophia-surface-border text-sophia-text2 hover:border-sophia-purple/20'
            )}
          >
            {tag.emoji} {tag.label}
          </button>
        ))}
      </div>
      
      {/* Optional Comment */}
      <div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={isSubmitting}
          placeholder="Anything else? (optional)"
          rows={2}
          className={cn(
            'w-full px-3 py-2 rounded-lg text-sm resize-none',
            'bg-sophia-surface border border-sophia-surface-border',
            'placeholder:text-sophia-text2/50',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sophia-purple/30',
            'disabled:opacity-50'
          )}
        />
      </div>
      
      {/* Submit Button */}
      <div className="flex justify-center">
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || (!rating && selectedTags.length === 0 && !comment.trim())}
          className={cn(
            'px-6 py-2 rounded-lg text-sm font-medium',
            'bg-sophia-purple text-white',
            'hover:bg-sophia-purple/90 active:scale-[0.98]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'transition-all duration-150'
          )}
        >
          {isSubmitting ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[color:var(--cosmic-border)] border-t-[color:var(--cosmic-text)]" />
              Sending...
            </span>
          ) : (
            'Submit Feedback'
          )}
        </button>
      </div>
      
      {/* Skip Link */}
      <button
        onClick={() => setSubmitted(true)}
        className="block mx-auto text-xs text-sophia-text2 hover:text-sophia-text transition-colors"
      >
        Skip for now
      </button>
    </div>
  );
}

// =============================================================================
// INLINE VARIANT (for embedding in other components)
// =============================================================================

interface InlineSessionFeedbackProps {
  sessionId: string;
  onDone?: () => void;
}

export function InlineSessionFeedback({ sessionId, onDone }: InlineSessionFeedbackProps) {
  const [rating, setRating] = useState<SessionRating | null>(null);
  const [done, setDone] = useState(false);
  const { setFeedback } = useFeedbackStore();
  
  const handleRating = (star: SessionRating) => {
    setRating(star);
    
    const feedbackType: FeedbackType = star >= 4 ? 'helpful' : star <= 2 ? 'not_helpful' : 'helpful';
    
    setFeedback(`session-${sessionId}`, feedbackType);
    
    setTimeout(() => {
      setDone(true);
      onDone?.();
    }, 500);
  };
  
  if (done) {
    return (
      <span className="text-sm text-sophia-text2 animate-fadeIn">
        🙏 Thanks!
      </span>
    );
  }
  
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-xs text-sophia-text2 mr-1">Rate:</span>
      {([1, 2, 3, 4, 5] as SessionRating[]).map((star) => (
        <button
          key={star}
          onClick={() => handleRating(star)}
          className={cn(
            'text-sm transition-transform hover:scale-125',
            rating && star <= rating ? 'opacity-100' : 'opacity-30'
          )}
        >
          ⭐
        </button>
      ))}
    </span>
  );
}
