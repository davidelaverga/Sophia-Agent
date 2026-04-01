"use client"

/**
 * useHaptics - Elegant haptic feedback for mobile interactions
 * 
 * Uses Capacitor Haptics API on native platforms (iOS/Android)
 * and falls back to the Vibration API on web.
 * 
 * Falls back gracefully on devices that don't support haptics.
 */

export type HapticPattern = 'light' | 'medium' | 'success' | 'error' | 'selection'

// Vibration patterns for web fallback (in milliseconds)
const WEB_PATTERNS: Record<HapticPattern, number | number[]> = {
  light: 10,           // Subtle tap
  medium: 25,          // Button press
  success: [10, 50, 20], // Short-pause-short
  error: [30, 50, 30],   // Stronger double tap
  selection: 15,        // Menu item selection
}

/**
 * Check if we're running in a native Capacitor environment
 */
function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as typeof window & { __CAPACITOR__?: unknown }).__CAPACITOR__
}

/**
 * Check if haptic feedback is supported and enabled (web fallback)
 */
function canVibrate(): boolean {
  if (typeof window === 'undefined') return false
  if (!('vibrate' in navigator)) return false
  
  // Check if user prefers reduced motion
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReducedMotion) return false
  
  return true
}

/**
 * Trigger haptic feedback using Capacitor on native, Vibration API on web
 */
export async function haptic(pattern: HapticPattern = 'light'): Promise<void> {
  // Check for reduced motion preference
  if (typeof window !== 'undefined') {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion) return
  }

  // Use Capacitor Haptics on native platforms
  if (isNative()) {
    try {
      const [{ Haptics, ImpactStyle, NotificationType }] = await Promise.all([
        import('@capacitor/haptics'),
      ])

      switch (pattern) {
        case 'light':
          await Haptics.impact({ style: ImpactStyle.Light })
          break
        case 'medium':
          await Haptics.impact({ style: ImpactStyle.Medium })
          break
        case 'success':
          await Haptics.notification({ type: NotificationType.Success })
          break
        case 'error':
          await Haptics.notification({ type: NotificationType.Error })
          break
        case 'selection':
          await Haptics.selectionStart()
          await Haptics.selectionEnd()
          break
      }
    } catch {
      // Silently fail if haptics not available
    }
    return
  }

  // Web fallback using Vibration API
  if (!canVibrate()) return
  
  try {
    navigator.vibrate(WEB_PATTERNS[pattern])
  } catch {
    // Silently fail if vibration not available
  }
}

/**
 * Hook that provides haptic feedback utilities
 */
export function useHaptics() {
  const isSupported = typeof window !== 'undefined' && 'vibrate' in navigator
  
  return {
    isSupported,
    
    /** Light tap for subtle interactions */
    light: () => haptic('light'),
    
    /** Medium tap for button presses */
    medium: () => haptic('medium'),
    
    /** Success pattern for confirmations */
    success: () => haptic('success'),
    
    /** Error pattern for failures */
    error: () => haptic('error'),
    
    /** Selection feedback for menu items */
    selection: () => haptic('selection'),
    
    /** Generic haptic with custom pattern */
    haptic,
  }
}

/**
 * withHaptic - HOC helper for adding haptic feedback to click handlers
 * 
 * Usage:
 * <button onClick={withHaptic(() => doSomething(), 'medium')}>Click me</button>
 */
export function withHaptic<T extends (...args: unknown[]) => unknown>(
  handler: T,
  pattern: HapticPattern = 'light'
): T {
  return ((...args: Parameters<T>) => {
    haptic(pattern)
    return handler(...args)
  }) as T
}
