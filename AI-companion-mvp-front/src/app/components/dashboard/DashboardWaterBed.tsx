/**
 * DashboardWaterBed Component
 * 
 * ENVIRONMENTAL LIGHTING LAYER - Not a UI decoration.
 * 
 * This creates a luminous atmospheric pool on the "floor" beneath the ritual cards.
 * The effect should feel like looking down at a glowing liquid surface far below,
 * with light refracting through mist and caustic patterns shifting gently.
 * 
 * Design principles:
 * - The pool is BELOW the card layer in z-depth (environment, not UI)
 * - Perspective transform creates "floor" feel
 * - Light emerges UPWARD from the surface
 * - No visible ring ripples - only light distortion
 * - Caustic-like animated light patterns
 * - Atmospheric haze rises from surface
 * 
 * Layer stack (bottom to top):
 * 1. Deep pool base (perspective plane)
 * 2. Central hotspot (light concentration)
 * 3. Horizontal specular streaks (liquid reflection)
 * 4. Animated caustic texture (light distortion)
 * 5. Rising atmospheric haze
 * 6. Soft grain overlay
 */

'use client';

import { useEffect, useState, memo } from 'react';
import { cn } from '../../lib/utils';

// ============================================================================
// CAUSTIC LIGHT PATTERN (animated light distortion, not rings)
// ============================================================================

interface CausticData {
  id: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  delay: number;
}

