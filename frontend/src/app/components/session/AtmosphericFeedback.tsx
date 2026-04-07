/**
 * AtmosphericFeedback Component
 * Unit 7 — R20, R29
 *
 * Session-level feedback overlay with atmospheric glass styling.
 * Replaces per-message thumbs up/down with a single end-of-session
 * rating (1-5 stars) + quick tags. Reuses SessionFeedbackData schema.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import { useFeedbackStore } from '../../stores/feedback-store';
import type { FeedbackType } from '../../types/sophia-ui-message';

const FEELING_OPTIONS = [
  { id: 'lighter', label: 'lighter' },
  { id: 'seen', label: 'seen' },
  { id: 'clearer', label: 'clearer' },
  { id: 'raw', label: 'still raw' },
  { id: 'unsettled', label: 'unsettled' },
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
  const [selectedFeeling, setSelectedFeeling] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const { setFeedback, setSessionFeedback } = useFeedbackStore();

  useEffect(() => {
    if (!isVisible) {
      setRating(null);
      setSelectedFeeling(null);
      setMessage('');
      setSubmitted(false);
    }
  }, [isVisible]);

  const handleRating = useCallback((value: Rating) => {
    haptic('light');
    setRating(value);
  }, []);

  const handleFeeling = useCallback((feelingId: string) => {
    haptic('light');
    setSelectedFeeling((prev) => (prev === feelingId ? null : feelingId));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!rating) {
      return;
    }

    haptic('medium');
    const feedbackType: FeedbackType = rating && rating >= 4 ? 'helpful' :
                                       rating && rating <= 2 ? 'not_helpful' : 'helpful';
    setFeedback(`session-${sessionId}`, feedbackType);
    setSessionFeedback({
      session_id: sessionId,
      rating,
      ...(selectedFeeling ? { feeling: selectedFeeling } : {}),
      ...(message.trim().length > 0 ? { message: message.trim() } : {}),
      created_at: new Date().toISOString(),
    });
    setSubmitted(true);
    setTimeout(onComplete, 1200);
  }, [message, onComplete, rating, selectedFeeling, sessionId, setFeedback, setSessionFeedback]);

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

            {/* Feeling check-in */}
            {rating && (
              <div className="space-y-3 animate-fadeIn">
                <p className="text-[11px] uppercase tracking-[0.12em]" style={{ color: 'var(--cosmic-text-muted)' }}>
                  how do you feel now?
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                {FEELING_OPTIONS.map((feeling) => (
                  <button
                    key={feeling.id}
                    onClick={() => handleFeeling(feeling.id)}
                    className={cn(
                      'rounded-full px-3 py-1.5',
                      'text-[11px] tracking-[0.06em]',
                      'transition-all duration-200',
                      'cosmic-focus-ring',
                      selectedFeeling === feeling.id
                        ? 'cosmic-accent-pill'
                        : 'cosmic-ghost-pill',
                    )}
                  >
                    {feeling.label}
                  </button>
                ))}
                </div>
                <div className="mx-auto max-w-sm text-left">
                  <label
                    className="mb-2 block text-[11px] uppercase tracking-[0.12em]"
                    htmlFor="session-feedback-message"
                    style={{ color: 'var(--cosmic-text-muted)' }}
                  >
                    anything else?
                  </label>
                  <textarea
                    id="session-feedback-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={3}
                    maxLength={280}
                    placeholder="leave a short note about how this felt"
                    className={cn(
                      'min-h-[88px] w-full resize-none rounded-2xl border px-4 py-3 text-sm',
                      'bg-[color:var(--cosmic-surface)]/80 text-[color:var(--cosmic-text)]',
                      'border-[color:var(--cosmic-border)] backdrop-blur-md outline-none transition-colors',
                      'placeholder:text-[color:var(--cosmic-text-muted)]',
                      'focus:border-[color:var(--cosmic-accent)]',
                    )}
                  />
                </div>
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
