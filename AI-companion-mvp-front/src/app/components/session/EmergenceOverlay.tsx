/**
 * EmergenceOverlay Component
 * Unit 7 — R18, R19
 *
 * Full-screen atmospheric veil with staggered reveals of session takeaways.
 * Nebula dims behind it (coreIntensity 0.2, flowEnergy 0.1).
 * Tap anywhere or wait 8s to advance to feedback.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { cn } from '../../lib/utils';
import type { RitualArtifacts } from '../../types/session';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EmergenceOverlayProps {
  artifacts: RitualArtifacts | null | undefined;
  isVisible: boolean;
  onComplete: () => void;
  onDimPresence?: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTO_ADVANCE_MS = 8000;

// Stagger delays for each element
const DELAYS = {
  veil: 0,
  takeaway: 500,
  divider: 2000,
  reflection: 3000,
  tags: 4500,
};

// ─── Component ───────────────────────────────────────────────────────────────

export function EmergenceOverlay({
  artifacts,
  isVisible,
  onComplete,
  onDimPresence,
}: EmergenceOverlayProps) {
  const [phase, setPhase] = useState<'hidden' | 'entering' | 'visible' | 'exiting'>('hidden');
  const [revealStep, setRevealStep] = useState(0);

  const takeaway = artifacts?.takeaway?.trim();
  const reflection = artifacts?.reflection_candidate?.prompt?.trim();
  const memoryTags = (artifacts?.memory_candidates ?? [])
    .filter((m) => m?.memory?.trim())
    .slice(0, 3);

  // Enter when visible
  useEffect(() => {
    if (isVisible && phase === 'hidden') {
      setPhase('entering');
      onDimPresence?.();
      // Fade veil in over 2.5s then mark visible
      const timer = setTimeout(() => setPhase('visible'), 2500);
      return () => clearTimeout(timer);
    }
    if (!isVisible && phase !== 'hidden') {
      setPhase('exiting');
    }
  }, [isVisible, phase, onDimPresence]);

  // Staggered reveals
  useEffect(() => {
    if (phase !== 'entering' && phase !== 'visible') return;

    const timers = [
      setTimeout(() => setRevealStep(1), DELAYS.takeaway),
      setTimeout(() => setRevealStep(2), DELAYS.divider),
      setTimeout(() => setRevealStep(3), DELAYS.reflection),
      setTimeout(() => setRevealStep(4), DELAYS.tags),
    ];

    return () => timers.forEach(clearTimeout);
  }, [phase]);

  // Auto-advance after 8s
  useEffect(() => {
    if (phase !== 'entering' && phase !== 'visible') return;
    const timer = setTimeout(() => {
      setPhase('exiting');
      setTimeout(onComplete, 600);
    }, AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  // Exit cleanup
  useEffect(() => {
    if (phase === 'exiting') {
      const timer = setTimeout(() => setPhase('hidden'), 600);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const handleTap = useCallback(() => {
    if (phase === 'entering' || phase === 'visible') {
      setPhase('exiting');
      setTimeout(onComplete, 600);
    }
  }, [phase, onComplete]);

  if (phase === 'hidden') return null;

  const isActive = phase === 'entering' || phase === 'visible';
  const isExiting = phase === 'exiting';

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center',
        'transition-opacity duration-[2500ms] ease-out',
        isActive ? 'opacity-100' : 'opacity-0',
      )}
      style={{ backgroundColor: 'rgba(3, 3, 8, 0.55)' }}
      onClick={handleTap}
      role="dialog"
      aria-label="Session summary"
    >
      <div className="max-w-md px-8 text-center space-y-6">
        {/* Takeaway — Cormorant 24px */}
        {takeaway && (
          <p
            className={cn(
              'font-cormorant text-[24px] leading-snug text-white/[0.92]',
              'transition-all duration-1000',
              revealStep >= 1 && !isExiting ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3',
            )}
          >
            {takeaway}
          </p>
        )}

        {/* Divider */}
        <div
          className={cn(
            'mx-auto w-12 h-px bg-white/[0.08]',
            'transition-all duration-700',
            revealStep >= 2 && !isExiting ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
          )}
        />

        {/* Reflection — Cormorant italic 17px */}
        {reflection && (
          <p
            className={cn(
              'font-cormorant italic text-[17px] leading-relaxed text-white/60',
              'transition-all duration-1000',
              revealStep >= 3 && !isExiting ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
            )}
          >
            {reflection}
          </p>
        )}

        {/* Memory tags */}
        {memoryTags.length > 0 && (
          <div
            className={cn(
              'flex flex-wrap justify-center gap-2',
              'transition-all duration-700',
              revealStep >= 4 && !isExiting ? 'opacity-100' : 'opacity-0',
            )}
          >
            {memoryTags.map((tag, i) => (
              <span
                key={i}
                className="px-3 py-1 rounded-full text-[10px] tracking-[0.08em] uppercase bg-white/[0.04] border border-white/[0.06] text-white/35"
              >
                {tag.memory}
              </span>
            ))}
          </div>
        )}

        {/* Skip hint */}
        <p
          className={cn(
            'text-[10px] tracking-[0.12em] uppercase text-white/10',
            'transition-opacity duration-1000 delay-[5000ms]',
            isActive ? 'opacity-100' : 'opacity-0',
          )}
        >
          tap to continue
        </p>
      </div>
    </div>
  );
}
