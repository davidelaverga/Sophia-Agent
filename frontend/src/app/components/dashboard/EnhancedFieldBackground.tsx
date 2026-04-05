'use client';

import { useEffect, useRef, useState } from 'react';

import { useDeviceFidelity } from '../../hooks/useDeviceFidelity';
import type { ContextMode } from '../../types/session';

type ThemeKind = 'dark' | 'light';
type Rgb = [number, number, number];

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  depth: number;
  alpha: number;
  size: number;
  phase: number;
};

const CONTEXT_PALETTES: Record<ContextMode, [Rgb, Rgb, Rgb]> = {
  gaming: [
    [140, 90, 190],
    [192, 102, 148],
    [242, 184, 112],
  ],
  work: [
    [84, 132, 174],
    [116, 164, 200],
    [188, 213, 230],
  ],
  life: [
    [162, 104, 140],
    [208, 130, 156],
    [236, 182, 200],
  ],
};

const THEME_COLORS = {
  dark: {
    bg: [3, 3, 8] as Rgb,
    particle: [255, 250, 245] as Rgb,
    vigEdge: [3, 3, 8] as Rgb,
    vigStrength: 0.58,
    nebulaIntensity: 1,
    nebulaBoost: 1,
    iridescence: 0,
    caustics: 0,
    auroraStrength: 0,
    particleIridescence: 0,
  },
  light: {
    bg: [255, 255, 255] as Rgb,
    particle: [160, 130, 100] as Rgb,
    vigEdge: [255, 255, 255] as Rgb,
    vigStrength: 0,
    nebulaIntensity: 1,
    nebulaBoost: 1,
    iridescence: 0.05,
    caustics: 0.035,
    auroraStrength: 0.025,
    particleIridescence: 0.7,
  },
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function readThemeKind(): ThemeKind {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function makeParticles(count: number): Particle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00018,
    vy: (Math.random() - 0.5) * 0.00018,
    depth: Math.random(),
    alpha: 0.12 + Math.random() * 0.22,
    size: 1 + Math.random() * 2.4,
    phase: Math.random() * Math.PI * 2,
  }));
}

