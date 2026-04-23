'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'sophia-onboarded';

interface TourStep {
  /** CSS selector for the target element */
  target: string;
  /** Short line — what this element does */
  text: string;
  /** Position of the tooltip relative to the spotlight */
  placement: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: TourStep[] = [
  {
    target: '[data-onboarding="preset-tab-gaming"]',
    text: 'Set your context — it shapes the rituals',
    placement: 'top',
  },
  {
    target: '[data-onboarding^="ritual-card-"]',
    text: 'Choose a ritual to focus the conversation',
    placement: 'bottom',
  },
  {
    target: '[data-onboarding="mic-cta"]',
    text: 'Tap to talk with Sophia',
    placement: 'bottom',
  },
];

/** Compute the union bounding box across all elements matching a selector. */
function getUnionRect(selector: string, pad: number): Rect | null {
  const els = document.querySelectorAll(selector);
  if (els.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.left < minX) minX = r.left;
    if (r.top < minY) minY = r.top;
    if (r.right > maxX) maxX = r.right;
    if (r.bottom > maxY) maxY = r.bottom;
  });

  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getTooltipPosition(
  rect: Rect,
  placement: TourStep['placement'],
): React.CSSProperties {
  const pad = 16;
  switch (placement) {
    case 'top':
      return {
        left: rect.x + rect.width / 2,
        top: rect.y - pad,
        transform: 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        left: rect.x + rect.width / 2,
        top: rect.y + rect.height + pad,
        transform: 'translate(-50%, 0)',
      };
    case 'left':
      return {
        left: rect.x - pad,
        top: rect.y + rect.height / 2,
        transform: 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        left: rect.x + rect.width + pad,
        top: rect.y + rect.height / 2,
        transform: 'translate(0, -50%)',
      };
  }
}

interface OnboardingSpotlightProps {
  disabled?: boolean;
}

export function OnboardingSpotlight({ disabled = false }: OnboardingSpotlightProps) {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Only show on first visit — defer check to avoid SSR mismatch
  useEffect(() => {
    if (disabled) {
      setActive(false);
      return;
    }

    if (!localStorage.getItem(STORAGE_KEY)) {
      // Wait for orbit reveal animations to finish (~1.5s)
      const t = setTimeout(() => setActive(true), 1800);
      return () => clearTimeout(t);
    }
  }, [disabled]);

  // Measure target element whenever step changes
  useEffect(() => {
    if (!active) return;
    const { target } = STEPS[step];
    setTooltipVisible(false);

    // Small delay to let previous transition finish
    const id = setTimeout(() => {
      const pad = 6;
      const rect = getUnionRect(target, pad);
      if (!rect) return;
      setTargetRect(rect);
      // Fade tooltip in after spotlight moves
      setTimeout(() => setTooltipVisible(true), 300);
    }, 80);
    return () => clearTimeout(id);
  }, [active, step]);

  const advance = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      localStorage.setItem(STORAGE_KEY, '1');
      setActive(false);
    }
  }, [step]);

  // Allow skip via Escape
  useEffect(() => {
    if (!active) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        localStorage.setItem(STORAGE_KEY, '1');
        setActive(false);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [active]);

  if (!active || !targetRect) return null;

  const currentStep = STEPS[step];
  const tooltipPos = getTooltipPosition(targetRect, currentStep.placement);

  // SVG mask: full-screen opaque with a rounded-rect cutout over the target
  const rx = 18;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50"
      onClick={advance}
      style={{ cursor: 'pointer' }}
    >
      {/* Overlay with cutout */}
      <svg className="absolute inset-0 h-full w-full">
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={targetRect.x}
              y={targetRect.y}
              width={targetRect.width}
              height={targetRect.height}
              rx={rx}
              fill="black"
              className="transition-all duration-500 ease-out"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.62)"
          mask="url(#spotlight-mask)"
          className="transition-all duration-500 ease-out"
        />
      </svg>

      {/* Glow ring around the cutout */}
      <div
        className="absolute rounded-[18px] transition-all duration-500 ease-out"
        style={{
          left: targetRect.x,
          top: targetRect.y,
          width: targetRect.width,
          height: targetRect.height,
          boxShadow:
            '0 0 0 1px color-mix(in srgb, var(--sophia-purple) 30%, transparent), ' +
            '0 0 28px 6px color-mix(in srgb, var(--sophia-purple) 16%, transparent)',
          pointerEvents: 'none',
        }}
      />

      {/* Tooltip */}
      <div
        className="absolute flex flex-col items-center gap-3 transition-all duration-400 ease-out"
        style={{
          ...tooltipPos,
          opacity: tooltipVisible ? 1 : 0,
          pointerEvents: 'none',
        }}
      >
        <p
          className="whitespace-nowrap rounded-full px-5 py-2.5 text-[13px] font-light tracking-wide"
          style={{
            color: 'var(--cosmic-text)',
            background: 'color-mix(in srgb, var(--cosmic-panel-strong) 88%, transparent)',
            backdropFilter: 'blur(12px)',
            border: '1px solid color-mix(in srgb, var(--sophia-purple) 18%, transparent)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }}
        >
          {currentStep.text}
        </p>

        {/* Step dots */}
        <div className="flex gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className="h-1 rounded-full transition-all duration-300"
              style={{
                width: i === step ? 16 : 4,
                background:
                  i === step
                    ? 'var(--sophia-purple)'
                    : 'color-mix(in srgb, var(--cosmic-text-muted) 40%, transparent)',
              }}
            />
          ))}
        </div>
      </div>

      {/* Skip hint */}
      <p
        className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] font-light tracking-wider"
        style={{ color: 'var(--cosmic-text-whisper)', opacity: 0.6 }}
      >
        tap anywhere to continue
      </p>
    </div>
  );
}
