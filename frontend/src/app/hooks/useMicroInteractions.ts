/**
 * Micro Interactions System
 * Sprint 1+ - UX Polish
 * 
 * Adds delightful micro-interactions throughout the app.
 * Small touches that make Sophia feel responsive and alive.
 */

import { haptic, type HapticPattern } from './useHaptics';

// ============================================================================
// CONFETTI / CELEBRATION
// ============================================================================

interface ConfettiConfig {
  count?: number;
  colors?: string[];
  duration?: number;
}

/**
 * Trigger a confetti burst animation
 * Used for session completion, achievements, etc.
 */
export function triggerConfetti(config: ConfettiConfig = {}): void {
  const {
    count = 50,
    colors = ['#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#f3e8ff'],
    duration = 2500,
  } = config;

  // Create container
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 9999;
  `;
  document.body.appendChild(container);

  // Create particles
  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    const size = 4 + Math.random() * 8;
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.5;
    const fallDuration = 2 + Math.random() * 1.5;

    particle.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      left: ${left}%;
      top: -${size}px;
      opacity: 0.9;
      animation: confettiFall ${fallDuration}s ease-out ${delay}s forwards;
    `;
    container.appendChild(particle);
  }

  // Cleanup
  setTimeout(() => container.remove(), duration);
}

// ============================================================================
// SUCCESS PULSE
// ============================================================================

/**
 * Add a success pulse effect to an element
 */
export function pulseSuccess(element: HTMLElement): void {
  element.classList.add('animate-success-pulse');
  setTimeout(() => element.classList.remove('animate-success-pulse'), 500);
}

// ============================================================================
// SHAKE ON ERROR
// ============================================================================

/**
 * Shake an element to indicate an error
 */
export function shakeError(element: HTMLElement): void {
  element.classList.add('animate-shake');
  haptic('error');
  setTimeout(() => element.classList.remove('animate-shake'), 500);
}

// ============================================================================
// COMBO FEEDBACK (Haptic + Visual)
// ============================================================================

type FeedbackType = 'success' | 'error' | 'warning' | 'neutral';

interface ComboFeedbackOptions {
  element?: HTMLElement;
  hapticPattern?: HapticPattern;
}

/**
 * Trigger combined haptic + visual feedback
 */
export function triggerFeedback(
  type: FeedbackType,
  options: ComboFeedbackOptions = {}
): void {
  const { element, hapticPattern } = options;

  // Haptic
  const hapticMap: Record<FeedbackType, HapticPattern> = {
    success: 'success',
    error: 'error',
    warning: 'medium',
    neutral: 'light',
  };
  haptic(hapticPattern ?? hapticMap[type]);

  // Visual
  if (element) {
    switch (type) {
      case 'success':
        pulseSuccess(element);
        break;
      case 'error':
        shakeError(element);
        break;
      default:
        // No visual for warning/neutral by default
        break;
    }
  }
}

// ============================================================================
// RIPPLE EFFECT
// ============================================================================

/**
 * Create a ripple effect at the touch/click point
 */
export function createRipple(
  event: React.MouseEvent | React.TouchEvent,
  color: string = 'rgba(139, 92, 246, 0.3)'
): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();

  // Get coordinates
  let x: number, y: number;
  if ('touches' in event) {
    x = event.touches[0].clientX - rect.left;
    y = event.touches[0].clientY - rect.top;
  } else {
    x = event.clientX - rect.left;
    y = event.clientY - rect.top;
  }

  // Create ripple element
  const ripple = document.createElement('span');
  const size = Math.max(rect.width, rect.height) * 2;

  ripple.style.cssText = `
    position: absolute;
    width: ${size}px;
    height: ${size}px;
    left: ${x - size / 2}px;
    top: ${y - size / 2}px;
    background: ${color};
    border-radius: 50%;
    transform: scale(0);
    animation: rippleEffect 0.6s ease-out;
    pointer-events: none;
  `;

  // Ensure target has position
  const originalPosition = target.style.position;
  if (getComputedStyle(target).position === 'static') {
    target.style.position = 'relative';
  }
  target.style.overflow = 'hidden';

  target.appendChild(ripple);

  // Cleanup
  setTimeout(() => {
    ripple.remove();
    if (!originalPosition) target.style.position = '';
  }, 600);
}

// ============================================================================
// STAGGER ANIMATION HELPER
// ============================================================================

/**
 * Generate stagger delay for a list of items
 */
export function getStaggerDelay(
  index: number,
  baseDelay: number = 50,
  maxDelay: number = 500
): string {
  const delay = Math.min(index * baseDelay, maxDelay);
  return `${delay}ms`;
}

/**
 * Get stagger style object for an item
 */
export function getStaggerStyle(
  index: number,
  baseDelay: number = 50
): React.CSSProperties {
  return {
    animationDelay: getStaggerDelay(index, baseDelay),
    animationFillMode: 'both',
  };
}

// ============================================================================
// NUMBER COUNTER ANIMATION
// ============================================================================

/**
 * Animate a number counting up
 * Returns cleanup function
 */
export function animateNumber(
  element: HTMLElement,
  from: number,
  to: number,
  duration: number = 1000,
  formatter?: (n: number) => string
): () => void {
  const startTime = performance.now();
  let animationId: number;

  const animate = (currentTime: number) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + (to - from) * eased);

    element.textContent = formatter ? formatter(current) : String(current);

    if (progress < 1) {
      animationId = requestAnimationFrame(animate);
    }
  };

  animationId = requestAnimationFrame(animate);

  return () => cancelAnimationFrame(animationId);
}
