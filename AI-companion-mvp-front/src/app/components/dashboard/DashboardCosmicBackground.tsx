/**
 * DashboardCosmicBackground Component
 * 
 * Context-aware atmospheric background with 3 distinct worlds:
 * 
 * 🎮 GAMING — "Battle Station"
 *   Deep nebula, starfield particles, cinematic vignette, high energy
 * 
 * 💼 WORK — "Focus Desk"
 *   Clean lavanda gradient (light) / slate-purple (dark), minimal particles,
 *   frosted glass aesthetic, professional calm
 * 
 * 🌿 LIFE — "Safe Space"
 *   Warm rose-purple gradient, prominent bokeh particles (dreamy defocused
 *   circles), organic and ethereal
 * 
 * All 3 layers are always mounted; only the active one has opacity > 0.
 * Transitions use opacity crossfade for smooth real-time switching.
 * 
 * Layer stack per world:
 * 1. Base gradient(s)
 * 2. Particles (starfield / bokeh / geometric)
 * 3. Bloom sources
 * 4. Vignette
 * 5. Grain overlay (shared)
 */

'use client';

import { useMemo, memo } from 'react';
import type { ContextMode } from '../../types/session';

// =============================================================================
// NOISE SVG — fractal noise for grain overlay
// =============================================================================
const NOISE_SVG = `data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E`;

// =============================================================================
// SEEDED RANDOM UTILITY
// =============================================================================
function seededRandom(seed: number, i: number): number {
  const x = Math.sin(seed + i * 9999) * 10000;
  return x - Math.floor(x);
}

// =============================================================================
// 🎮 GAMING: STARFIELD
// =============================================================================
const GamingStarfield = memo(function GamingStarfield() {
  const stars = useMemo(() =>
    Array.from({ length: 65 }, (_, i) => ({
      left: `${2 + seededRandom(37, i * 3) * 96}%`,
      top: `${2 + seededRandom(37, i * 3 + 1) * 96}%`,
      size: 0.5 + seededRandom(37, i * 3 + 2) * 1.5,
      opacity: 0.06 + seededRandom(37, i * 5) * 0.22,
      delay: i * 80,
      duration: 3 + seededRandom(37, i * 7) * 5,
    })), []);

  return (
    <div className="absolute inset-0">
      {stars.map((star, i) => (
        <div
          key={i}
          className="absolute rounded-full animate-cosmicTwinkle"
          style={{
            left: star.left,
            top: star.top,
            width: `${star.size}px`,
            height: `${star.size}px`,
            backgroundColor: 'var(--text)',
            opacity: star.opacity,
            animationDelay: `${star.delay}ms`,
            animationDuration: `${star.duration}s`,
          }}
        />
      ))}
    </div>
  );
});

// =============================================================================
// 🌿 LIFE: BOKEH PARTICLES
// =============================================================================
const LifeBokeh = memo(function LifeBokeh() {
  const bokehDots = useMemo(() =>
    Array.from({ length: 24 }, (_, i) => {
      const r = seededRandom(53, i);
      const size = 20 + r * 90; // 20–110px
      const isLarge = size > 60;
      return {
        left: `${2 + seededRandom(53, i * 3) * 96}%`,
        top: `${2 + seededRandom(53, i * 3 + 1) * 96}%`,
        size,
        opacity: isLarge ? 0.35 + seededRandom(53, i * 5) * 0.45 : 0.20 + seededRandom(53, i * 5) * 0.35,
        blur: isLarge ? 2 + r * 8 : 1 + r * 4, // much less blur so circles read
        delay: i * 280,
        duration: 6 + seededRandom(53, i * 7) * 8,
      };
    }), []);

  return (
    <div className="absolute inset-0">
      {bokehDots.map((dot, i) => (
        <div
          key={i}
          className="absolute rounded-full animate-bokehFloat"
          style={{
            left: dot.left,
            top: dot.top,
            width: `${dot.size}px`,
            height: `${dot.size}px`,
            background: `radial-gradient(circle, var(--life-bokeh-inner) 0%, var(--life-bokeh-outer) 60%, transparent 100%)`,
            opacity: dot.opacity,
            filter: `blur(${dot.blur}px)`,
            animationDelay: `${dot.delay}ms`,
            animationDuration: `${dot.duration}s`,
          }}
        />
      ))}
    </div>
  );
});