const CausticLight = memo(function CausticLight({
  x,
  y,
  scale,
  rotation,
  delay,
}: Omit<CausticData, 'id'>) {
  return (
    <div
      className="absolute pointer-events-none animate-caustic-drift"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: `${120 * scale}px`,
        height: `${60 * scale}px`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        animationDelay: `${delay}s`,
      }}
    >
      {/* Caustic light blob - soft, organic shape */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(
              ellipse 100% 100% at 50% 50%,
              color-mix(in srgb, var(--sophia-glow) 20%, transparent) 0%,
              color-mix(in srgb, var(--sophia-glow) 8%, transparent) 40%,
              transparent 70%
            )
          `,
          filter: 'blur(12px)',
          borderRadius: '50%',
        }}
      />
    </div>
  );
});

// Pre-generated caustic positions for consistency
const CAUSTICS: CausticData[] = [
  { id: 1, x: 35, y: 45, scale: 1.2, rotation: -15, delay: 0 },
  { id: 2, x: 65, y: 50, scale: 0.9, rotation: 20, delay: 2 },
  { id: 3, x: 50, y: 55, scale: 1.4, rotation: 5, delay: 4 },
  { id: 4, x: 25, y: 60, scale: 0.8, rotation: -30, delay: 1 },
  { id: 5, x: 75, y: 58, scale: 1.0, rotation: 35, delay: 3 },
];

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function DashboardWaterBed() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return (
    <>
      {/* ================================================================
          ENVIRONMENT LAYER - Positioned at BOTTOM of viewport
          This is the "floor" - a luminous pool far below the UI
          ================================================================ */}
      <div
        className="fixed pointer-events-none"
        style={{
          // Position at the BOTTOM of the viewport
          left: '50%',
          bottom: '0',
          transform: 'translateX(-50%)',
          width: '100vw',
          height: '45vh', // Takes up bottom portion of screen
          zIndex: 0, // Behind all UI elements
          // Perspective container - looking down at a floor
          perspective: '500px',
          perspectiveOrigin: '50% 0%',
        }}
        aria-hidden="true"
      >
        {/* ================================================================
            POOL PLANE - The 3D perspective surface (the "floor")
            ================================================================ */}
        <div
          className="absolute inset-0"
          style={{
            // Strong perspective rotation - this IS the floor
            transform: 'rotateX(75deg)',
            transformOrigin: '50% 0%',
            // Elliptical mask - natural fade, no hard edges
            maskImage: `
              radial-gradient(
                ellipse 60% 100% at 50% 0%,
                black 0%,
                black 20%,
                transparent 70%
              )
            `,
            WebkitMaskImage: `
              radial-gradient(
                ellipse 60% 100% at 50% 0%,
                black 0%,
                black 20%,
                transparent 70%
              )
            `,
          }}
        >
          {/* Layer 1: Deep pool base - the dark liquid beneath */}
          <div
            className="absolute inset-0"
            style={{
              background: `
                radial-gradient(
                  ellipse 100% 80% at 50% 20%,
                  color-mix(in srgb, var(--sophia-purple) 8%, var(--bg)) 0%,
                  var(--bg) 60%
                )
              `,
            }}
          />

          {/* Layer 2: Central hotspot - where light concentrates */}
          <div
            className="absolute inset-0"
            style={{
              background: `
                radial-gradient(
                  ellipse 50% 40% at 50% 25%,
                  color-mix(in srgb, var(--sophia-glow) 35%, transparent) 0%,
                  color-mix(in srgb, var(--sophia-purple) 15%, transparent) 40%,
                  transparent 70%
                )
              `,
              filter: 'blur(20px)',
            }}
          />

          {/* Layer 3: Horizontal specular streaks - liquid reflection */}
          <div
            className="absolute inset-0"
            style={{
              background: `
                repeating-linear-gradient(
                  to bottom,
                  transparent 0%,
                  color-mix(in srgb, var(--sophia-glow) 3%, transparent) 2%,
                  color-mix(in srgb, var(--sophia-glow) 8%, transparent) 4%,
                  color-mix(in srgb, var(--sophia-glow) 3%, transparent) 6%,
                  transparent 8%
                )
              `,
              filter: 'blur(4px)',
              opacity: 0.7,
              // Subtle animation for liquid movement
              animation: prefersReducedMotion ? 'none' : 'specular-shift 12s ease-in-out infinite',
            }}
          />

          {/* Layer 4: Brighter center specular band */}
          <div
            className="absolute inset-0"
            style={{
              background: `
                linear-gradient(
                  to bottom,
                  transparent 10%,
                  color-mix(in srgb, var(--sophia-glow) 20%, transparent) 20%,
                  color-mix(in srgb, var(--sophia-glow) 40%, transparent) 28%,
                  color-mix(in srgb, var(--sophia-glow) 20%, transparent) 36%,
                  transparent 50%
                )
              `,
              filter: 'blur(15px)',
              mixBlendMode: 'soft-light',
            }}
          />

          {/* Layer 5: Animated caustic light patterns */}
          {!prefersReducedMotion && (
            <div className="absolute inset-0 overflow-hidden opacity-60">
              {CAUSTICS.map((caustic) => (
                <CausticLight
                  key={caustic.id}
                  x={caustic.x}
                  y={caustic.y}
                  scale={caustic.scale}
                  rotation={caustic.rotation}
                  delay={caustic.delay}
                />
              ))}
            </div>
          )}

          {/* Layer 6: Subtle grain texture */}
          <div
            className="absolute inset-0 mix-blend-overlay"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'repeat',
              backgroundSize: '100px 100px',
              opacity: 0.04,
            }}
          />
        </div>

        {/* ================================================================
            RISING ATMOSPHERIC HAZE - Light emerging upward from pool
            This is OUTSIDE the perspective plane, in screen space
            ================================================================ */}
        <div
          className={cn(
            'absolute',
            !prefersReducedMotion && 'animate-haze-rise'
          )}
          style={{
            left: '50%',
            top: '0',
            width: '50%',
            height: '60%',
            transform: 'translateX(-50%)',
            background: `
              radial-gradient(
                ellipse 100% 100% at 50% 100%,
                color-mix(in srgb, var(--sophia-glow) 15%, transparent) 0%,
                color-mix(in srgb, var(--sophia-purple) 8%, transparent) 30%,
                transparent 60%
              )
            `,
            filter: 'blur(50px)',
            mixBlendMode: 'soft-light',
            opacity: 0.9,
          }}
        />

        {/* Secondary haze layer - wider, softer */}
        <div
          className={cn(
            'absolute',
            !prefersReducedMotion && 'animate-haze-rise-slow'
          )}
          style={{
            left: '50%',
            top: '10%',
            width: '70%',
            height: '50%',
            transform: 'translateX(-50%)',
            background: `
              radial-gradient(
                ellipse 100% 80% at 50% 100%,
                color-mix(in srgb, var(--sophia-purple) 10%, transparent) 0%,
                transparent 50%
              )
            `,
            filter: 'blur(80px)',
            mixBlendMode: 'screen',
            opacity: 0.5,
          }}
        />
      </div>

      {/* Keyframe animations */}
      <style jsx>{`
        /* Caustic light drift - organic movement */
        @keyframes caustic-drift {
          0%, 100% {
            opacity: 0.4;
            transform: translate(-50%, -50%) rotate(var(--rotation, 0deg)) scale(1);
          }
          25% {
            opacity: 0.7;
            transform: translate(-48%, -52%) rotate(calc(var(--rotation, 0deg) + 5deg)) scale(1.1);
          }
          50% {
            opacity: 0.5;
            transform: translate(-52%, -48%) rotate(calc(var(--rotation, 0deg) - 3deg)) scale(0.95);
          }
          75% {
            opacity: 0.6;
            transform: translate(-50%, -53%) rotate(calc(var(--rotation, 0deg) + 2deg)) scale(1.05);
          }
        }

        /* Specular streaks shift - liquid surface movement */
        @keyframes specular-shift {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(3px);
          }
        }

        /* Haze rising from surface */
        @keyframes haze-rise {
          0%, 100% {
            opacity: 0.8;
            transform: translateX(-50%) translateY(0);
          }
          50% {
            opacity: 0.6;
            transform: translateX(-50%) translateY(-8px);
          }
        }

        @keyframes haze-rise-slow {
          0%, 100% {
            opacity: 0.4;
            transform: translateX(-50%) translateY(0);
          }
          50% {
            opacity: 0.3;
            transform: translateX(-50%) translateY(-12px);
          }
        }

        :global(.animate-caustic-drift) {
          animation: caustic-drift 8s ease-in-out infinite;
        }

        :global(.animate-haze-rise) {
          animation: haze-rise 6s ease-in-out infinite;
        }

        :global(.animate-haze-rise-slow) {
          animation: haze-rise-slow 10s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}

export default DashboardWaterBed;
