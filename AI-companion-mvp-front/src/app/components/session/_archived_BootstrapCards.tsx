/**
 * Bootstrap Cards Container
 * Sprint 1+ - Wrapper component that renders session bootstrap data
 * 
 * Displays:
 * - Memory highlights ("Since last time...")
 * - Emotional weather indicator
 * - Suggested ritual CTA
 * 
 * Positioned at the start of session before first user message.
 */

'use client';

import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { MemoryHighlights } from './MemoryHighlights';
import { WeatherBadge } from './EmotionalWeather';
import type { BootstrapResponse } from '../../types/sophia-ui-message';
import type { PresetType } from '../../lib/session-types';

type BootstrapFetchParams = {
  userId: string;
  sessionType?: 'prepare' | 'debrief' | 'reset' | 'vent' | 'free_session';
  contextMode?: 'gaming' | 'work' | 'life';
  signal?: AbortSignal;
};

type BootstrapFetchResult =
  | { success: true; data: BootstrapResponse }
  | { success: false; error: string };

async function fetchSessionBootstrap(_params: BootstrapFetchParams): Promise<BootstrapFetchResult> {
  return { success: false, error: 'Session bootstrap API removed' };
}

function hasMemories(bootstrap: BootstrapResponse): boolean {
  return Array.isArray(bootstrap.top_memories) && bootstrap.top_memories.length > 0;
}

function shouldShowWeather(bootstrap: BootstrapResponse): boolean {
  return !!bootstrap.emotional_weather;
}

// =============================================================================
// TYPES
// =============================================================================

interface BootstrapCardsProps {
  /** User ID for fetching bootstrap */
  userId: string;
  /** Session type (affects personalization) */
  sessionType?: 'prepare' | 'debrief' | 'reset' | 'vent' | 'free_session';
  /** Context mode (affects personalization) */
  contextMode?: 'gaming' | 'work' | 'life';
  /** Pre-loaded bootstrap data (skips fetch if provided) */
  initialBootstrap?: BootstrapResponse;
  /** Callback when bootstrap loads */
  onBootstrapLoad?: (bootstrap: BootstrapResponse) => void;
  /** Callback when user selects a ritual */
  onRitualSelect?: (ritual: PresetType) => void;
  /** Additional CSS classes */
  className?: string;
}

interface LoadingState {
  isLoading: boolean;
  error: string | null;
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function BootstrapSkeleton() {
  return (
    <div className="space-y-2 p-3 rounded-xl bg-sophia-surface/30 border border-sophia-surface-border animate-pulse">
      {/* Memory skeleton */}
      <div className="flex items-start gap-2">
        <div className="w-4 h-4 rounded bg-sophia-surface-hover" />
        <div className="flex-1 space-y-1">
          <div className="h-3 w-24 bg-sophia-surface-hover rounded" />
          <div className="h-4 w-full bg-sophia-surface-hover rounded" />
        </div>
      </div>
      {/* Weather skeleton */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-sophia-surface-hover" />
        <div className="h-3 w-16 bg-sophia-surface-hover rounded" />
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function BootstrapCards({
  userId,
  sessionType,
  contextMode,
  initialBootstrap,
  onBootstrapLoad,
  onRitualSelect,
  className,
}: BootstrapCardsProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(
    initialBootstrap || null
  );
  const [loadingState, setLoadingState] = useState<LoadingState>({
    isLoading: !initialBootstrap,
    error: null,
  });
  
  // Fetch bootstrap on mount if not provided
  useEffect(() => {
    if (initialBootstrap) {
      return; // Already have data
    }
    
    const controller = new AbortController();
    
    async function loadBootstrap() {
      setLoadingState({ isLoading: true, error: null });
      
      const result = await fetchSessionBootstrap({
        userId,
        sessionType,
        contextMode,
        signal: controller.signal,
      });
      
      if (result.success) {
        setBootstrap(result.data);
        setLoadingState({ isLoading: false, error: null });
        onBootstrapLoad?.(result.data);
      } else {
        // Type narrowing: result is BootstrapError here
        const errorResult = result as { error: string };
        setLoadingState({ isLoading: false, error: errorResult.error });
      }
    }
    
    loadBootstrap();
    
    return () => {
      controller.abort();
    };
  }, [userId, sessionType, contextMode, initialBootstrap, onBootstrapLoad]);
  
  // Loading state
  if (loadingState.isLoading) {
    return <BootstrapSkeleton />;
  }
  
  // Error state (silent - don't block session)
  if (loadingState.error || !bootstrap) {
    return null;
  }
  
  // Check if there's anything worth showing
  const hasContent = hasMemories(bootstrap) || 
                     shouldShowWeather(bootstrap) || 
                     bootstrap.suggested_ritual;
  
  if (!hasContent) {
    return null;
  }
  
  return (
    <div 
      className={cn(
        'mb-4',
        'animate-fadeIn',
        className
      )}
    >
      {/* Single weather badge - compact */}
      {shouldShowWeather(bootstrap) && bootstrap.emotional_weather && (
        <WeatherBadge 
          weather={bootstrap.emotional_weather}
          showLabel={true}
        />
      )}
      
      {/* Memory highlights (only if we have memories) */}
      {hasMemories(bootstrap) && (
        <MemoryHighlights
          memories={bootstrap.top_memories}
          suggestedRitual={bootstrap.suggested_ritual}
          suggestionReason={bootstrap.suggestion_reason}
          onRitualSelect={onRitualSelect}
        />
      )}
    </div>
  );
}

// =============================================================================
// HOOK FOR EXTERNAL ACCESS
// =============================================================================

/**
 * Hook to fetch bootstrap data without rendering
 * Useful for pre-fetching or accessing data in parent components
 */
export function useBootstrap(
  userId: string,
  options?: {
    sessionType?: 'prepare' | 'debrief' | 'reset' | 'vent' | 'free_session';
    contextMode?: 'gaming' | 'work' | 'life';
    enabled?: boolean;
  }
) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    if (options?.enabled === false) {
      return;
    }
    
    const controller = new AbortController();
    
    async function load() {
      setIsLoading(true);
      setError(null);
      
      const result = await fetchSessionBootstrap({
        userId,
        sessionType: options?.sessionType,
        contextMode: options?.contextMode,
        signal: controller.signal,
      });
      
      if (result.success) {
        setBootstrap(result.data);
      } else {
        // Type narrowing
        const errorResult = result as { error: string };
        setError(errorResult.error);
      }
      
      setIsLoading(false);
    }
    
    load();
    
    return () => controller.abort();
  }, [userId, options?.sessionType, options?.contextMode, options?.enabled]);
  
  return { bootstrap, isLoading, error };
}

export default BootstrapCards;