// =============================================================================
// 💼 WORK: GEOMETRIC LIGHT SHAPES (subtle frosted glass accents)
// =============================================================================
const WorkGeometry = memo(function WorkGeometry() {
  const shapes = useMemo(() =>
    Array.from({ length: 6 }, (_, i) => ({
      left: `${10 + seededRandom(71, i * 3) * 80}%`,
      top: `${10 + seededRandom(71, i * 3 + 1) * 80}%`,
      size: 80 + seededRandom(71, i * 3 + 2) * 120,
      rotation: seededRandom(71, i * 5) * 45,
      opacity: 0.02 + seededRandom(71, i * 7) * 0.04,
      delay: i * 600,
      duration: 12 + seededRandom(71, i * 9) * 10,
    })), []);

  return (
    <div className="absolute inset-0">
      {shapes.map((s, i) => (
        <div
          key={i}
          className="absolute rounded-3xl animate-workFloat"
          style={{
            left: s.left,
            top: s.top,
            width: `${s.size}px`,
            height: `${s.size * 0.6}px`,
            background: 'var(--work-shape-bg)',
            opacity: s.opacity,
            transform: `rotate(${s.rotation}deg)`,
            filter: 'blur(40px)',
            animationDelay: `${s.delay}ms`,
            animationDuration: `${s.duration}s`,
          }}
        />
      ))}
    </div>
  );
});

// =============================================================================
// 💼 WORK: SCREEN GLOW — soft upward light from bottom (monitor/screen)
// =============================================================================
const WorkScreenGlow = memo(function WorkScreenGlow() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Primary glow — wide upward wash from bottom center */}
      <div
        className="absolute animate-workScreenGlow"
        style={{
          bottom: '-15%',
          left: '10%',
          right: '10%',
          height: '65%',
          background: `radial-gradient(ellipse 90% 60% at 50% 100%, var(--work-screen-bright) 0%, var(--work-screen-mid) 35%, transparent 70%)`,
          filter: 'blur(25px)',
        }}
      />
      {/* Secondary glow — narrower hotspot */}
      <div
        className="absolute animate-workScreenGlow"
        style={{
          bottom: '-10%',
          left: '25%',
          right: '25%',
          height: '50%',
          background: `radial-gradient(ellipse 70% 50% at 50% 100%, var(--work-screen-bright) 0%, transparent 55%)`,
          filter: 'blur(15px)',
          animationDuration: '10s',
          animationDelay: '-3s',
        }}
      />
      {/* Edge spill — very subtle side reflections */}
      <div
        className="absolute bottom-0 left-0 w-[40%] h-[30%]"
        style={{
          background: `radial-gradient(ellipse 80% 60% at 0% 100%, var(--work-screen-mid) 0%, transparent 70%)`,
          filter: 'blur(30px)',
          opacity: 0.5,
        }}
      />
      <div
        className="absolute bottom-0 right-0 w-[40%] h-[30%]"
        style={{
          background: `radial-gradient(ellipse 80% 60% at 100% 100%, var(--work-screen-mid) 0%, transparent 70%)`,
          filter: 'blur(30px)',
          opacity: 0.5,
        }}
      />
    </div>
  );
});

