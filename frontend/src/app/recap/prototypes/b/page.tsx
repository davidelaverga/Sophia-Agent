/**
 * Recap Prototype B — "Nebula Stream"
 * /recap/prototypes/b
 *
 * Full-screen vertical flow — each memory gets its own cinematic moment.
 * - Vertical snap-scroll through memories
 * - Each memory section has its own nebula color cluster
 * - Swipe-up to keep, swipe-down to discard, or use buttons
 * - Takeaway floats at the top as an ambient "north star"
 * - Depth indicator on the right edge (vertical progress)
 * - Reflection emerges at the final depth as a calm invitation
 * - Ambient particle trails connect the sections
 *
 * Hard mock data — no backend required.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronDown, Home, Pencil, X } from 'lucide-react';
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
  relationship_context: { label: 'Relationships', icon: '🤝', hue: 200 },
  regulation_tools: { label: 'Regulation', icon: '🫁', hue: 180 },
  wins_pride: { label: 'Wins', icon: '🏆', hue: 45 },
  temporary_context: { label: 'Right Now', icon: '⏱️', hue: 260 },
};

type Decision = 'idle' | 'approved' | 'edited' | 'discarded';

function getCat(cat?: string) {
  return CATEGORY_MAP[cat ?? ''] ?? { label: 'Memory', icon: '•', hue: 270 };
}

// ─── Cosmic Background (per-section with per-memory hue) ─────────────────

function SectionNebula({ hue, intensity = 1 }: { hue: number; intensity?: number }) {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* Central nebula cluster in the section's hue */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[700px] rounded-full motion-safe:animate-breatheSlow"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 50% 50%, hsla(${hue}, 55%, 65%, ${0.1 * intensity}) 0%, transparent 65%)`,
          filter: 'blur(100px)',
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full motion-safe:animate-breathe"
        style={{
          background: `radial-gradient(circle at 50% 55%, hsla(${hue}, 60%, 60%, ${0.18 * intensity}) 0%, transparent 50%)`,
          filter: 'blur(60px)',
        }}
      />
      {/* Accent bloom offset */}
      <div
        className="absolute top-[35%] left-[60%] -translate-x-1/2 -translate-y-1/2 w-[400px] h-[300px] rounded-full motion-safe:animate-glowPulse"
        style={{
          background: `radial-gradient(ellipse at center, hsla(${hue + 30}, 50%, 70%, ${0.06 * intensity}) 0%, transparent 60%)`,
          filter: 'blur(80px)',
        }}
      />
    </div>
  );
}

