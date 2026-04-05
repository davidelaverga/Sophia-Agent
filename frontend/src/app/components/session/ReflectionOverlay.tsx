/**
 * ReflectionOverlay Component
 * Unit 6 — R38-R40
 *
 * Center-screen atmospheric reflection prompt. Sophia poses a reflective
 * question; user can respond via voice or tap to dismiss. The overlay
 * fades in over 1.5s, lingers, then fades out. When active the nebula
 * shifts to "reflecting" state for a mini-emergence feel.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReflectionOverlayProps {
  /** The reflective question Sophia poses */
  question: string | null;
  /** User's spoken/typed response (streamed in) */
  response?: string | null;
  /** Called when user dismisses manually */
  onDismiss: () => void;
  /** Called when overlay starts to fire presence state change */
  onActivate?: () => void;
  /** Called when overlay fully exits */
  onExit?: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FADE_IN_MS = 1500;
const RESPONSE_HOLD_MS = 4000;
const FADE_OUT_MS = 1500;

// ─── Component ───────────────────────────────────────────────────────────────

type Phase = 'entering' | 'active' | 'response' | 'exiting' | 'hidden';

export function ReflectionOverlay({
  question,
  response,
  onDismiss,
  onActivate,
  onExit,
}: ReflectionOverlayProps) {
  const [phase, setPhase] = useState<Phase>('hidden');

  // Enter when question arrives
  useEffect(() => {
    if (question && phase === 'hidden') {
      setPhase('entering');
      onActivate?.();
      const timer = setTimeout(() => setPhase('active'), FADE_IN_MS);
      return () => clearTimeout(timer);
    }
    if (!question && phase !== 'hidden') {
      setPhase('exiting');
    }
  }, [question, phase, onActivate]);

  // Response phase — hold then exit
  useEffect(() => {
    if (response && (phase === 'active' || phase === 'entering')) {
      setPhase('response');
      const timer = setTimeout(() => setPhase('exiting'), RESPONSE_HOLD_MS);
      return () => clearTimeout(timer);
    }
  }, [response, phase]);

  // Fully exit after fade-out
  useEffect(() => {
    if (phase === 'exiting') {
      const timer = setTimeout(() => {
        setPhase('hidden');
        onExit?.();
      }, FADE_OUT_MS);
      return () => clearTimeout(timer);
    }
  }, [phase, onExit]);

  const handleDismiss = useCallback(() => {
    haptic('light');
    setPhase('exiting');
    onDismiss();
  }, [onDismiss]);

  if (phase === 'hidden') return null;

  const isVisible = phase === 'active' || phase === 'response';
  const isEntering = phase === 'entering';
  const isExiting = phase === 'exiting';

  return (
    <div
      className={cn(
        'fixed inset-0 z-30 flex items-center justify-center',
        'pointer-events-auto',
      )}
      onClick={handleDismiss}
      role="dialog"
      aria-label="Sophia is reflecting"
    >
      <div className="max-w-md px-8 text-center">
        {/* Reflective question */}
        <p
          className={cn(
            'font-cormorant text-[20px] leading-relaxed text-white/70',
            'transition-all',
            isEntering && 'opacity-0 translate-y-2',
            isVisible && 'opacity-100 translate-y-0',
            isExiting && 'opacity-0 -translate-y-1',
          )}
          style={{
            transitionDuration: isEntering ? `${FADE_IN_MS}ms` : `${FADE_OUT_MS}ms`,
          }}
        >
          {question}
        </p>

        {/* User response — italic, softer */}
        {response && (
          <p
            className={cn(
              'mt-4 font-cormorant italic text-[16px] text-white/45',
              'transition-all',
              phase === 'response' ? 'opacity-100' : 'opacity-0',
            )}
            style={{ transitionDuration: '800ms' }}
          >
            {response}
          </p>
        )}

        {/* Whisper dismiss hint */}
        {isVisible && !response && (
          <p
            className={cn(
              'mt-6 text-[10px] tracking-[0.12em] uppercase text-white/15',
              'transition-opacity duration-1000',
              phase === 'active' ? 'opacity-100' : 'opacity-0',
            )}
          >
            tap anywhere to dismiss
          </p>
        )}
      </div>
    </div>
  );
}
