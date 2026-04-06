/**
 * Recap Prototype C — "Galaxy Ring"
 * /recap/prototypes/c
 *
 * Memories orbit around a central radiant core (the takeaway).
 * - Central glowing "star" shows the session takeaway
 * - Memory nodes orbit on a visible ring
 * - Tap a node to zoom it into a detail panel
 * - Approved memories pulse brighter and move to an inner ring
 * - Discarded memories drift outward and dissolve
 * - Reflection emerges from the core after all memories are reviewed
 * - Particle trails follow orbital motion
 *
 * Hard mock data — no backend required.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Home, Pencil, X } from 'lucide-react';
import { cn } from '../../../lib/utils';

// ─── Mock Data ───────────────────────────────────────────────────────────────

const MOCK_TAKEAWAY = 'Work-mode alertness is leaking into rest';

const MOCK_CANDIDATES = [
  {
    id: 'mem_01',
    text: 'Feels good when your brain is OFF and present. Struggles to sustain this state.',
    category: 'emotional_patterns',
    confidence: 0.89,
    reason: 'You described this feeling multiple times during the session.',
  },
  {
    id: 'mem_02',
    text: 'Pattern: always trying to be alert and take charge of situations.',
    category: 'identity_profile',
    confidence: 0.82,
    reason: 'This pattern surfaced across two separate topics.',
  },
  {
    id: 'mem_03',
    text: 'Work-brain optimization mode bleeds into rest, sees this as a pattern to address.',
    category: 'goals_projects',
    confidence: 0.76,
    reason: 'You explicitly named this as something to change.',
  },
  {
    id: 'mem_04',
    text: 'Has trouble setting boundaries with the team after hours — wants to change this.',
    category: 'preferences_boundaries',
    confidence: 0.71,
    reason: 'Mentioned when discussing evening routines.',
  },
];

const MOCK_REFLECTION = {
  prompt: 'Where did you learn that you had to always be alert and in charge?',
  tag: 'identity',
};

const CATEGORY_MAP: Record<string, { label: string; icon: string; hue: number }> = {
  emotional_patterns: { label: 'Emotional Patterns', icon: '💜', hue: 270 },
  identity_profile: { label: 'Identity', icon: '🪪', hue: 240 },
  goals_projects: { label: 'Goals & Projects', icon: '🎯', hue: 290 },
  preferences_boundaries: { label: 'Preferences', icon: '⚙️', hue: 220 },
};

type Decision = 'idle' | 'approved' | 'edited' | 'discarded';

function getCat(cat?: string) {
  return CATEGORY_MAP[cat ?? ''] ?? { label: 'Memory', icon: '•', hue: 270 };
}

// ─── Cosmic Background ──────────────────────────────────────────────────────

function CosmicBackground() {
  const [stars, setStars] = useState<
    { left: string; top: string; size: number; opacity: number; delay: number; duration: number }[]
  >([]);

  useEffect(() => {
    const seed = 31;
    const sr = (i: number) => {
      const x = Math.sin(seed + i * 9999) * 10000;
      return x - Math.floor(x);
    };
    setStars(
      [...Array(60)].map((_, i) => ({
        left: `${2 + sr(i * 3) * 96}%`,
        top: `${2 + sr(i * 3 + 1) * 96}%`,
        size: 0.3 + sr(i * 3 + 2) * 1.3,
        opacity: 0.05 + sr(i * 5) * 0.18,
        delay: i * 100,
        duration: 3 + sr(i * 7) * 5,
      })),
    );
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0" aria-hidden="true">
      <div className="absolute inset-0 bg-[#030308]" />
      {stars.map((s, i) => (
        <div
          key={i}
          className="absolute rounded-full motion-safe:animate-pulseSoft"
          style={{
            left: s.left,
            top: s.top,
            width: s.size,
            height: s.size,
            background: '#e8e4ef',
            opacity: s.opacity,
            animationDelay: `${s.delay}ms`,
            animationDuration: `${s.duration}s`,
          }}
        />
      ))}
      {/* Central radial bloom */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[55%] w-[1200px] h-[1200px] rounded-full motion-safe:animate-breatheSlow"
        style={{
          background: 'radial-gradient(circle, rgba(184,164,232,0.06) 0%, transparent 50%)',
          filter: 'blur(120px)',
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[55%] w-[600px] h-[600px] rounded-full motion-safe:animate-breathe"
        style={{
          background: 'radial-gradient(circle, rgba(184,164,232,0.12) 0%, transparent 50%)',
          filter: 'blur(60px)',
        }}
      />
      {/* Vignette */}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 65% 60% at 50% 45%, transparent 30%, #030308 80%)' }}
      />
      {/* Grain */}
      <div
        className="absolute inset-0 mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'repeat',
          backgroundSize: '180px',
          opacity: 0.024,
        }}
      />
    </div>
  );
}

