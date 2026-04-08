/**
 * Memory Highlight Card
 * Session Bootstrap — "Sophia is present instantly"
 * 
 * One unified card groups all recalled memories. Compact,
 * cohesive, content-fitted. The card breathes gently once
 * it has appeared — alive but not distracting.
 */

'use client';

import { memo, useState, useEffect } from 'react';

import { cn } from '../../lib/utils';
import type { MemoryHighlight } from '../../types/session';

// =============================================================================
// TYPES
// =============================================================================

export interface MemoryHighlightCardProps {
  highlight: MemoryHighlight;
  index?: number;
  className?: string;
  interactive?: boolean;
  onClick?: (memory: MemoryHighlight) => void;
}

interface MemoryHighlightCardsProps {
  highlights: MemoryHighlight[];
  maxDisplay?: number;
  className?: string;
  onMemoryClick?: (memory: MemoryHighlight) => void;
}

// =============================================================================
// SINGLE MEMORY ROW (internal, used inside the grouped card)
// =============================================================================

const MemoryRow = memo(function MemoryRow({
  highlight,
  index = 0,
  interactive = false,
  onClick,
}: {
  highlight: MemoryHighlight;
  index?: number;
  interactive?: boolean;
  onClick?: (memory: MemoryHighlight) => void;
}) {
  const [visible, setVisible] = useState(false);
  const delay = index * 120 + 300; // stagger after card appears
  
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive && onClick ? () => onClick(highlight) : undefined}
      onKeyDown={
        interactive && onClick
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(highlight); }
          : undefined
      }
      className={cn(
        'flex items-start gap-2.5 transition-all duration-500',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
        interactive && 'cursor-pointer hover:text-sophia-text active:opacity-70',
      )}
      data-memory-id={highlight.id}
    >
      {/* Accent dot — pulses once on entry, then rests */}
      <div 
        className={cn(
          'flex-shrink-0 w-1.5 h-1.5 rounded-full mt-[7px] transition-all',
          visible && 'animate-memory-dot-pulse'
        )}
        style={{ 
          background: 'var(--sophia-purple)', 
          opacity: visible ? 0.55 : 0,
          animationDelay: `${delay + 100}ms`,
        }}
        aria-hidden="true"
      />
      
      {/* Text */}
      <p className="text-[13px] leading-relaxed text-sophia-text/75 line-clamp-2">
        {highlight.text}
      </p>
    </div>
  );
});

// =============================================================================
// GROUPED MEMORY CARD
// =============================================================================

export function MemoryHighlightCards({
  highlights,
  maxDisplay = 3,
  className,
  onMemoryClick,
}: MemoryHighlightCardsProps) {
  const [hasEntered, setHasEntered] = useState(false);
  const [headerText, setHeaderText] = useState('');
  const fullText = 'Sophia remembers\u2026';
  
  // Typewriter header
  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setHeaderText(fullText.slice(0, i));
      if (i >= fullText.length) clearInterval(interval);
    }, 35);
    return () => clearInterval(interval);
  }, []);
  
  // Enable breathing after entrance
  useEffect(() => {
    const timer = setTimeout(() => setHasEntered(true), 800);
    return () => clearTimeout(timer);
  }, []);
  
  if (!highlights || highlights.length === 0) return null;
  
  const displayHighlights = highlights.slice(0, maxDisplay);
  
  return (
    <div
      className={cn(
        'w-fit max-w-sm',
        // Entrance
        'opacity-0 animate-memory-surface',
        // Breathing after entrance
        hasEntered && 'animate-memory-breathe',
        className
      )}
      data-onboarding="memory-highlight"
      role="region"
      aria-label="Sophia remembers..."
    >
      {/* Ambient glow — card casts soft purple light */}
      <div 
        className={cn(
          'absolute -inset-3 rounded-3xl pointer-events-none transition-opacity duration-1000',
          hasEntered ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          background: 'radial-gradient(ellipse at 50% 50%, color-mix(in srgb, var(--sophia-purple) 6%, transparent), transparent 70%)',
          filter: 'blur(12px)',
        }}
        aria-hidden="true"
      />
      
      <div 
        className="relative rounded-2xl px-4 py-3 overflow-hidden"
        style={{
          background: 'color-mix(in srgb, var(--sophia-purple) 5%, var(--card-bg))',
          border: '1px solid color-mix(in srgb, var(--sophia-purple) 14%, transparent)',
        }}
      >
        {/* Top accent line — thin purple gradient */}
        <div 
          className="absolute top-0 left-3 right-3 h-px pointer-events-none"
          style={{
            background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--sophia-purple) 25%, transparent), transparent)',
          }}
          aria-hidden="true"
        />
        
        {/* Shimmer sweep on entrance */}
        <div 
          className="absolute inset-0 pointer-events-none animate-memory-shimmer"
          style={{ 
            animationDelay: '600ms',
            background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--sophia-purple) 6%, transparent), transparent)',
          }}
          aria-hidden="true"
        />
        
        {/* Header */}
        <p className="text-[11px] text-sophia-text2/45 font-medium flex items-center gap-1.5 mb-2.5">
          <span className="text-sophia-purple/50">{'\u2726'}</span>
          <span>{headerText}</span>
          {headerText.length < fullText.length && (
            <span className="text-sophia-purple/60 animate-typewriter-cursor">|</span>
          )}
        </p>
        
        {/* Memory rows */}
        <div className="space-y-2">
          {displayHighlights.map((highlight, index) => (
            <MemoryRow
              key={highlight.id}
              highlight={highlight}
              index={index}
              interactive={!!onMemoryClick}
              onClick={onMemoryClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// LEGACY EXPORTS (keep API compatibility)
// =============================================================================

export const MemoryHighlightCard = memo(function MemoryHighlightCard({
  highlight,
  index: _index = 0,
  className,
  interactive = false,
  onClick,
}: MemoryHighlightCardProps) {
  return (
    <MemoryHighlightCards
      highlights={[highlight]}
      maxDisplay={1}
      className={className}
      onMemoryClick={interactive ? onClick : undefined}
    />
  );
});

export interface CompactMemoryCardProps {
  highlight: MemoryHighlight;
  className?: string;
}

export function CompactMemoryCard({ highlight, className }: CompactMemoryCardProps) {
  return (
    <div 
      className={cn(
        'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs',
        className
      )}
      style={{
        background: 'color-mix(in srgb, var(--sophia-purple) 6%, var(--card-bg))',
        border: '1px solid color-mix(in srgb, var(--sophia-purple) 15%, transparent)',
      }}
      data-memory-id={highlight.id}
    >
      <span className="w-1 h-1 rounded-full bg-sophia-purple/50" aria-hidden="true" />
      <span className="text-sophia-text/80 line-clamp-1 max-w-[200px]">
        {highlight.text}
      </span>
    </div>
  );
}

export default MemoryHighlightCards;