export function EnhancedFieldBackground({ contextMode }: { contextMode: ContextMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const [themeKind, setThemeKind] = useState<ThemeKind>('dark');
  const { reducedFidelity, reducedMotion, dprCap } = useDeviceFidelity();

  useEffect(() => {
    setThemeKind(readThemeKind());

    const observer = new MutationObserver(() => {
      setThemeKind(readThemeKind());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-sophia-theme'],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles = makeParticles(reducedFidelity ? 84 : 140);
    let raf = 0;
    let width = 0;
    let height = 0;

    const currentBg: Rgb = [...THEME_COLORS[themeKind].bg];
    const currentParticle: Rgb = [...THEME_COLORS[themeKind].particle];
    const currentVigEdge: Rgb = [...THEME_COLORS[themeKind].vigEdge];
    let currentVig = THEME_COLORS[themeKind].vigStrength;
    let currentIntensity = THEME_COLORS[themeKind].nebulaIntensity;
    let currentBoost = THEME_COLORS[themeKind].nebulaBoost;
    let currentIridescence = THEME_COLORS[themeKind].iridescence;
    let currentCaustics = THEME_COLORS[themeKind].caustics;
    let currentAurora = THEME_COLORS[themeKind].auroraStrength;
    let currentParticleIri = THEME_COLORS[themeKind].particleIridescence;
    const currentPalette: [Rgb, Rgb, Rgb] = CONTEXT_PALETTES[contextMode].map((color) => [...color]) as [Rgb, Rgb, Rgb];

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dprCap);
      canvas.height = Math.round(height * dprCap);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dprCap, 0, 0, dprCap, 0, 0);
    };

    const handleMouseMove = (event: MouseEvent) => {
      mouseRef.current.x = event.clientX / Math.max(window.innerWidth, 1);
      mouseRef.current.y = event.clientY / Math.max(window.innerHeight, 1);
    };

    const draw = (ts: number) => {
      const theme = THEME_COLORS[themeKind];
      const targetPalette = CONTEXT_PALETTES[contextMode];
      const lerpRate = reducedMotion ? 1 : 0.018;
      const time = ts * 0.001;

      for (let i = 0; i < 3; i += 1) {
        currentBg[i] = lerp(currentBg[i], theme.bg[i], lerpRate);
        currentParticle[i] = lerp(currentParticle[i], theme.particle[i], lerpRate);
        currentVigEdge[i] = lerp(currentVigEdge[i], theme.vigEdge[i], lerpRate);
        for (let j = 0; j < 3; j += 1) {
          currentPalette[i][j] = lerp(currentPalette[i][j], targetPalette[i][j], reducedMotion ? 1 : 0.012);
        }
      }

      currentVig = lerp(currentVig, theme.vigStrength, lerpRate);
      currentIntensity = lerp(currentIntensity, theme.nebulaIntensity, lerpRate);
      currentBoost = lerp(currentBoost, theme.nebulaBoost, lerpRate);
      currentIridescence = lerp(currentIridescence, theme.iridescence, lerpRate);
      currentCaustics = lerp(currentCaustics, theme.caustics, lerpRate);
      currentAurora = lerp(currentAurora, theme.auroraStrength, lerpRate);
      currentParticleIri = lerp(currentParticleIri, theme.particleIridescence, lerpRate);

      const cx = width * 0.5;
      const cy = height * 0.48;
      const breath = Math.sin(time * 0.65) * 0.08;
      const breathSlow = Math.sin(time * 0.28) * 0.04;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = `rgb(${currentBg[0] | 0}, ${currentBg[1] | 0}, ${currentBg[2] | 0})`;
      ctx.fillRect(0, 0, width, height);

      if (currentIridescence > 0.001) {
        const hueBase = time * 8;
        const warm = hslToRgb(hueBase + 22, 55, 66);
        const cool = hslToRgb(hueBase + 175, 50, 69);
        const accent = hslToRgb(hueBase + 95, 45, 73);
        const gradients = [
          { color: warm, x: cx + Math.sin(time * 0.055) * width * 0.28, y: cy + Math.cos(time * 0.042) * height * 0.22, r: Math.max(width, height) * 0.48, a: currentIridescence * 1.08 },
          { color: cool, x: cx + Math.sin(time * 0.038 + 2.5) * width * 0.3, y: cy + Math.cos(time * 0.048 + 1.8) * height * 0.2, r: Math.max(width, height) * 0.42, a: currentIridescence * 0.82 },
          { color: accent, x: cx + Math.cos(time * 0.09) * width * 0.15, y: cy + Math.sin(time * 0.072) * height * 0.12, r: Math.min(width, height) * 0.22, a: currentIridescence * 0.68 },
        ];

        gradients.forEach((gradient) => {
          const fill = ctx.createRadialGradient(gradient.x, gradient.y, 0, gradient.x, gradient.y, gradient.r);
          fill.addColorStop(0, `rgba(${gradient.color[0]}, ${gradient.color[1]}, ${gradient.color[2]}, ${gradient.a})`);
          fill.addColorStop(0.45, `rgba(${gradient.color[0]}, ${gradient.color[1]}, ${gradient.color[2]}, ${gradient.a * 0.22})`);
          fill.addColorStop(1, 'transparent');
          ctx.fillStyle = fill;
          ctx.fillRect(0, 0, width, height);
        });
      }

      if (currentAurora > 0.001) {
        for (let index = 0; index < 3; index += 1) {
          const bandHue = time * 6 + index * 120;
          const color = hslToRgb(bandHue, 40, 70);
          const bandY = height * (0.22 + index * 0.18) + Math.sin(time * (0.06 + index * 0.02) + index) * height * 0.08;
          const bandX = cx + Math.sin(time * 0.03 + index * 2) * width * 0.2;
          const bandW = width * 0.62;
          const gradient = ctx.createRadialGradient(bandX, bandY, 0, bandX, bandY, bandW);
          gradient.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${currentAurora * 0.58})`);
          gradient.addColorStop(0.3, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${currentAurora * 0.18})`);
          gradient.addColorStop(1, 'transparent');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        }
      }

      if (currentCaustics > 0.001) {
        for (let index = 0; index < 4; index += 1) {
          const spotX = width * (0.3 + index * 0.15) + Math.sin(time * (0.04 + index * 0.012) + index * 1.7) * width * 0.15;
          const spotY = height * (0.3 + index * 0.1) + Math.cos(time * (0.035 + index * 0.009) + index * 2.3) * height * 0.15;
          const spotR = Math.min(width, height) * (0.08 + Math.sin(time * 0.15 + index) * 0.02);
          const glow = ctx.createRadialGradient(spotX, spotY, 0, spotX, spotY, spotR);
          glow.addColorStop(0, `rgba(255, 252, 245, ${currentCaustics * 1.4})`);
          glow.addColorStop(0.3, `rgba(255, 248, 240, ${currentCaustics * 0.46})`);
          glow.addColorStop(1, 'transparent');
          ctx.fillStyle = glow;
          ctx.fillRect(spotX - spotR, spotY - spotR, spotR * 2, spotR * 2);
        }
      }

      const c1 = currentPalette[0];
      const c2 = currentPalette[1];
      const c3 = currentPalette[2];
      const boost = currentBoost;
      const intensity = currentIntensity;

      const core = ctx.createRadialGradient(
        cx + Math.sin(time * 0.18) * 28,
        cy + Math.cos(time * 0.14) * 18,
        0,
        cx,
        cy,
        Math.min(width, height) * (0.52 + breath)
      );
      const a1 = Math.min(0.22 * intensity * boost, 0.42);
      core.addColorStop(0, `rgba(${c1[0]}, ${c1[1]}, ${c1[2]}, ${a1})`);
      core.addColorStop(0.25, `rgba(${c1[0]}, ${c1[1]}, ${c1[2]}, ${a1 * 0.52})`);
      core.addColorStop(0.6, `rgba(${c1[0]}, ${c1[1]}, ${c1[2]}, ${a1 * 0.16})`);
      core.addColorStop(1, 'transparent');
      ctx.fillStyle = core;
      ctx.fillRect(0, 0, width, height);

      const secondary = ctx.createRadialGradient(
        cx + Math.sin(time * 0.11) * 55,
        cy + Math.cos(time * 0.09) * 40,
        0,
        cx,
        cy,
        Math.min(width, height) * (0.4 + breathSlow)
      );
      const a2 = Math.min(0.13 * intensity * boost, 0.32);
      secondary.addColorStop(0, `rgba(${c2[0]}, ${c2[1]}, ${c2[2]}, ${a2})`);
      secondary.addColorStop(0.45, `rgba(${c2[0]}, ${c2[1]}, ${c2[2]}, ${a2 * 0.28})`);
      secondary.addColorStop(1, 'transparent');
      ctx.fillStyle = secondary;
      ctx.fillRect(0, 0, width, height);

      const mx = mouseRef.current.x * width;
      const my = mouseRef.current.y * height;
      const pointerGlow = ctx.createRadialGradient(mx, my, 0, mx, my, Math.min(width, height) * 0.18);
      pointerGlow.addColorStop(0, `rgba(${c3[0]}, ${c3[1]}, ${c3[2]}, ${Math.min(0.05 * intensity * boost, 0.12)})`);
      pointerGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = pointerGlow;
      ctx.fillRect(0, 0, width, height);

      const wanderingX = cx + Math.sin(time * 0.085) * width * 0.22;
      const wanderingY = cy + Math.cos(time * 0.065) * height * 0.16;
      const wandering = ctx.createRadialGradient(
        wanderingX,
        wanderingY,
        0,
        wanderingX,
        wanderingY,
        Math.min(width, height) * (0.28 + Math.sin(time * 0.22) * 0.04)
      );
      wandering.addColorStop(0, `rgba(${c3[0]}, ${c3[1]}, ${c3[2]}, ${Math.min(0.07 * intensity * boost, 0.18)})`);
      wandering.addColorStop(1, 'transparent');
      ctx.fillStyle = wandering;
      ctx.fillRect(0, 0, width, height);

      const particleBase = currentParticle;
      particles.forEach((particle) => {
        const parallax = 0.5 + particle.depth * 0.5;
        particle.x += particle.vx + Math.sin(time + particle.phase) * 0.00007 * parallax;
        particle.y += particle.vy + Math.cos(time + particle.phase) * 0.00005 * parallax;
        if (particle.x < 0) particle.x = 1;
        if (particle.x > 1) particle.x = 0;
        if (particle.y < 0) particle.y = 1;
        if (particle.y > 1) particle.y = 0;

        const px = particle.x * width;
        const py = particle.y * height;
        const twinkle = Math.pow(Math.sin(time * (0.6 + particle.depth * 0.4) + particle.phase) * 0.5 + 0.5, 3);
        const alpha = particle.alpha * twinkle * intensity;
        if (alpha < 0.01) return;

        let pr = lerp(c3[0], particleBase[0], particle.depth * 0.3);
        let pg = lerp(c3[1], particleBase[1], particle.depth * 0.3);
        let pb = lerp(c3[2], particleBase[2], particle.depth * 0.3);

        if (currentParticleIri > 0.01) {
          const iridescent = hslToRgb(particle.x * 180 + particle.y * 90 + time * 12 + particle.phase * 57, 55, 55);
          pr = lerp(particleBase[0], iridescent[0], currentParticleIri);
          pg = lerp(particleBase[1], iridescent[1], currentParticleIri);
          pb = lerp(particleBase[2], iridescent[2], currentParticleIri);
        }

        const radius = (currentParticleIri > 0.01 ? particle.size * 1.4 : particle.size) * 3.5;
        const glow = ctx.createRadialGradient(px, py, 0, px, py, radius);
        glow.addColorStop(0, `rgba(${pr | 0}, ${pg | 0}, ${pb | 0}, ${alpha * 0.48})`);
        glow.addColorStop(1, `rgba(${pr | 0}, ${pg | 0}, ${pb | 0}, 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);

        ctx.beginPath();
        ctx.arc(px, py, radius * 0.11, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${pr | 0}, ${pg | 0}, ${pb | 0}, ${alpha * 0.68})`;
        ctx.fill();
      });

      if (currentVig > 0.001) {
        const vignette = ctx.createRadialGradient(
          cx,
          cy,
          Math.min(width, height) * 0.25,
          cx,
          cy,
          Math.max(width, height) * 0.75
        );
        vignette.addColorStop(0, 'transparent');
        vignette.addColorStop(0.6, `rgba(${currentVigEdge[0] | 0}, ${currentVigEdge[1] | 0}, ${currentVigEdge[2] | 0}, ${currentVig * 0.15})`);
        vignette.addColorStop(1, `rgba(${currentVigEdge[0] | 0}, ${currentVigEdge[1] | 0}, ${currentVigEdge[2] | 0}, ${currentVig})`);
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, width, height);
      }

      if (!reducedMotion) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMouseMove);

    if (reducedMotion) {
      draw(0);
    } else {
      raf = window.requestAnimationFrame(draw);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.cancelAnimationFrame(raf);
    };
  }, [contextMode, themeKind, reducedFidelity, reducedMotion, dprCap]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 h-full w-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}