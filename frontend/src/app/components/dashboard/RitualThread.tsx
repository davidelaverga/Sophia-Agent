/**
 * RitualThread — canvas overlay that draws an animated thread
 * from the selected ritual node to the center mic, with a
 * traveling spark particle. Matches the prototype's <canvas id="threads">.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useDeviceFidelity } from '../../hooks/useDeviceFidelity';

interface RitualThreadProps {
  /** data-ritual attribute value of the selected node, or null */
  selectedRitual: string | null;
  /** Whether system is in an active call/session */
  isActive: boolean;
}

type ThemeKind = 'dark' | 'light';

function readThemeKind(): ThemeKind {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

// Context-aware glow colors — matches CONTEXT_PALETTES in EnhancedFieldBackground
const PALETTE = {
  c1: [140, 90, 190],
  c2: [192, 102, 148],
  c3: [242, 184, 112],
};

export function RitualThread({ selectedRitual, isActive }: RitualThreadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { reducedMotion, dprCap } = useDeviceFidelity();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dprCap);
      canvas.height = Math.round(height * dprCap);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dprCap, 0, 0, dprCap, 0, 0);
    };

    const draw = (ts: number) => {
      ctx.clearRect(0, 0, width, height);
      const time = ts * 0.001;

      // Only draw when a ritual is selected and NOT in active session
      if (selectedRitual && !isActive) {
        const ritualDot = document.querySelector(
          `[data-ritual="${selectedRitual}"] span:first-child`
        ) as HTMLElement | null;

        // Target the actual mic element, not viewport center
        const micEl = document.querySelector('[data-onboarding="mic-cta"]') as HTMLElement | null;

        if (ritualDot && micEl) {
          const rect = ritualDot.getBoundingClientRect();
          const rx = rect.left + rect.width / 2;
          const ry = rect.top + rect.height / 2;

          const micRect = micEl.getBoundingClientRect();
          const cx = micRect.left + micRect.width / 2;
          const cy = micRect.top + micRect.height / 2;

          const theme = readThemeKind();
          const intensity = theme === 'dark' ? 1.0 : 0.85;

          // Gradient along the thread
          const grad = ctx.createLinearGradient(rx, ry, cx, cy);
          grad.addColorStop(0, `rgba(${PALETTE.c1[0]}, ${PALETTE.c1[1]}, ${PALETTE.c1[2]}, ${0.12 * intensity})`);
          grad.addColorStop(0.5, `rgba(${PALETTE.c2[0]}, ${PALETTE.c2[1]}, ${PALETTE.c2[2]}, ${0.06 * intensity})`);
          grad.addColorStop(1, `rgba(${PALETTE.c3[0]}, ${PALETTE.c3[1]}, ${PALETTE.c3[2]}, ${0.02 * intensity})`);

          // Wandering control point for organic curve
          const cpx = (rx + cx) / 2 + Math.sin(time * 1.5) * 20;
          const cpy = (ry + cy) / 2 + Math.cos(time * 1.2) * 15;

          // Draw the thread
          ctx.beginPath();
          ctx.moveTo(rx, ry);
          ctx.quadraticCurveTo(cpx, cpy, cx, cy);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1;
          ctx.shadowColor = `rgba(${PALETTE.c1[0]}, ${PALETTE.c1[1]}, ${PALETTE.c1[2]}, 0.15)`;
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Traveling spark — moves from ritual to mic
          const st = (time * 0.4) % 1;
          const sx = (1 - st) * (1 - st) * rx + 2 * (1 - st) * st * cpx + st * st * cx;
          const sy = (1 - st) * (1 - st) * ry + 2 * (1 - st) * st * cpy + st * st * cy;

          const sparkColor = theme === 'dark' ? [255, 250, 245] : [160, 130, 100];
          const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 6);
          sg.addColorStop(0, `rgba(${sparkColor[0]}, ${sparkColor[1]}, ${sparkColor[2]}, 0.4)`);
          sg.addColorStop(1, 'transparent');
          ctx.fillStyle = sg;
          ctx.fillRect(sx - 6, sy - 6, 12, 12);
        }
      }

      if (!reducedMotion) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    if (reducedMotion) {
      draw(0);
    } else {
      raf = window.requestAnimationFrame(draw);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      window.cancelAnimationFrame(raf);
    };
  }, [selectedRitual, isActive, reducedMotion, dprCap]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ zIndex: 1 }}
    />
  );
}
