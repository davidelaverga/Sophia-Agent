/**
 * sweepLight — Shared mutable state for an off-screen light source.
 *
 * CelestialComet writes position each frame (typically off-screen coords),
 * UI components read it via useSweepGlow() which computes directional
 * illumination and shadow angle without triggering React re-renders.
 */

import { useEffect, useRef } from 'react';

/* ─── Global light state (no React, no re-renders) ─────────── */

export const sweepLight = {
  x: -9999,
  y: -9999,
  active: false,
  intensity: 0,
  /** Registered UI element occluders — shader blocks rays through these */
  occluders: [] as Array<{ cx: number; cy: number; r: number }>,
};

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

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let raf = 0;
    let lastGlow = -1;

    // Register as a light occluder so the shader blocks rays through this element
    const occ = { cx: 0, cy: 0, r: 0 };
    sweepLight.occluders.push(occ);

    const update = () => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      // Keep occluder position current every frame
      occ.cx = cx;
      occ.cy = cy;
      occ.r = Math.max(rect.width, rect.height) / 2;

      if (!sweepLight.active || sweepLight.intensity < 0.01) {
        if (lastGlow !== 0) {
          el.style.setProperty('--sweep-glow', '0');
          el.style.setProperty('--sweep-angle', '0rad');
          el.style.setProperty('--sweep-sx', '0');
          el.style.setProperty('--sweep-sy', '0');
          el.style.setProperty('--sweep-proximity', '0');
          lastGlow = 0;
        }
        raf = requestAnimationFrame(update);
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

    raf = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(raf);
      // Unregister occluder
      const idx = sweepLight.occluders.indexOf(occ);
      if (idx !== -1) sweepLight.occluders.splice(idx, 1);
      el.style.setProperty('--sweep-glow', '0');
      el.style.setProperty('--sweep-angle', '0rad');
      el.style.setProperty('--sweep-sx', '0');
      el.style.setProperty('--sweep-sy', '0');
      el.style.setProperty('--sweep-proximity', '0');
    };
  }, []);

  return elRef;
}