// ─── Orbital Ring SVG ───────────────────────────────────────────────────────

function OrbitalRing({
  radius,
  opacity,
  dashed,
  className,
}: {
  radius: number;
  opacity: number;
  dashed?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={cn('absolute top-1/2 left-1/2 pointer-events-none', className)}
      style={{
        width: radius * 2,
        height: radius * 2,
        marginLeft: -radius,
        marginTop: -radius,
      }}
      viewBox={`0 0 ${radius * 2} ${radius * 2}`}
    >
      <circle
        cx={radius}
        cy={radius}
        r={radius - 1}
        fill="none"
        stroke={`rgba(184, 164, 232, ${opacity})`}
        strokeWidth="0.5"
        strokeDasharray={dashed ? '4 8' : 'none'}
      />
    </svg>
  );
}

// ─── Orbital Node ───────────────────────────────────────────────────────────

interface OrbitalNodeProps {
  candidate: (typeof MOCK_CANDIDATES)[0];
  angle: number;
  radius: number;
  isSelected: boolean;
  decision: Decision;
  onClick: () => void;
}

function OrbitalNode({ candidate, angle, radius, isSelected, decision, onClick }: OrbitalNodeProps) {
  const cat = getCat(candidate.category);
  const isProcessed = decision !== 'idle';
  const isKept = decision === 'approved' || decision === 'edited';
  const isDiscarded = decision === 'discarded';

  // Position on circle
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad) * radius;
  const y = Math.sin(rad) * radius;

  // Adjust radius for processed nodes
  const adjustedRadius = isKept ? radius * 0.55 : isDiscarded ? radius * 1.3 : radius;
  const ax = Math.cos(rad) * adjustedRadius;
  const ay = Math.sin(rad) * adjustedRadius;

  const nodeSize = isSelected ? 64 : 44;

  return (
    <button
      className={cn(
        'absolute transition-all ease-out group',
        isProcessed ? 'duration-1000' : 'duration-500',
        isDiscarded && 'opacity-0 scale-75 blur-sm',
      )}
      style={{
        left: `calc(50% + ${isProcessed ? ax : x}px - ${nodeSize / 2}px)`,
        top: `calc(50% + ${isProcessed ? ay : y}px - ${nodeSize / 2}px)`,
        width: nodeSize,
        height: nodeSize,
      }}
      onClick={onClick}
      aria-label={`Memory: ${candidate.text.slice(0, 40)}...`}
    >
      {/* Glow */}
      <div
        className={cn(
          'absolute inset-0 rounded-full transition-all duration-500',
          isSelected ? 'scale-[2.5]' : isKept ? 'scale-[1.8]' : 'scale-[1.4]',
        )}
        style={{
          background: `radial-gradient(circle, hsla(${cat.hue}, 55%, 65%, ${isSelected ? 0.25 : isKept ? 0.15 : 0.06}) 0%, transparent 60%)`,
          filter: 'blur(15px)',
        }}
      />

      {/* Node body */}
      <div
        className={cn(
          'absolute inset-0 rounded-full transition-all duration-500 flex items-center justify-center',
          isSelected && 'ring-1 ring-white/[0.15]',
          isKept && 'motion-safe:animate-glowPulse',
        )}
        style={{
          background: isSelected
            ? `radial-gradient(circle, hsla(${cat.hue}, 40%, 30%, 0.6) 0%, rgba(3,3,8,0.9) 100%)`
            : `radial-gradient(circle, rgba(20,20,30,0.8) 0%, rgba(3,3,8,0.95) 100%)`,
          boxShadow: isSelected
            ? `inset 0 0 15px hsla(${cat.hue}, 55%, 65%, 0.15), 0 0 20px hsla(${cat.hue}, 55%, 65%, 0.1)`
            : `inset 0 0 8px hsla(${cat.hue}, 55%, 65%, 0.06), 0 0 0 0.5px rgba(184,164,232,0.1)`,
        }}
      >
        <span className="text-[12px]">{cat.icon}</span>
      </div>

      {/* Label (appears on hover or selected) */}
      <div
        className={cn(
          'absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap transition-opacity duration-300',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <span className="text-[8px] tracking-[0.1em] uppercase text-white/25">{cat.label}</span>
      </div>

      {/* Approved checkmark */}
      {isKept && (
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white/[0.08] border border-white/[0.12] flex items-center justify-center">
          <Check className="w-2.5 h-2.5 text-white/50" />
        </div>
      )}
    </button>
  );
}

// ─── Core Star (Takeaway) ───────────────────────────────────────────────────

function CoreStar({ takeaway, pulsing }: { takeaway: string; pulsing?: boolean }) {
  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center z-10">
      {/* Outer glow */}
      <div
        className="absolute rounded-full motion-safe:animate-breatheSlow"
        style={{
          width: 300,
          height: 300,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(184,164,232,0.08) 0%, transparent 55%)',
          filter: 'blur(40px)',
        }}
      />

      {/* Inner glow */}
      <div
        className={cn('absolute rounded-full', pulsing && 'motion-safe:animate-breathe')}
        style={{
          width: 160,
          height: 160,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(184,164,232,0.14) 0%, transparent 60%)',
          filter: 'blur(20px)',
        }}
      />

      {/* Core ring */}
      <div
        className="relative w-32 h-32 rounded-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(circle, rgba(12,12,20,0.9) 0%, rgba(3,3,8,0.95) 100%)',
          boxShadow: `
            inset 0 0 30px rgba(184,164,232,0.1),
            0 0 0 1px rgba(184,164,232,0.12),
            0 0 60px rgba(184,164,232,0.06)
          `,
        }}
      >
        <p className="font-cormorant text-[11px] sm:text-[12px] leading-snug text-white/45 text-center px-4">
          {takeaway}
        </p>
      </div>

      <span className="text-[8px] tracking-[0.14em] uppercase text-white/15 mt-3">takeaway</span>
    </div>
  );
}

