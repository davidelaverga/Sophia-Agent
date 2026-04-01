'use client';

import { useEffect, useState } from 'react';
import { Check, MessageCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

const NOISE_SVG = `data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E`;

export function CosmicBackground() {
  const [stars, setStars] = useState<Array<{
    left: string;
    top: string;
    size: number;
    opacity: number;
    delay: number;
    duration: number;
  }>>([]);

  useEffect(() => {
    const seed = 42;
    const seededRandom = (i: number) => {
      const x = Math.sin(seed + i * 9999) * 10000;
      return x - Math.floor(x);
    };
    const nextStars = [...Array(50)].map((_, i) => ({
      left: `${3 + seededRandom(i * 3) * 94}%`,
      top: `${3 + seededRandom(i * 3 + 1) * 94}%`,
      size: 0.4 + seededRandom(i * 3 + 2) * 1.2,
      opacity: 0.08 + seededRandom(i * 5) * 0.18,
      delay: i * 120,
      duration: 3 + seededRandom(i * 7) * 4,
    }));
    setStars(nextStars);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="absolute inset-0" style={{ background: 'var(--bg)' }} />

      <div className="absolute inset-0">
        {stars.map((star, i) => (
          <div
            key={i}
            className="absolute rounded-full motion-safe:animate-pulseSoft"
            style={{
              left: star.left,
              top: star.top,
              width: `${star.size}px`,
              height: `${star.size}px`,
              background: 'var(--text)',
              opacity: star.opacity,
              animationDelay: `${star.delay}ms`,
              animationDuration: `${star.duration}s`,
            }}
          />
        ))}
      </div>

      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[45%] w-[1600px] h-[1200px] rounded-full mix-blend-soft-light"
        style={{
          background: 'radial-gradient(ellipse 80% 70% at 50% 50%, var(--sophia-glow) 0%, transparent 60%)',
          opacity: 0.04,
          filter: 'blur(150px)',
        }}
      />

      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[42%] w-[2000px] h-[1400px] rounded-full mix-blend-screen"
        style={{
          background: 'radial-gradient(ellipse 75% 60% at 50% 48%, var(--sophia-purple) 0%, transparent 55%)',
          opacity: 0.025,
          filter: 'blur(200px)',
        }}
      />

      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[40%] w-[1200px] h-[900px] rounded-full motion-safe:animate-breatheSlow"
        style={{
          background: 'radial-gradient(ellipse 70% 55% at 50% 50%, var(--sophia-purple) 0%, transparent 70%)',
          opacity: 0.06,
          filter: 'blur(120px)',
        }}
      />

      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full motion-safe:animate-glowPulse"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% 55%, var(--sophia-purple) 0%, var(--sophia-glow) 30%, transparent 65%)',
          opacity: 0.08,
          filter: 'blur(90px)',
        }}
      />

      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full motion-safe:animate-breathe"
        style={{
          background: 'radial-gradient(circle at 50% 55%, var(--sophia-purple) 0%, transparent 55%)',
          opacity: 0.14,
          filter: 'blur(60px)',
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 65% 60% at 50% 50%, transparent 20%, var(--bg) 75%, var(--bg) 100%)',
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 120% 80% at 0% 0%, var(--bg) 0%, transparent 50%),
            radial-gradient(ellipse 120% 80% at 100% 0%, var(--bg) 0%, transparent 50%),
            radial-gradient(ellipse 120% 80% at 0% 100%, var(--bg) 0%, transparent 50%),
            radial-gradient(ellipse 120% 80% at 100% 100%, var(--bg) 0%, transparent 50%)
          `,
          opacity: 0.5,
        }}
      />

      <div
        className="absolute inset-0 mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `url("${NOISE_SVG}")`,
          backgroundRepeat: 'repeat',
          backgroundSize: '180px 180px',
          opacity: 0.024,
          zIndex: 0,
        }}
      />
    </div>
  );
}

interface KeyTakeawayProps {
  takeaway?: string;
  isLoading?: boolean;
}

export function KeyTakeaway({ takeaway, isLoading }: KeyTakeawayProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center text-center px-6 mb-14">
        <div className="h-3 w-24 bg-sophia-text2/10 rounded animate-pulse mb-6" />
        <div className="h-9 w-4/5 max-w-lg bg-sophia-text2/5 rounded animate-pulse mb-4" />
        <div className="flex items-center gap-4 mt-7">
          <div className="w-20 h-px" style={{ background: 'var(--card-border)' }} />
          <div className="w-2 h-2 rounded-full" style={{ background: 'var(--sophia-purple)', opacity: 0.3 }} />
          <div className="w-20 h-px" style={{ background: 'var(--card-border)' }} />
        </div>
      </div>
    );
  }

  if (!takeaway) return null;

  return (
    <div className="flex flex-col items-center text-center px-6 mb-14 motion-safe:animate-fadeIn" role="banner">
      <span className="text-[11px] font-medium tracking-[0.35em] uppercase text-sophia-text2/40 mb-5">
        KEY TAKEAWAY
      </span>

      <div className="relative max-w-2xl">
        <div
          className="absolute inset-0 -z-10 motion-safe:animate-breatheSlow"
          style={{
            background: 'radial-gradient(ellipse 80% 60% at 50% 50%, var(--sophia-purple) 0%, transparent 65%)',
            filter: 'blur(50px)',
            opacity: 0.12,
            transform: 'scale(1.8) translateY(10%)',
          }}
          aria-hidden="true"
        />

        <h1 className="text-2xl sm:text-[28px] md:text-[32px] font-normal text-sophia-text leading-snug tracking-[-0.01em]">
          {takeaway}
        </h1>
      </div>

      <div className="flex items-center gap-0 mt-8" aria-hidden="true">
        <div
          className="w-20 sm:w-28 h-px"
          style={{
            background: 'linear-gradient(to right, transparent, var(--sophia-purple))',
            opacity: 0.3,
          }}
        />

        <div className="relative mx-0">
          <div className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--sophia-text)', opacity: 0.9 }} />
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full motion-safe:animate-glowPulse"
            style={{
              background: 'radial-gradient(circle, var(--sophia-purple) 0%, transparent 70%)',
              opacity: 0.6,
            }}
          />
        </div>

        <div
          className="w-20 sm:w-28 h-px"
          style={{
            background: 'linear-gradient(to left, transparent, var(--sophia-purple))',
            opacity: 0.3,
          }}
        />
      </div>
    </div>
  );
}

interface ReflectionPromptProps {
  prompt?: string;
  tag?: string;
  onReflect?: () => void;
  isLoading?: boolean;
}

export function ReflectionPrompt({ prompt, onReflect, isLoading }: ReflectionPromptProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center px-6 mt-10">
        <div className="h-5 w-40 bg-sophia-text2/10 rounded animate-pulse mb-3" />
        <div className="h-4 w-64 bg-sophia-text2/5 rounded animate-pulse" />
      </div>
    );
  }

  if (!prompt) return null;

  return (
    <div
      className="flex flex-col items-center text-center px-6 mt-10 max-w-xl mx-auto motion-safe:animate-fadeIn"
      role="complementary"
      aria-label="Reflection prompt"
    >
      <div
        className="relative w-full rounded-2xl backdrop-blur-xl px-6 py-5 overflow-hidden"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid color-mix(in srgb, var(--sophia-purple) 60%, transparent)',
          opacity: 0.95,
          boxShadow: '0 0 50px color-mix(in srgb, var(--sophia-purple) 40%, transparent)',
        }}
      >
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'var(--sophia-purple)', opacity: 0.8 }}>
            <MessageCircle className="w-3 h-3 text-sophia-bg" />
          </div>
          <span className="text-sm font-medium text-sophia-text">Something to reflect on</span>
        </div>

        <p className="text-sophia-text/90 leading-relaxed text-left pl-4 text-[15px]" style={{ borderLeft: '2px solid var(--sophia-purple)' }}>
          {prompt}
        </p>

        {onReflect && (
          <button
            onClick={onReflect}
            className={cn(
              'mt-5 text-sm text-sophia-text2/50 hover:text-sophia-purple',
              'transition-colors duration-300',
              'flex items-center gap-1.5 group'
            )}
          >
            <span>Sit with this for a moment</span>
            <span className="group-hover:translate-x-1 transition-transform duration-300">→</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function RecapOrbitLoading() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center">
      <CosmicBackground />

      <div className="relative z-10 flex flex-col items-center">
        <KeyTakeaway isLoading />

        <div
          className="relative w-[280px] h-[280px] sm:w-[320px] sm:h-[320px] md:w-[360px] md:h-[360px] rounded-full flex items-center justify-center motion-safe:animate-breathe"
          style={{
            background: `
              radial-gradient(ellipse 100% 80% at 50% 75%, var(--sophia-purple) 0%, transparent 50%),
              radial-gradient(circle at 50% 50%, var(--card-bg) 0%, var(--bg) 100%)
            `,
            boxShadow: `
              inset 0 -40px 80px -40px var(--sophia-purple),
              inset 0 40px 60px -40px var(--sophia-glow),
              inset 0 0 0 1px var(--sophia-purple),
              0 0 80px -20px var(--sophia-purple)
            `,
            opacity: 0.7,
          }}
        >
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-sophia-purple/30 border-t-sophia-purple animate-spin" />
            <span className="text-sophia-text2/50 text-sm">Gathering thoughts...</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RecapOrbitEmpty() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center">
      <CosmicBackground />

      <div className="relative z-10 flex flex-col items-center text-center px-6">
        <div
          className="w-[200px] h-[200px] rounded-full flex items-center justify-center mb-6"
          style={{
            background: `
              radial-gradient(ellipse 100% 80% at 50% 75%, var(--sophia-purple) 0%, transparent 50%),
              radial-gradient(circle at 50% 50%, var(--card-bg) 0%, var(--bg) 100%)
            `,
            boxShadow: 'inset 0 -20px 50px -20px var(--sophia-purple), 0 0 40px var(--sophia-purple)',
            opacity: 0.5,
          }}
        >
          <span className="text-4xl opacity-40">🧠</span>
        </div>
        <p className="text-sophia-text font-medium mb-2">No memories to review</p>
        <p className="text-sm text-sophia-text2/50">No new memories from this session.</p>
      </div>
    </div>
  );
}

interface RecapOrbitCompletedProps {
  approvedCount: number;
  approvedMemories?: Array<{
    id: string;
    text: string;
    isEdited: boolean;
  }>;
  takeaway?: string;
  reflectionPrompt?: string;
  reflectionTag?: string;
  onReflect?: () => void;
}

export function RecapOrbitCompleted({
  approvedCount,
  approvedMemories = [],
  takeaway,
  reflectionPrompt,
  onReflect,
}: RecapOrbitCompletedProps) {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center py-12">
      <CosmicBackground />

      <div className="relative z-10 flex flex-col items-center w-full max-w-2xl px-6">
        {takeaway && <KeyTakeaway takeaway={takeaway} />}

        <div
          className="relative w-[280px] h-[280px] sm:w-[320px] sm:h-[320px] md:w-[360px] md:h-[360px] rounded-full flex flex-col items-center justify-center motion-safe:animate-breathe"
          style={{
            background: `
              radial-gradient(ellipse 100% 80% at 50% 75%, var(--sophia-purple) 0%, transparent 50%),
              radial-gradient(circle at 50% 50%, var(--card-bg) 0%, var(--bg) 100%)
            `,
            boxShadow: `
              inset 0 -40px 80px -40px var(--sophia-purple),
              inset 0 40px 60px -40px var(--sophia-glow),
              inset 0 0 0 1px var(--sophia-purple),
              0 0 80px -20px var(--sophia-purple)
            `,
          }}
        >
          <div
            className="absolute inset-0 -z-10 rounded-full motion-safe:animate-glowPulse"
            style={{
              transform: 'scale(1.2)',
              boxShadow: '0 0 60px var(--sophia-purple), 0 0 100px var(--sophia-glow)',
              opacity: 0.15,
            }}
            aria-hidden="true"
          />

          <div className="flex flex-col items-center text-center px-8">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mb-4" style={{ background: 'var(--sophia-purple)', opacity: 0.3 }}>
              <Check className="w-7 h-7 text-sophia-text" />
            </div>
            <p className="text-sophia-text font-medium mb-1">All memories reviewed</p>
            <p className="text-sm text-sophia-text2/50">
              {approvedCount > 0
                ? `${approvedCount} ${approvedCount === 1 ? 'memory' : 'memories'} ready to save`
                : 'No memories selected'}
            </p>
          </div>
        </div>

        {approvedMemories.length > 0 && (
          <div
            className="mt-6 w-full max-w-xl rounded-2xl px-4 py-4"
            style={{
              background: 'color-mix(in srgb, var(--card-bg) 92%, transparent)',
              border: '1px solid color-mix(in srgb, var(--sophia-purple) 18%, transparent)',
              boxShadow: '0 0 30px color-mix(in srgb, var(--sophia-purple) 12%, transparent)',
            }}
          >
            <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1">
              {approvedMemories.map((memory) => (
                <div
                  key={memory.id}
                  className="rounded-xl px-3 py-2.5"
                  style={{
                    background: 'color-mix(in srgb, var(--sophia-purple) 4%, var(--card-bg))',
                    border: '1px solid color-mix(in srgb, var(--sophia-purple) 12%, transparent)',
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm leading-relaxed text-sophia-text/85">{memory.text}</p>
                    {memory.isEdited && (
                      <span
                        className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em]"
                        style={{
                          background: 'color-mix(in srgb, var(--sophia-glow) 10%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--sophia-glow) 22%, transparent)',
                          color: 'var(--sophia-text2)',
                        }}
                      >
                        Refined
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <ReflectionPrompt prompt={reflectionPrompt} onReflect={onReflect} />
      </div>
    </div>
  );
}
