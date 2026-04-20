/**
 * VisualTierBootstrap — headless client component that drives `data-visual-tier`
 * on <html> so CSS-only adaptations can fire immediately.
 *
 * Renders nothing. Must be placed inside the Providers tree (or any client boundary).
 */

'use client'

import { useVisualTier } from './hooks/useVisualTier'

export function VisualTierBootstrap() {
  // The hook itself sets document.documentElement[data-visual-tier] via useEffect.
  useVisualTier()
  return null
}