// ─── Detail Panel (expands when node selected) ──────────────────────────────

interface DetailPanelProps {
  candidate: (typeof MOCK_CANDIDATES)[0] | null;
  decision: Decision;
  onKeep: () => void;
  onDiscard: () => void;
  onEdit: () => void;
  onClose: () => void;
}

function DetailPanel({ candidate, decision, onKeep, onDiscard, onEdit, onClose }: DetailPanelProps) {
  if (!candidate) return null;
  const cat = getCat(candidate.category);
  const isProcessed = decision !== 'idle';

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center pointer-events-none"
      style={{ paddingBottom: 80 }}
    >
      <div
        className={cn(
          'pointer-events-auto w-full max-w-md mx-4 rounded-3xl px-6 py-6 backdrop-blur-xl',
          'motion-safe:animate-fadeIn',
        )}
        style={{
          background: 'rgba(8,8,16,0.85)',
          border: '1px solid rgba(184,164,232,0.08)',
          boxShadow: '0 -10px 60px rgba(184,164,232,0.06), 0 0 0 1px rgba(255,255,255,0.03)',
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-full hover:bg-white/[0.04] transition-colors"
          aria-label="Close detail"
        >
          <X className="w-3.5 h-3.5 text-white/25" />
        </button>

        {/* Category */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm">{cat.icon}</span>
          <span className="text-[10px] tracking-[0.12em] uppercase text-white/25">{cat.label}</span>
          <div className="flex-1" />
          <span className="text-[9px] tracking-[0.08em] text-white/15">
            {Math.round(candidate.confidence * 100)}% confidence
          </span>
        </div>

        {/* Memory text */}
        <p className="font-cormorant text-[19px] sm:text-[22px] leading-relaxed text-white/65 font-light mb-2">
          {candidate.text}
        </p>

        {/* Reason */}
        <p className="text-[11px] text-white/20 mb-6 italic">{candidate.reason}</p>

        {/* Actions */}
        {!isProcessed ? (
          <div className="flex items-center gap-3">
            <button
              onClick={onKeep}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl transition-all duration-300',
                'bg-white/[0.04] border border-white/[0.08] text-white/40',
                'hover:bg-white/[0.08] hover:text-white/70 hover:border-white/[0.14]',
                'hover:shadow-[0_0_20px_rgba(184,164,232,0.12)]',
              )}
            >
              <Check className="w-3.5 h-3.5" />
              <span className="text-[10px] tracking-[0.08em] uppercase">Keep this</span>
            </button>
            <button
              onClick={onEdit}
              className={cn(
                'p-2.5 rounded-xl transition-all duration-300',
                'bg-white/[0.03] border border-white/[0.06] text-white/25',
                'hover:bg-white/[0.06] hover:text-white/50',
              )}
              aria-label="Edit"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDiscard}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl transition-all duration-300',
                'bg-white/[0.04] border border-white/[0.08] text-white/30',
                'hover:bg-red-500/[0.06] hover:text-red-300/50 hover:border-red-400/[0.12]',
              )}
            >
              <X className="w-3.5 h-3.5" />
              <span className="text-[10px] tracking-[0.08em] uppercase">Let it go</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-2 rounded-xl bg-white/[0.03] border border-white/[0.04]">
            {(decision === 'approved' || decision === 'edited') && <Check className="w-3.5 h-3.5 text-white/40" />}
            {decision === 'discarded' && <X className="w-3.5 h-3.5 text-white/20" />}
            <span className="text-[10px] tracking-[0.08em] uppercase text-white/30">
              {decision === 'approved' ? 'kept' : decision === 'edited' ? 'refined' : 'released'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Reflection Overlay ─────────────────────────────────────────────────────

function ReflectionOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center text-center max-w-md px-8 motion-safe:animate-fadeIn"
    >
      {/* Core glow amplified */}
      <div
        className="absolute rounded-full motion-safe:animate-breatheSlow"
        style={{
          width: 500,
          height: 500,
          background: 'radial-gradient(circle, rgba(184,164,232,0.1) 0%, transparent 50%)',
          filter: 'blur(80px)',
        }}
      />

      <div className="relative z-10 flex flex-col items-center">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center mb-8 motion-safe:animate-breathe"
          style={{
            background: 'radial-gradient(circle, rgba(184,164,232,0.08) 0%, transparent 70%)',
            boxShadow: 'inset 0 0 0 1px rgba(184,164,232,0.12), 0 0 40px rgba(184,164,232,0.06)',
          }}
        >
          <span className="text-2xl opacity-60">💭</span>
        </div>

        <p className="font-cormorant italic text-[13px] tracking-[0.06em] text-white/25 mb-4">
          Something to reflect on
        </p>

        <p className="font-cormorant text-[22px] sm:text-[26px] leading-relaxed text-white/60 font-light mb-8">
          {MOCK_REFLECTION.prompt}
        </p>

        <button
          className={cn(
            'px-5 py-2 rounded-full transition-all duration-300',
            'text-[10px] tracking-[0.08em] uppercase',
            'bg-white/[0.04] border border-white/[0.06] text-white/25',
            'hover:bg-white/[0.08] hover:text-white/40',
            'hover:shadow-[0_0_20px_rgba(184,164,232,0.1)]',
          )}
        >
          Sit with this for a moment →
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function PrototypeC() {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEntrance, setShowEntrance] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowEntrance(true), 100);
    return () => clearTimeout(t);
  }, []);

  const reviewedCount = useMemo(
    () => Object.values(decisions).filter((d) => d !== 'idle').length,
    [decisions],
  );

  const allDone = reviewedCount === MOCK_CANDIDATES.length;

  const selectedCandidate = useMemo(
    () => MOCK_CANDIDATES.find((c) => c.id === selectedId) ?? null,
    [selectedId],
  );

  const makeDecision = useCallback(
    (id: string, decision: Decision) => {
      setDecisions((prev) => ({ ...prev, [id]: decision }));
      // Auto-close after brief delay
      setTimeout(() => setSelectedId(null), 400);
    },
    [],
  );

  // Compute orbital angles — evenly distributed
  const nodeAngles = useMemo(() => {
    const count = MOCK_CANDIDATES.length;
    return MOCK_CANDIDATES.map((_, i) => -90 + (360 / count) * i);
  }, []);

  // Responsive radius
  const [orbitRadius, setOrbitRadius] = useState(180);
  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth;
      if (vw < 480) setOrbitRadius(120);
      else if (vw < 768) setOrbitRadius(160);
      else setOrbitRadius(200);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <CosmicBackground />

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 px-4 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <ArrowLeft className="w-5 h-5 text-white/40" />
          </button>
          <span
            className={cn(
              'font-cormorant text-[13px] tracking-[0.08em] text-white/25 transition-opacity duration-700',
              showEntrance ? 'opacity-100' : 'opacity-0',
            )}
          >
            session recap
          </span>
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <Home className="w-5 h-5 text-white/40" />
          </button>
        </div>
      </header>

      {/* Progress counter */}
      <div
        className={cn(
          'fixed top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 transition-all duration-700',
          showEntrance ? 'opacity-100' : 'opacity-0',
        )}
      >
        <span className="text-[10px] tracking-[0.14em] uppercase text-white/18">key takeaway</span>
      </div>

      {/* Galaxy Ring System */}
      <main className="relative z-10 h-screen flex items-center justify-center">
        <div
          className={cn(
            'relative transition-all duration-1000 ease-out',
            showEntrance ? 'opacity-100 scale-100' : 'opacity-0 scale-90',
          )}
          style={{ width: orbitRadius * 2 + 100, height: orbitRadius * 2 + 100 }}
        >
          {/* Orbital rings */}
          <OrbitalRing radius={orbitRadius} opacity={0.06} />
          <OrbitalRing radius={orbitRadius * 0.55} opacity={0.04} dashed />
          <OrbitalRing radius={orbitRadius * 1.3} opacity={0.02} dashed />

          {/* Connecting lines to core */}
          <svg
            className="absolute inset-0 pointer-events-none"
            style={{ width: '100%', height: '100%' }}
            viewBox={`0 0 ${orbitRadius * 2 + 100} ${orbitRadius * 2 + 100}`}
          >
            {MOCK_CANDIDATES.map((c, i) => {
              const decision = decisions[c.id] ?? 'idle';
              const isKept = decision === 'approved' || decision === 'edited';
              const isDiscarded = decision === 'discarded';
              const r = isKept ? orbitRadius * 0.55 : isDiscarded ? orbitRadius * 1.3 : orbitRadius;
              const rad = (nodeAngles[i] * Math.PI) / 180;
              const cx = orbitRadius + 50;
              const cy = orbitRadius + 50;
              const nx = cx + Math.cos(rad) * r;
              const ny = cy + Math.sin(rad) * r;
              return (
                <line
                  key={c.id}
                  x1={cx}
                  y1={cy}
                  x2={nx}
                  y2={ny}
                  stroke={`rgba(184, 164, 232, ${isDiscarded ? 0.01 : isKept ? 0.06 : 0.03})`}
                  strokeWidth="0.5"
                  className="transition-all duration-1000"
                />
              );
            })}
          </svg>

          {/* Core star */}
          {!allDone && <CoreStar takeaway={MOCK_TAKEAWAY} pulsing={reviewedCount > 0} />}

          {/* Reflection (replaces core when done) */}
          <ReflectionOverlay visible={allDone} />

          {/* Orbital nodes */}
          {MOCK_CANDIDATES.map((candidate, i) => (
            <OrbitalNode
              key={candidate.id}
              candidate={candidate}
              angle={nodeAngles[i]}
              radius={orbitRadius}
              isSelected={selectedId === candidate.id}
              decision={decisions[candidate.id] ?? 'idle'}
              onClick={() => setSelectedId(selectedId === candidate.id ? null : candidate.id)}
            />
          ))}
        </div>

        {/* Status text above orbit */}
        <div className="absolute top-[12%] left-1/2 -translate-x-1/2 flex flex-col items-center text-center">
          <div className="relative max-w-xl px-6">
            <div
              className="absolute inset-0 -z-10"
              style={{
                background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(184,164,232,0.06) 0%, transparent 65%)',
                filter: 'blur(30px)',
                transform: 'scale(1.5)',
              }}
            />
            <h1 className="font-cormorant text-[22px] sm:text-[28px] md:text-[32px] font-light text-white/[0.75] leading-snug">
              {MOCK_TAKEAWAY}
            </h1>
          </div>
          <div className="flex items-center gap-2 mt-4">
            {MOCK_CANDIDATES.map((c) => {
              const d = decisions[c.id] ?? 'idle';
              return (
                <div
                  key={c.id}
                  className="w-1.5 h-1.5 rounded-full transition-all duration-500"
                  style={{
                    background:
                      d === 'approved' || d === 'edited'
                        ? 'var(--sophia-purple)'
                        : d === 'discarded'
                          ? 'rgba(255,255,255,0.08)'
                          : 'rgba(255,255,255,0.15)',
                    boxShadow:
                      d === 'approved' || d === 'edited'
                        ? '0 0 6px var(--sophia-purple)'
                        : 'none',
                  }}
                />
              );
            })}
          </div>
          <p className="text-[10px] tracking-[0.08em] text-white/15 mt-2">
            {allDone ? 'all memories reviewed' : `${reviewedCount} of ${MOCK_CANDIDATES.length} reviewed`}
          </p>
        </div>
      </main>

      {/* Detail panel */}
      <DetailPanel
        candidate={selectedCandidate}
        decision={decisions[selectedId ?? ''] ?? 'idle'}
        onKeep={() => selectedId && makeDecision(selectedId, 'approved')}
        onDiscard={() => selectedId && makeDecision(selectedId, 'discarded')}
        onEdit={() => selectedId && makeDecision(selectedId, 'edited')}
        onClose={() => setSelectedId(null)}
      />

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-[rgba(3,3,8,0.65)] backdrop-blur-[20px] border-t border-white/[0.04]">
        <div className="px-4 py-4 max-w-2xl mx-auto flex items-center justify-between">
          <button className="px-4 py-2 rounded-full text-[11px] tracking-[0.08em] uppercase text-white/30 hover:text-white/50 hover:bg-white/[0.04] transition-colors">
            Return home
          </button>
          <div className="flex items-center gap-3">
            <span className="text-[10px] tracking-[0.06em] text-white/20">
              {reviewedCount}/{MOCK_CANDIDATES.length}
            </span>
            <button
              className={cn(
                'px-5 py-2 rounded-full text-[11px] tracking-[0.08em] uppercase transition-all',
                allDone
                  ? 'bg-white/[0.08] border border-white/[0.10] text-white/60 hover:bg-white/[0.12] hover:text-white/80'
                  : 'bg-white/[0.03] border border-white/[0.05] text-white/20 cursor-default',
              )}
            >
              {allDone ? 'complete' : 'tap a memory'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