// =============================================================================
// 🎮 GAMING ATMOSPHERE LAYER
// =============================================================================
const GamingAtmosphere = memo(function GamingAtmosphere() {
  return (
    <>
      {/* Nebula gradients */}
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(ellipse 90% 60% at 50% 5%, var(--gaming-nebula-1) 0%, var(--gaming-nebula-1) 12%, var(--gaming-nebula-2) 30%, var(--gaming-nebula-2) 45%, var(--gaming-nebula-3) 58%, transparent 75%),
          radial-gradient(ellipse 70% 50% at 30% 70%, var(--gaming-nebula-2) 0%, var(--gaming-nebula-2) 18%, var(--gaming-nebula-3) 38%, transparent 62%),
          radial-gradient(ellipse 60% 45% at 75% 80%, var(--gaming-nebula-3) 0%, var(--gaming-nebula-3) 15%, transparent 55%)
        `,
      }} />
      {/* Center mass */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 50% 40% at 50% 50%, var(--gaming-nebula-1) 0%, var(--gaming-nebula-1) 15%, var(--gaming-nebula-2) 35%, transparent 68%)`,
        opacity: 0.5,
      }} />
      {/* Starfield */}
      <GamingStarfield />
      {/* Bloom */}
      <div className="absolute top-[35%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full animate-bloomBreathe" style={{
        background: `radial-gradient(circle, var(--gaming-bloom-1) 0%, var(--gaming-bloom-1) 15%, var(--gaming-bloom-2) 40%, transparent 72%)`,
        filter: 'blur(80px)',
      }} />
      <div className="absolute -top-[10%] left-[20%] w-[500px] h-[400px] rounded-full animate-bloomDrift" style={{
        background: `radial-gradient(ellipse 80% 60%, var(--gaming-bloom-2) 0%, var(--gaming-bloom-2) 20%, transparent 68%)`,
        filter: 'blur(100px)',
      }} />
      <div className="absolute bottom-[5%] right-[10%] w-[400px] h-[350px] rounded-full animate-bloomDriftReverse" style={{
        background: `radial-gradient(ellipse 70% 60%, var(--gaming-nebula-3) 0%, var(--gaming-nebula-3) 18%, transparent 62%)`,
        filter: 'blur(90px)',
        opacity: 0.8,
      }} />
      {/* Vignette */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 70% 65% at 50% 45%, transparent 30%, rgba(0,0,0,0.25) 70%, rgba(0,0,0,0.55) 100%)`,
      }} />
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(ellipse 100% 70% at 0% 0%, rgba(0,0,0,0.3) 0%, transparent 50%),
          radial-gradient(ellipse 100% 70% at 100% 0%, rgba(0,0,0,0.25) 0%, transparent 50%),
          radial-gradient(ellipse 100% 70% at 0% 100%, rgba(0,0,0,0.3) 0%, transparent 50%),
          radial-gradient(ellipse 100% 70% at 100% 100%, rgba(0,0,0,0.3) 0%, transparent 50%)
        `,
        opacity: 0.5,
      }} />
    </>
  );
});

// =============================================================================
// 💼 WORK ATMOSPHERE LAYER
// =============================================================================
const WorkAtmosphere = memo(function WorkAtmosphere() {
  return (
    <>
      {/* Clean gradient — professional, soft */}
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(ellipse 100% 80% at 50% 0%, var(--work-gradient-top) 0%, transparent 70%),
          radial-gradient(ellipse 80% 60% at 50% 100%, var(--work-gradient-bottom) 0%, transparent 60%),
          radial-gradient(ellipse 60% 50% at 50% 50%, var(--work-gradient-mid) 0%, transparent 65%)
        `,
      }} />
      {/* Screen glow — upward light from bottom */}
      <WorkScreenGlow />
      {/* Geometric shapes */}
      <WorkGeometry />
      {/* Single soft bloom — centered, calm */}
      <div className="absolute top-[40%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full animate-bloomBreathe" style={{
        background: `radial-gradient(circle, var(--work-bloom) 0%, transparent 70%)`,
        filter: 'blur(100px)',
      }} />
      {/* Soft vignette — lighter than gaming */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 75% 70% at 50% 45%, transparent 40%, var(--work-vignette) 85%, var(--work-vignette-edge) 100%)`,
      }} />
    </>
  );
});

