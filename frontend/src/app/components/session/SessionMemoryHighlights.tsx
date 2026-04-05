/**
 * Session Memory Highlights
 * Sprint 1+ Phase 3
 * 
 * Compact memory highlights display for use in session chat.
 * Shows after the greeting message to provide context.
 * 
 * Uses the new MemoryHighlight format from Sessions API:
 * - text (not content)
 * - recency_label (optional)
 * - category (optional)
 */

'use client';

import { cn } from '../../lib/utils';
import type { MemoryHighlight } from '../../types/session';

// =============================================================================
// TYPES
// =============================================================================

interface SessionMemoryHighlightsProps {
  /** Memory highlights from session start API */
  highlights: MemoryHighlight[];
  /** Maximum highlights to show (default 3) */
  maxDisplay?: number;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// CATEGORY STYLING
// =============================================================================

const CATEGORY_CONFIG: Record<string, { emoji: string; color: string }> = {
  episodic: { emoji: '📅', color: 'text-blue-400' },
  emotional: { emoji: '💜', color: 'text-purple-400' },
  reflective: { emoji: '✨', color: 'text-amber-400' },
  default: { emoji: '💭', color: 'text-sophia-text2' },
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function SessionMemoryHighlights({
  highlights,
  maxDisplay = 3,
  className,
}: SessionMemoryHighlightsProps) {
  if (!highlights || highlights.length === 0) {
    return null;
  }
  
  const displayHighlights = highlights.slice(0, maxDisplay);
  
  return (
    <div className={cn(
      'session-memory-highlights',
      'px-3 py-2 rounded-xl mb-3',
      'bg-sophia-surface/40 border border-sophia-surface-border/50',
      'animate-fadeIn',
      className
    )}>
      {/* Header */}
      <p className="text-xs text-sophia-text2/80 mb-2 flex items-center gap-1">
        <span>💭</span>
        <span className="font-medium">Since last time...</span>
      </p>
      
      {/* Highlights */}
      <div className="space-y-1.5">
        {displayHighlights.map((highlight) => (
          <MemoryHighlightItem 
            key={highlight.id} 
            highlight={highlight} 
          />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// HIGHLIGHT ITEM
// =============================================================================

interface MemoryHighlightItemProps {
  highlight: MemoryHighlight;
}

function MemoryHighlightItem({ highlight }: MemoryHighlightItemProps) {
  const category = highlight.category || 'default';
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.default;
  
  return (
    <div className="flex items-start gap-2">
      {/* Category indicator */}
      <span className={cn('text-xs mt-0.5', config.color)} aria-hidden>
        {config.emoji}
      </span>
      
      {/* Text content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-sophia-text/80 line-clamp-2">
          {highlight.text}
        </p>
        
        {/* Recency label */}
        {highlight.recency_label && (
          <span className="text-xs text-sophia-text2/60 mt-0.5">
            {highlight.recency_label}
          </span>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// COMPACT VARIANT (for inline use)
// =============================================================================

interface CompactMemoryHighlightProps {
  highlight: MemoryHighlight;
  className?: string;
}

export function CompactSessionMemoryHighlight({ highlight, className }: CompactMemoryHighlightProps) {
  const category = highlight.category || 'default';
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.default;
  
  return (
    <div className={cn('flex items-start gap-2 text-xs', className)}>
      <span className={config.color}>{config.emoji}</span>
      <span className="text-sophia-text/80 line-clamp-1">{highlight.text}</span>
    </div>
  );
}

export default SessionMemoryHighlights;
