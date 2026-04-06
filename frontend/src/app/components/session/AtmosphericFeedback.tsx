/**
 * AtmosphericFeedback Component
 * Unit 7 — R20, R29
 *
 * Session-level feedback overlay with atmospheric glass styling.
 * Replaces per-message thumbs up/down with a single end-of-session
 * rating (1-5 stars) + quick tags. Reuses SessionFeedbackData schema.
 */

'use client';

import { useState, useCallback } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import { useFeedbackStore } from '../../stores/feedback-store';
import type { FeedbackType } from '../../types/sophia-ui-message';

// ─── Quick tags (atmospheric labels, no emoji) ──────────────────────────────

const QUICK_TAGS = [
  { id: 'felt_heard', label: 'felt heard' },
  { id: 'new_perspective', label: 'new perspective' },
  { id: 'calmer_now', label: 'calmer now' },
  { id: 'more_clear', label: 'more clear' },
  { id: 'was_rushed', label: 'felt rushed' },
  { id: 'want_more', label: 'want more' },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

type Rating = 1 | 2 | 3 | 4 | 5;

interface AtmosphericFeedbackProps {
  sessionId: string;
  isVisible: boolean;
  onComplete: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AtmosphericFeedback({
  sessionId,
  isVisible,
  onComplete,
}: AtmosphericFeedbackProps) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const { setFeedback } = useFeedbackStore();

  const handleRating = useCallback((value: Rating) => {
    haptic('light');
    setRating(value);
  }, []);

  const handleTag = useCallback((tagId: string) => {
    haptic('light');
    setSelectedTags((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId],
    );
  }, []);

  const handleSubmit = useCallback(() => {
    haptic('medium');
    const feedbackType: FeedbackType = rating && rating >= 4 ? 'helpful' :
                                       rating && rating <= 2 ? 'not_helpful' : 'helpful';
    setFeedback(`session-${sessionId}`, feedbackType);
    setSubmitted(true);
    setTimeout(onComplete, 1200);
  }, [sessionId, rating, setFeedback, onComplete]);

  const handleSkip = useCallback(() => {
    haptic('light');
    onComplete();
  }, [onComplete]);

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center',
        'animate-fadeIn',
      )}
      style={{ backgroundColor: 'var(--cosmic-modal-backdrop)' }}
    >
      <div className="max-w-sm w-full mx-6 text-center space-y-6">
        {submitted ? (
          /* Thank you state */
          <p className="font-cormorant text-[20px] animate-fadeIn" style={{ color: 'var(--cosmic-text)' }}>
            thank you
          </p>
        ) : (
          <>
            {/* Prompt */}
            <p className="font-cormorant text-[18px]" style={{ color: 'var(--cosmic-text)' }}>
              how was this session?
            </p>

            {/* Star rating — glass pills */}
            <div className="flex items-center justify-center gap-3">
              {([1, 2, 3, 4, 5] as Rating[]).map((value) => (
                <button
                  key={value}
                  onClick={() => handleRating(value)}
                  className={cn(
                    'h-10 w-10 rounded-full',
                    'transition-all duration-200',
                    'cosmic-focus-ring',
                    rating && value <= rating
                      ? 'cosmic-accent-pill'
                      : 'cosmic-ghost-pill',
                  )}
                  aria-label={`Rate ${value} of 5`}
                >
                  <span className="text-[14px]">{value <= (rating ?? 0) ? '★' : '☆'}</span>
                </button>
              ))}
            </div>

            {/* Quick tags — glass pills */}
            {rating && (
              <div className="flex flex-wrap justify-center gap-2 animate-fadeIn">
                {QUICK_TAGS.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => handleTag(tag.id)}
                    className={cn(
                      'rounded-full px-3 py-1.5',
                      'text-[11px] tracking-[0.06em]',
                      'transition-all duration-200',
                      'cosmic-focus-ring',
                      selectedTags.includes(tag.id)
                        ? 'cosmic-accent-pill'
                        : 'cosmic-ghost-pill',
                    )}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-center gap-4 pt-2">
              {rating && (
                <button
                  onClick={handleSubmit}
                  className={cn(
                    'cosmic-accent-pill cosmic-focus-ring rounded-full px-5 py-2 text-[11px] tracking-[0.08em] uppercase transition-all duration-200',
                  )}
                >
                  done
                </button>
              )}
              <button
                onClick={handleSkip}
                className={cn(
                  'cosmic-whisper-button cosmic-focus-ring rounded text-[10px] tracking-[0.08em]',
                  'transition-all duration-200',
                )}
              >
                skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
