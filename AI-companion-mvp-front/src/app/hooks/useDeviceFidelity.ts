/**
 * useDeviceFidelity — detects low-end devices and prefers-reduced-motion.
 *
 * Unit 9 (R43, R44, R45)
 *
 * Returns:
 *  - reducedFidelity: true on mobile (<768px) or low-end CPU (≤4 cores)
 *  - reducedMotion: true when user prefers reduced motion
 *  - dprCap: device pixel ratio cap (1 on mobile, native on desktop)
 */

import { useState, useEffect } from 'react'

export interface DeviceFidelity {
  reducedFidelity: boolean
  reducedMotion: boolean
  dprCap: number
}

function detect(): DeviceFidelity {
  if (typeof window === 'undefined') {
    return { reducedFidelity: false, reducedMotion: false, dprCap: 1 }
  }

  const isNarrow = window.innerWidth < 768
  const isLowEnd =
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency <= 4

  const reducedFidelity = isNarrow || isLowEnd

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const dprCap = reducedFidelity ? 1 : Math.min(window.devicePixelRatio ?? 1, 2)

  return { reducedFidelity, reducedMotion, dprCap }
}

export function useDeviceFidelity(): DeviceFidelity {
  const [fidelity, setFidelity] = useState<DeviceFidelity>(detect)

  useEffect(() => {
    // Re-detect on resize (viewport could cross 768px threshold)
    const onResize = () => setFidelity(detect())

    // Listen for reduced-motion preference changes
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = () => setFidelity(detect())

    window.addEventListener('resize', onResize)
    mql.addEventListener('change', onMotionChange)

    return () => {
      window.removeEventListener('resize', onResize)
      mql.removeEventListener('change', onMotionChange)
    }
  }, [])

  return fidelity
}