function GlobalBackground() {
  const [stars, setStars] = useState<
    { left: string; top: string; size: number; opacity: number; delay: number; duration: number }[]
  >([]);

  useEffect(() => {
    const seed = 77;
    const sr = (i: number) => {
      const x = Math.sin(seed + i * 9999) * 10000;
      return x - Math.floor(x);
    };
    setStars(
      [...Array(80)].map((_, i) => ({
        left: `${2 + sr(i * 3) * 96}%`,
        top: `${2 + sr(i * 3 + 1) * 96}%`,
        size: 0.3 + sr(i * 3 + 2) * 1.4,
        opacity: 0.05 + sr(i * 5) * 0.18,
        delay: i * 80,
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
      {/* Grain overlay */}
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

// ─── Depth Indicator ────────────────────────────────────────────────────────

function DepthIndicator({
  total,
  current,
  reviewed,
}: {
  total: number;
  current: number;
  reviewed: number;
}) {
  return (
    <div className="fixed right-4 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-2">
      {Array.from({ length: total + 1 }).map((_, i) => {
        const isReviewed = i < total && i < reviewed;
        const isCurrent = i === current;
        const isReflection = i === total;
        return (
          <div key={i} className="flex flex-col items-center">
            <div
              className={cn(
                'rounded-full transition-all duration-500',
                isCurrent ? 'w-2 h-2' : 'w-1.5 h-1.5',
              )}
              style={{
                background: isCurrent
                  ? 'var(--sophia-purple)'
                  : isReviewed
                    ? 'rgba(184,164,232,0.35)'
                    : isReflection
                      ? 'rgba(184,164,232,0.12)'
                      : 'rgba(255,255,255,0.1)',
                boxShadow: isCurrent ? '0 0 8px var(--sophia-purple)' : 'none',
              }}
            />
            {i < total && (
              <div
                className="w-px h-4 my-0.5"
                style={{
                  background: isReviewed
                    ? 'rgba(184,164,232,0.2)'
                    : 'rgba(255,255,255,0.04)',
                }}
              />
            )}
          </div>
        );
      })}
      <span className="text-[8px] tracking-[0.12em] uppercase text-white/15 mt-1 writing-mode-vertical">
        {reviewed}/{total}
      </span>
    </div>
  );
}

// ─── Memory Section ─────────────────────────────────────────────────────────

interface MemorySectionProps {
  candidate: (typeof MOCK_CANDIDATES)[0];
  index: number;
  isActive: boolean;
  decision: Decision;
  onKeep: () => void;
  onDiscard: () => void;
  onEdit: () => void;
}

function MemorySection({ candidate, index, isActive, decision, onKeep, onDiscard, onEdit }: MemorySectionProps) {
  const cat = getCat(candidate.category);
  const isProcessed = decision !== 'idle';
  const [showReason, setShowReason] = useState(false);

  return (
    <section
      className="relative h-screen w-full flex items-center justify-center snap-start snap-always"
      aria-label={`Memory ${index + 1}: ${candidate.text.slice(0, 50)}...`}
    >
      <SectionNebula hue={cat.hue} intensity={isActive ? 1 : 0.3} />

      {/* Memory content */}
      <div
        className={cn(
          'relative z-10 flex flex-col items-center text-center max-w-lg px-8 transition-all duration-700 ease-out',
          isActive && !isProcessed ? 'opacity-100 translate-y-0 scale-100' : '',
          isActive && isProcessed ? 'opacity-60 translate-y-0 scale-95' : '',
          !isActive ? 'opacity-0 translate-y-8 scale-95' : '',
        )}
      >
        {/* Category & index */}
        <div className="flex items-center gap-3 mb-8">
          <span className="text-[10px] tracking-[0.14em] uppercase text-white/18">
            {cat.icon} {cat.label}
          </span>
          <span className="text-[9px] text-white/10">·</span>
          <span className="text-[9px] tracking-[0.12em] uppercase text-white/12">
            {index + 1} of {MOCK_CANDIDATES.length}
          </span>
        </div>

        {/* Confidence arc */}
        <div className="relative mb-8">
          <svg className="w-48 h-48" viewBox="0 0 200 200">
            {/* Background circle */}
            <circle cx="100" cy="100" r="90" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
            {/* Confidence arc */}
            <circle
              cx="100"
              cy="100"
              r="90"
              fill="none"
              stroke={`hsla(${cat.hue}, 55%, 65%, 0.25)`}
              strokeWidth="1"
              strokeDasharray={`${candidate.confidence * 565} 565`}
              strokeLinecap="round"
              style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
              className="transition-all duration-1000 ease-out"
            />
          </svg>

          {/* Text inside the invisible circle */}
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <p className="font-cormorant text-[20px] sm:text-[24px] leading-relaxed text-white/70 font-light">
              {candidate.text}
            </p>
          </div>
        </div>

        {/* Why this? */}
        <button
          onClick={() => setShowReason(!showReason)}
          className="text-[9px] tracking-[0.1em] uppercase text-white/15 hover:text-white/30 transition-colors mb-6"
        >
          {showReason ? 'hide' : 'why this memory?'}
        </button>
        {showReason && (
          <p className="text-[11px] text-white/25 mb-6 max-w-xs motion-safe:animate-fadeIn">
            {candidate.reason}
          </p>
        )}

        {/* Actions */}
        {!isProcessed && (
          <div className="flex items-center gap-4 motion-safe:animate-fadeIn" style={{ animationDelay: '300ms' }}>
            {/* Keep */}
            <button
              onClick={onKeep}
              className={cn(
                'group flex flex-col items-center gap-2 p-4 rounded-2xl transition-all duration-300',
                'bg-white/[0.03] border border-white/[0.06]',
                'hover:bg-white/[0.06] hover:border-white/[0.10]',
                'hover:shadow-[0_0_25px_rgba(184,164,232,0.12)]',
              )}
            >
              <div className="w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center group-hover:bg-white/[0.08] transition-all">
                <ArrowUp className="w-4 h-4 text-white/40 group-hover:text-white/70 transition-colors" />
              </div>
              <span className="text-[9px] tracking-[0.1em] uppercase text-white/25 group-hover:text-white/45">keep</span>
            </button>

            {/* Edit */}
            <button
              onClick={onEdit}
              className={cn(
                'group flex flex-col items-center gap-2 p-4 rounded-2xl transition-all duration-300',
                'bg-white/[0.03] border border-white/[0.06]',
                'hover:bg-white/[0.06] hover:border-white/[0.10]',
              )}
            >
              <div className="w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center group-hover:bg-white/[0.08] transition-all">
                <Pencil className="w-4 h-4 text-white/30 group-hover:text-white/60 transition-colors" />
              </div>
              <span className="text-[9px] tracking-[0.1em] uppercase text-white/25 group-hover:text-white/45">refine</span>
            </button>

            {/* Discard */}
            <button
              onClick={onDiscard}
              className={cn(
                'group flex flex-col items-center gap-2 p-4 rounded-2xl transition-all duration-300',
                'bg-white/[0.03] border border-white/[0.06]',
                'hover:bg-red-500/[0.04] hover:border-red-400/[0.10]',
              )}
            >
              <div className="w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center group-hover:bg-red-500/[0.06] transition-all">
                <X className="w-4 h-4 text-white/30 group-hover:text-red-300/60 transition-colors" />
              </div>
              <span className="text-[9px] tracking-[0.1em] uppercase text-white/25 group-hover:text-red-300/40">let go</span>
            </button>
          </div>
        )}

        {/* Processed badge */}
        {isProcessed && (
          <div
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-full motion-safe:animate-fadeIn',
              decision === 'approved' || decision === 'edited'
                ? 'bg-white/[0.04] border border-white/[0.08]'
                : 'bg-white/[0.02] border border-white/[0.04]',
            )}
          >
            {(decision === 'approved' || decision === 'edited') && (
              <Check className="w-3.5 h-3.5 text-white/40" />
            )}
            {decision === 'discarded' && <X className="w-3.5 h-3.5 text-white/20" />}
            <span className="text-[10px] tracking-[0.08em] uppercase text-white/30">
              {decision === 'approved' ? 'kept' : decision === 'edited' ? 'refined' : 'released'}
            </span>
          </div>
        )}
      </div>

      {/* Scroll hint (first section only) */}
      {index === 0 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 motion-safe:animate-breathe">
          <ChevronDown className="w-4 h-4 text-white/15" />
          <span className="text-[8px] tracking-[0.12em] uppercase text-white/10">scroll</span>
        </div>
      )}
    </section>
  );
}

// ─── Reflection Section ─────────────────────────────────────────────────────

function ReflectionSection({ isActive }: { isActive: boolean }) {
  return (
    <section
      className="relative h-screen w-full flex items-center justify-center snap-start snap-always"
      aria-label="Reflection"
    >
      <SectionNebula hue={300} intensity={0.5} />

      <div
        className={cn(
          'relative z-10 flex flex-col items-center text-center max-w-lg px-8 transition-all duration-700 ease-out',
          isActive ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8',
        )}
      >
        {/* Glowing ring */}
        <div
          className="w-28 h-28 rounded-full flex items-center justify-center mb-10 motion-safe:animate-breatheSlow"
          style={{
            background: 'radial-gradient(circle, rgba(184,164,232,0.08) 0%, transparent 70%)',
            boxShadow: 'inset 0 0 0 1px rgba(184,164,232,0.1), 0 0 40px rgba(184,164,232,0.06)',
          }}
        >
          <span className="text-3xl opacity-60">💭</span>
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
    </section>
  );
}

// ─── Takeaway Header ────────────────────────────────────────────────────────

function FloatingTakeaway({ visible }: { visible: boolean }) {
  return (
    <div
      className={cn(
        'fixed top-16 left-0 right-0 z-30 flex flex-col items-center pointer-events-none transition-all duration-700',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4',
      )}
    >
      <span className="text-[9px] tracking-[0.14em] uppercase text-white/15 mb-2">key takeaway</span>
      <p className="font-cormorant text-[16px] sm:text-[18px] text-white/40 text-center max-w-md px-6">
        {MOCK_TAKEAWAY}
      </p>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function PrototypeB() {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [activeSection, setActiveSection] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalSections = MOCK_CANDIDATES.length + 1; // +1 for reflection

  const reviewedCount = useMemo(
    () => Object.values(decisions).filter((d) => d !== 'idle').length,
    [decisions],
  );

  const makeDecision = useCallback((id: string, decision: Decision) => {
    setDecisions((prev) => ({ ...prev, [id]: decision }));
  }, []);

  // Intersection observer for active section
  useEffect(() => {
    if (!scrollRef.current) return;
    const sections = scrollRef.current.querySelectorAll('section');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = Array.from(sections).indexOf(entry.target as HTMLElement);
            if (idx >= 0) setActiveSection(idx);
          }
        }
      },
      { root: scrollRef.current, threshold: 0.6 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  const allDone = reviewedCount === MOCK_CANDIDATES.length;

  return (
    <div className="relative min-h-screen">
      <GlobalBackground />

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 px-4 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <ArrowLeft className="w-5 h-5 text-white/40" />
          </button>
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <Home className="w-5 h-5 text-white/40" />
          </button>
        </div>
      </header>

      {/* Floating takeaway */}
      <FloatingTakeaway visible={activeSection > 0} />

      {/* Depth indicator */}
      <DepthIndicator total={MOCK_CANDIDATES.length} current={activeSection} reviewed={reviewedCount} />

      {/* Snap scroll container */}
      <div
        ref={scrollRef}
        className="h-screen overflow-y-auto snap-y snap-mandatory scroll-smooth"
        style={{ scrollbarWidth: 'none' }}
      >
        {/* Takeaway section (first screen) */}
        <section className="relative h-screen w-full flex items-center justify-center snap-start snap-always">
          <SectionNebula hue={270} intensity={0.8} />
          <div className="relative z-10 flex flex-col items-center text-center px-8">
            <span className="text-[10px] tracking-[0.14em] uppercase text-white/18 mb-6">key takeaway</span>
            <div className="relative max-w-2xl">
              <div
                className="absolute inset-0 -z-10 motion-safe:animate-breatheSlow"
                style={{
                  background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(184,164,232,0.12) 0%, transparent 65%)',
                  filter: 'blur(50px)',
                  transform: 'scale(1.8)',
                }}
              />
              <h1 className="font-cormorant text-[30px] sm:text-[38px] md:text-[44px] font-light text-white/[0.88] leading-snug">
                {MOCK_TAKEAWAY}
              </h1>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-0 mt-10" aria-hidden="true">
              <div className="w-20 sm:w-28 h-px" style={{ background: 'linear-gradient(to right, transparent, rgba(184,164,232,0.3))' }} />
              <div className="relative mx-0">
                <div className="w-[6px] h-[6px] rounded-full bg-white/80" />
                <div
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full motion-safe:animate-glowPulse"
                  style={{ background: 'radial-gradient(circle, var(--sophia-purple) 0%, transparent 70%)', opacity: 0.6 }}
                />
              </div>
              <div className="w-20 sm:w-28 h-px" style={{ background: 'linear-gradient(to left, transparent, rgba(184,164,232,0.3))' }} />
            </div>

            <p className="text-[10px] tracking-[0.1em] uppercase text-white/15 mt-8">
              {MOCK_CANDIDATES.length} memories to review
            </p>

            <div className="mt-12 motion-safe:animate-breathe">
              <ChevronDown className="w-5 h-5 text-white/15" />
            </div>
          </div>
        </section>

        {/* Memory sections */}
        {MOCK_CANDIDATES.map((candidate, i) => (
          <MemorySection
            key={candidate.id}
            candidate={candidate}
            index={i}
            isActive={activeSection === i + 1}
            decision={decisions[candidate.id] ?? 'idle'}
            onKeep={() => makeDecision(candidate.id, 'approved')}
            onDiscard={() => makeDecision(candidate.id, 'discarded')}
            onEdit={() => makeDecision(candidate.id, 'edited')}
          />
        ))}

        {/* Reflection section */}
        <ReflectionSection isActive={activeSection === MOCK_CANDIDATES.length + 1} />
      </div>

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
              {allDone ? 'complete' : 'reviewing...'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