// =============================================================================
// 🌿 LIFE ATMOSPHERE LAYER
// =============================================================================
const LifeAtmosphere = memo(function LifeAtmosphere() {
  return (
    <>
      {/* Base wash — full-screen lavender-lilac tint */}
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(ellipse 120% 100% at 50% 30%, var(--life-gradient-mid) 0%, transparent 75%),
          radial-gradient(ellipse 120% 80% at 40% 10%, var(--life-gradient-top) 0%, transparent 65%),
          radial-gradient(ellipse 100% 80% at 65% 90%, var(--life-gradient-bottom) 0%, transparent 60%),
          radial-gradient(ellipse 80% 60% at 20% 65%, var(--life-gradient-accent) 0%, transparent 55%)
        `,
      }} />
      {/* Bokeh particles — container opacity capped by theme var */}
      <div className="absolute inset-0" style={{ opacity: 'var(--life-bokeh-layer-opacity, 1)' as unknown as number }}>
        <LifeBokeh />
      </div>
      {/* Warm bloom sources — container opacity capped by theme var */}
      <div className="absolute inset-0" style={{ opacity: 'var(--life-bloom-layer-opacity, 1)' as unknown as number }}>
      <div className="absolute top-[15%] left-[30%] w-[500px] h-[500px] rounded-full animate-bloomBreathe" style={{
        background: `radial-gradient(circle, var(--life-bloom-1) 0%, transparent 55%)`,
        filter: 'blur(40px)',
      }} />
      <div className="absolute bottom-[10%] right-[5%] w-[450px] h-[350px] rounded-full animate-bloomDrift" style={{
        background: `radial-gradient(ellipse 80% 60%, var(--life-bloom-2) 0%, transparent 50%)`,
        filter: 'blur(35px)',
      }} />
      <div className="absolute top-[5%] right-[20%] w-[400px] h-[300px] rounded-full animate-bloomDriftReverse" style={{
        background: `radial-gradient(ellipse 70% 60%, var(--life-bloom-1) 0%, transparent 50%)`,
        filter: 'blur(45px)',
        opacity: 0.7,
      }} />
      </div>
      {/* Soft vignette — warm tint */}
      <div className="absolute inset-0" style={{
        background: `radial-gradient(ellipse 75% 70% at 50% 45%, transparent 35%, var(--life-vignette) 80%, var(--life-vignette-edge) 100%)`,
      }} />
    </>
  );
});

// =============================================================================
// MAIN COMPONENT
// =============================================================================
interface DashboardCosmicBackgroundProps {
  contextMode?: ContextMode;
}

export const DashboardCosmicBackground = memo(function DashboardCosmicBackground({
  contextMode = 'gaming',
}: DashboardCosmicBackgroundProps) {
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      aria-hidden="true"
    >
      {/* ================================================================
          3 ATMOSPHERE LAYERS — always mounted, crossfade via opacity
          ================================================================ */}

      {/* 🎮 Gaming */}
      <div className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${contextMode === 'gaming' ? 'opacity-100' : 'opacity-0'}`}>
        <GamingAtmosphere />
      </div>

      {/* 💼 Work */}
      <div className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${contextMode === 'work' ? 'opacity-100' : 'opacity-0'}`}>
        <WorkAtmosphere />
      </div>

      {/* 🌿 Life */}
      <div className={`absolute inset-0 transition-opacity duration-700 ease-in-out ${contextMode === 'life' ? 'opacity-100' : 'opacity-0'}`}>
        <LifeAtmosphere />
      </div>

      {/* ================================================================
          SHARED: GRAIN / NOISE OVERLAY (all contexts)
          ================================================================ */}
      <div className="absolute inset-0 mix-blend-soft-light" style={{
        backgroundImage: `url("${NOISE_SVG}")`,
        backgroundRepeat: 'repeat',
        backgroundSize: '150px 150px',
        opacity: 0.06,
      }} />
      <div className="absolute inset-0 mix-blend-overlay" style={{
        backgroundImage: `url("${NOISE_SVG}")`,
        backgroundRepeat: 'repeat',
        backgroundSize: '256px 256px',
        opacity: 0.035,
      }} />
    </div>
  );
});

export default DashboardCosmicBackground;
