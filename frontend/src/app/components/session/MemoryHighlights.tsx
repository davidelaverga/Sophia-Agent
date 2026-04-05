/**
 * Memory Highlights
 * Sprint 1+ - Lean components fed by OpenMemory/Bootstrap outputs
 * 
 * Three compact components:
 * 1. "Since last time" - Recent memory snippet
 * 2. "Emotional weather" - Trend indicator
 * 3. "Suggested ritual" - CTA button
 * 
 * These are designed to be populated by bootstrap response
 * but can also be used standalone with mock data.
 */

'use client';

import { cn } from '../../lib/utils';
import type { PresetType } from '../../lib/session-types';
import type { EmotionalTrend, UICard, BootstrapResponse } from '../../types/sophia-ui-message';

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface MemoryHighlightsProps {
  /** Bootstrap response from backend */
  bootstrap?: BootstrapResponse;
  /** Direct cards (alternative to bootstrap) */
  cards?: UICard[];
  /** Memories to display */
  memories?: Array<{ content: string; category: string }>;
  /** Suggested ritual */
  suggestedRitual?: PresetType | null;
  /** Reason for suggestion */
  suggestionReason?: string | null;
  /** Emotional trend */
  emotionalTrend?: EmotionalTrend;
  /** Callback when user selects a ritual */
  onRitualSelect?: (ritual: PresetType) => void;
  /** Additional CSS classes */
  className?: string;
}

export function MemoryHighlights({
  bootstrap,
  cards,
  memories,
  suggestedRitual,
  suggestionReason,
  emotionalTrend,
  onRitualSelect,
  className,
}: MemoryHighlightsProps) {
  // Extract from bootstrap if provided
  const displayMemories = memories ?? bootstrap?.top_memories ?? [];
  const displayRitual = suggestedRitual ?? bootstrap?.suggested_ritual ?? null;
  const displayReason = suggestionReason ?? bootstrap?.suggestion_reason ?? null;
  const displayCards = cards ?? bootstrap?.ui_cards ?? [];
  const displayTrend = emotionalTrend ?? bootstrap?.emotional_weather?.trend ?? 'unknown';
  
  // Find emotional weather card if exists
  const emotionalCard = displayCards.find(c => c.type === 'emotional_weather');
  
  // If nothing to show, return null
  if (displayMemories.length === 0 && !displayRitual && !emotionalCard) {
    return null;
  }
  
  return (
    <div className={cn(
      'space-y-2 p-3 rounded-xl',
      'bg-sophia-surface/50 border border-sophia-surface-border',
      'animate-fadeIn',
      className
    )}>
      {/* Since Last Time */}
      {displayMemories.length > 0 && (
        <SinceLastTime memories={displayMemories} />
      )}
      
      {/* Emotional Weather */}
      {emotionalCard && (
        <EmotionalWeatherCard 
          trend={emotionalCard.trend as EmotionalTrend} 
          label={emotionalCard.label}
        />
      )}
      
      {/* Simple trend indicator if no full card */}
      {!emotionalCard && displayTrend !== 'unknown' && (
        <EmotionalWeatherCard trend={displayTrend} />
      )}
      
      {/* Suggested Ritual */}
      {displayRitual && (
        <SuggestedRitual
          ritual={displayRitual}
          reason={displayReason}
          onSelect={onRitualSelect}
        />
      )}
    </div>
  );
}

// =============================================================================
// SINCE LAST TIME
// =============================================================================

interface SinceLastTimeProps {
  memories: Array<{ content: string; category: string }>;
  maxDisplay?: number;
}

function SinceLastTime({ memories, maxDisplay = 2 }: SinceLastTimeProps) {
  const displayMemories = memories.slice(0, maxDisplay);
  
  return (
    <div className="since-last-time">
      <p className="text-xs text-sophia-text2 mb-1 flex items-center gap-1">
        <span>💭</span>
        <span className="font-medium">Since last time</span>
      </p>
      <div className="space-y-1">
        {displayMemories.map((memory, index) => (
          <p 
            key={index}
            className="text-sm text-sophia-text/80 line-clamp-2"
          >
            {memory.content.slice(0, 100)}{memory.content.length > 100 ? '...' : ''}
          </p>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// EMOTIONAL WEATHER CARD
// =============================================================================

interface EmotionalWeatherCardProps {
  trend: EmotionalTrend;
  label?: string;
}

function EmotionalWeatherCard({ trend, label }: EmotionalWeatherCardProps) {
  const trendConfig: Record<EmotionalTrend, { icon: string; color: string; defaultLabel: string }> = {
    improving: { icon: '↗️', color: 'text-green-500', defaultLabel: 'Things are looking up' },
    stable: { icon: '→', color: 'text-blue-400', defaultLabel: 'Holding steady' },
    declining: { icon: '↘️', color: 'text-orange-500', defaultLabel: 'Might be a tough stretch' },
    unknown: { icon: '🌤️', color: 'text-sophia-text2', defaultLabel: "Let's check in" },
  };
  
  const config = trendConfig[trend] || trendConfig.unknown;
  
  return (
    <div className="emotional-weather flex items-center gap-2 py-1">
      <span className={cn('text-base', config.color)} role="img" aria-label={trend}>
        {config.icon}
      </span>
      <span className="text-xs text-sophia-text2">
        {label || config.defaultLabel}
      </span>
    </div>
  );
}

// =============================================================================
// SUGGESTED RITUAL
// =============================================================================

interface SuggestedRitualProps {
  ritual: PresetType;
  reason?: string | null;
  onSelect?: (ritual: PresetType) => void;
}

const RITUAL_LABELS: Record<PresetType, string> = {
  prepare: 'Prepare',
  debrief: 'Debrief',
  reset: 'Reset',
  vent: 'Vent',
  open: 'Open Chat',
  chat: 'Chat',
};

const RITUAL_ICONS: Record<PresetType, string> = {
  prepare: '🎯',
  debrief: '📝',
  reset: '🔄',
  vent: '💨',
  open: '💬',
  chat: '💬',
};

function SuggestedRitual({ ritual, reason, onSelect }: SuggestedRitualProps) {
  return (
    <div className={cn(
      'suggested-ritual p-2 rounded-lg',
      'bg-sophia-purple/5 border border-sophia-purple/20',
      'flex items-center justify-between gap-3'
    )}>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-sophia-purple flex items-center gap-1">
          <span>{RITUAL_ICONS[ritual] || '💡'}</span>
          <span>Suggested: {RITUAL_LABELS[ritual] || ritual}</span>
        </p>
        {reason && (
          <p className="text-xs text-sophia-text2 mt-0.5 line-clamp-1">
            {reason}
          </p>
        )}
      </div>
      
      {onSelect && (
        <button
          onClick={() => onSelect(ritual)}
          className={cn(
            'shrink-0 px-3 py-1.5 rounded-md text-xs font-medium',
            'bg-sophia-purple text-white',
            'hover:bg-sophia-purple/90 active:scale-[0.98]',
            'transition-all duration-150',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
          )}
        >
          Start
        </button>
      )}
    </div>
  );
}

// =============================================================================
// COMPACT VARIANT (for inline use)
// =============================================================================

interface CompactMemoryHighlightProps {
  content: string;
  category?: string;
  className?: string;
}

export function CompactMemoryHighlight({ content, category: _category, className }: CompactMemoryHighlightProps) {
  return (
    <div className={cn(
      'flex items-start gap-2 text-xs',
      className
    )}>
      <span className="text-sophia-text2">💭</span>
      <span className="text-sophia-text/80 line-clamp-1">{content}</span>
    </div>
  );
}
