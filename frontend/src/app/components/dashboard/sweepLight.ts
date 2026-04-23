/**
 * sweepLight — Shared mutable state for an off-screen light source.
 *
 * CelestialComet writes position each frame (typically off-screen coords),
 * UI components read it via useSweepGlow() which computes directional
 * illumination and shadow angle without triggering React re-renders.
 */

import { useEffect, useMemo, useRef } from 'react';

import { useVisualTier } from '../../hooks/useVisualTier';
import {
  getCelestialCometProfile,
  shouldSkipTierFrame,
} from '../../lib/visual-tier-profiles';

/* ─── Global light state (no React, no re-renders) ─────────── */

export const sweepLight = {
  x: -9999,
  y: -9999,
  active: false,
  intensity: 0,
  /** Registered UI element occluders — shader blocks rays through these */
  occluders: [] as Array<{ cx: number; cy: number; r: number }>,
};

type SweepLightActiveListener = (isActive: boolean) => void;

const sweepLightActiveListeners = new Set<SweepLightActiveListener>();

export function isSweepLightVisible() {
  return sweepLight.active && sweepLight.intensity > 0.01;
}

function notifySweepLightActiveListeners(isActive: boolean) {
  sweepLightActiveListeners.forEach((listener) => listener(isActive));
}

export function subscribeSweepLightActive(listener: SweepLightActiveListener) {
  sweepLightActiveListeners.add(listener);
  return () => {
    sweepLightActiveListeners.delete(listener);
  };
}

export function publishSweepLightFrame(x: number, y: number, intensity: number) {
  const wasActive = isSweepLightVisible();
  const nextActive = intensity > 0.01;

  sweepLight.x = x;
  sweepLight.y = y;
  sweepLight.active = nextActive;
  sweepLight.intensity = intensity;

  if (wasActive !== nextActive) {
    notifySweepLightActiveListeners(nextActive);
  }
}

export function clearSweepLight() {
  const wasActive = isSweepLightVisible();

  sweepLight.active = false;
  sweepLight.intensity = 0;

  if (wasActive) {
    notifySweepLightActiveListeners(false);
  }
}

/* ─── Hook: directional glow for any element ────────────────── */

/**
 * Returns a ref to attach to the element. The element receives CSS custom
 * properties that update 60fps outside React:
 *
 * - `--sweep-glow` (0-1): how illuminated this element is
 * - `--sweep-angle` (radians): direction FROM the light TO the element (for shadow casting)
 *
 * Since the light is always off-screen, all visible elements receive some glow.
 * Distance falloff is very gentle — elements closer to the light's edge get more.
 */
export function useSweepGlow() {
  const elRef = useRef<HTMLElement>(null);
  const { tier, reducedMotion } = useVisualTier();
  const renderProfile = useMemo(() => getCelestialCometProfile(tier), [tier]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let raf = 0;
    let lastGlow = -1;
    let lastFrameTime = 0;

    // Register as a light occluder so the shader blocks rays through this element
    const occ = { cx: 0, cy: 0, r: 0 };
    sweepLight.occluders.push(occ);

    const stopLoop = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastFrameTime = 0;
    };

    const resetGlow = () => {
      if (lastGlow !== 0) {
        el.style.setProperty('--sweep-glow', '0');
        el.style.setProperty('--sweep-angle', '0rad');
        el.style.setProperty('--sweep-sx', '0');
        el.style.setProperty('--sweep-sy', '0');
        el.style.setProperty('--sweep-proximity', '0');
        lastGlow = 0;
      }
    };

    const syncOccluder = () => {
      const rect = el.getBoundingClientRect();
      occ.cx = rect.left + rect.width / 2;
      occ.cy = rect.top + rect.height / 2;
      occ.r = Math.max(rect.width, rect.height) / 2;
      return rect;
    };

    const update = (now: number) => {
      const rect = syncOccluder();

      if (!reducedMotion && shouldSkipTierFrame(now, lastFrameTime, renderProfile.frameIntervalMs)) {
        raf = requestAnimationFrame(update);
        return;
      }

      lastFrameTime = now;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      if (!isSweepLightVisible()) {
        resetGlow();
        stopLoop();
        return;
      }

      const dx = sweepLight.x - cx;
      const dy = sweepLight.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // The light is off-screen so dist is always large. Use viewport diagonal
      // as reference — elements near the top get ~0.8 glow, those near the
      // bottom get ~0.4. All elements are lit because it's a distant source.
      const viewDiag = Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2);
      const proximity = Math.max(0, 1 - dist / (viewDiag * 1.2));
      // Gentle quadratic falloff so all on-screen elements get some glow
      const glow = Math.max(0.08, proximity) * sweepLight.intensity;

      const rounded = Math.round(glow * 1000) / 1000;
      if (rounded !== lastGlow) {
        el.style.setProperty('--sweep-glow', `${rounded}`);
        // Angle FROM light TO element (for shadow direction on the far side)
        const angle = Math.atan2(cy - sweepLight.y, cx - sweepLight.x);
        el.style.setProperty('--sweep-angle', `${angle}rad`);
        // Pre-computed shadow direction (normalized) — avoids CSS cos()/sin() compat issues
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        el.style.setProperty('--sweep-sx', `${nx.toFixed(3)}`);
        el.style.setProperty('--sweep-sy', `${ny.toFixed(3)}`);
        // Raw proximity (0-1) for elements to differentiate effects by distance
        el.style.setProperty('--sweep-proximity', `${proximity.toFixed(3)}`);
        lastGlow = rounded;
      }

      raf = requestAnimationFrame(update);
    };

    const startLoop = () => {
      if (reducedMotion || raf) {
        return;
      }

      update(performance.now());
    };

    const handleSweepLightActiveChange = (isActive: boolean) => {
      syncOccluder();

      if (!isActive || reducedMotion) {
        stopLoop();
        resetGlow();
        return;
      }

      startLoop();
    };

    const unsubscribe = subscribeSweepLightActive(handleSweepLightActiveChange);

    handleSweepLightActiveChange(isSweepLightVisible());

    return () => {
      unsubscribe();
      stopLoop();
      // Unregister occluder
      const idx = sweepLight.occluders.indexOf(occ);
      if (idx !== -1) sweepLight.occluders.splice(idx, 1);
      el.style.setProperty('--sweep-glow', '0');
      el.style.setProperty('--sweep-angle', '0rad');
      el.style.setProperty('--sweep-sx', '0');
      el.style.setProperty('--sweep-sy', '0');
      el.style.setProperty('--sweep-proximity', '0');
    };
  }, [reducedMotion, renderProfile]);

  return elRef;
}


