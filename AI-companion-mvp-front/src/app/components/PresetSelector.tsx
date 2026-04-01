/**
 * PresetSelector Component
 * Sprint 1 - Week 1
 * 
 * Dashboard component for selecting ritual type and context mode
 * 3x3 matrix: 3 rituals (prepare, debrief, reset) × 3 contexts (gaming, work, life)
 * 
 * Design Goals:
 * - Captivate gamers with dynamic animations
 * - Professional feel for work context
 * - Satisfying microinteractions throughout
 * - Clear affordance and accessibility (AA contrast)
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Check } from 'lucide-react';
import { useSupabase } from '../providers';
import { useSessionStart } from '../hooks/useSessionStart';
import { useSessionStore } from '../stores/session-store';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { logger } from '../lib/error-logger';
import { debugLog } from '../lib/debug-logger';
import type { PresetType, ContextMode, PresetConfig, ContextModeConfig } from '../lib/session-types';

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

const PRESETS: PresetConfig[] = [
  {
    type: 'prepare',
    icon: '🎯',
    labels: {
      gaming: {
        title: 'Pre-game',
        description: 'Lock intention + focus before gaming',
      },
      work: {
        title: 'Pre-work',
        description: 'Set intention for focused work',
      },
      life: {
        title: 'Prepare',
        description: 'Get ready for what matters',
      },
    },
  },
  {
    type: 'debrief',
    icon: '💬',
    labels: {
      gaming: {
        title: 'Post-game',
        description: 'Process emotions + extract lessons',
      },
      work: {
        title: 'Post-work',
        description: 'Reflect on what happened',
      },
      life: {
        title: 'Debrief',
        description: 'Talk through what happened',
      },
    },
  },
  {
    type: 'reset',
    icon: '🔄',
    labels: {
      gaming: {
        title: 'Tilt Reset',
        description: '30-90 second mental reset',
      },
      work: {
        title: 'Stress Reset',
        description: 'Quick reset when overwhelmed',
      },
      life: {
        title: 'Reset',
        description: 'Ground yourself and refocus',
      },
    },
  },
  {
    type: 'vent',
    icon: '🌀',
    labels: {
      gaming: {
        title: 'Tilt Vent',
        description: 'Let it out and find your calm',
      },
      work: {
        title: 'Stress Vent',
        description: 'Release frustration and reset',
      },
      life: {
        title: 'Vent',
        description: 'Express freely and decompress',
      },
    },
  },
];

const CONTEXT_MODES: ContextModeConfig[] = [
  { value: 'gaming', label: 'Gaming', emoji: '🎮' },
  { value: 'work', label: 'Work', emoji: '💼' },
  { value: 'life', label: 'Life', emoji: '🌟' },
];

// Stagger delays for card animations
const STAGGER_DELAYS = ['delay-[0ms]', 'delay-[75ms]', 'delay-[150ms]', 'delay-[225ms]'];

// ============================================================================
// PRESET CARD COMPONENT
// ============================================================================

interface PresetCardProps {
  preset: PresetConfig;
  contextMode: ContextMode;
  isSelected: boolean;
  onSelect: () => void;
  index: number;
  isVisible: boolean;
}

function PresetCard({ preset, contextMode, isSelected, onSelect, index, isVisible }: PresetCardProps) {
  const label = preset.labels[contextMode];
  const [isHovered, setIsHovered] = useState(false);
  const [justSelected, setJustSelected] = useState(false);
  
  const handleClick = () => {
    haptic('light');
    setJustSelected(true);
    onSelect();
    
    // Reset animation state
    setTimeout(() => setJustSelected(false), 300);
  };
  
  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-pressed={isSelected}
      className={cn(
        // Base styles - min-h to prevent resize on context switch
        'relative p-7 rounded-2xl border-2 text-left group min-h-[180px]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2 focus-visible:ring-offset-sophia-bg',
        // Consistent transition - no variation by context to prevent layout shift
        'transition-all duration-200',
        // Animation entry
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
        STAGGER_DELAYS[index],
        // Clear state differentiation - NO SCALE to prevent layout shift
        isSelected
          ? 'border-sophia-purple/50 bg-sophia-bubble shadow-xl -translate-y-1'
          : 'border-sophia-surface-border bg-sophia-surface hover:border-sophia-purple/40 hover:bg-sophia-button-hover hover:shadow-lg hover:-translate-y-1',
        // Glow effect when selected
        isSelected && 'shadow-[0_0_40px_rgba(139,92,246,0.35)]'
      )}
      style={{
        transitionDelay: isVisible ? `${index * 100}ms` : '0ms',
      }}
    >
      {/* FIX #4: Clear selection indicator with checkmark */}
      <div className={cn(
        'absolute top-4 right-4 w-6 h-6 rounded-full transition-all duration-300 flex items-center justify-center',
        isSelected 
          ? 'bg-sophia-purple scale-100 opacity-100' 
          : 'bg-sophia-surface-border scale-90 opacity-0 group-hover:opacity-50 group-hover:scale-100'
      )}>
        {isSelected ? (
          <Check className="w-4 h-4 text-sophia-bg" />
        ) : null}
        {isSelected && (
          <span className="absolute inset-0 rounded-full bg-sophia-purple animate-ping opacity-40" />
        )}
      </div>
      
      {/* Emoji badge - ALL neutral base, consistent system */}
      <div className={cn(
        'mb-4 w-14 h-14 rounded-xl flex items-center justify-center text-3xl transition-all duration-200',
        // Consistent neutral base for ALL cards - theme-aware
        'bg-sophia-surface-border/30 border border-sophia-surface-border',
        // Selected state - subtle purple tint
        isSelected && 'bg-sophia-purple/10 border-sophia-purple/30',
        // Hover - consistent scale
        isHovered && !isSelected && 'scale-105 bg-sophia-surface-border/50',
        justSelected && 'scale-110'
      )}>
        {preset.icon}
      </div>
      
      {/* Title with gradient when selected */}
      <h3 className={cn(
        'text-xl font-bold mb-2 transition-colors duration-300',
        isSelected 
          ? 'text-sophia-purple' 
          : 'text-sophia-text group-hover:text-sophia-purple/80'
      )}>
        {label.title}
      </h3>
      
      {/* Description - FIX B: Better typography */}
      <p className="text-sm text-sophia-text2 leading-relaxed mt-1">
        {label.description}
      </p>
      
      {/* Subtle shimmer effect on hover */}
      {isHovered && !isSelected && (
        <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-sophia-purple/5 to-transparent animate-shimmer" />
        </div>
      )}
    </button>
  );
}

// ============================================================================
// CONTEXT MODE PILL COMPONENT
// ============================================================================

interface ContextPillProps {
  mode: ContextModeConfig;
  isActive: boolean;
  onClick: () => void;
}

function ContextPill({ mode, isActive, onClick }: ContextPillProps) {
  return (
    <button
      onClick={() => {
        haptic('light');
        onClick();
      }}
      aria-pressed={isActive}
      className={cn(
        // Use border-2 for both states to prevent layout shift
        'relative px-5 py-2.5 rounded-full transition-all duration-300 font-semibold border-2',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2',
        isActive
          ? 'bg-sophia-purple/20 text-sophia-purple shadow-lg border-sophia-purple/30'
          : 'bg-sophia-surface text-sophia-text2 hover:bg-sophia-button-hover hover:text-sophia-text border-transparent hover:border-sophia-purple/30'
      )}
    >
      {/* Animated emoji */}
      <span className={cn(
        'inline-block mr-2 transition-transform duration-300',
        isActive ? 'scale-110' : 'group-hover:scale-105'
      )}>
        {mode.emoji}
      </span>
      {mode.label}
      
      {/* Active glow - subtle */}
      {isActive && (
        <span className="absolute inset-0 rounded-full bg-sophia-purple/20 blur-lg -z-10" />
      )}
    </button>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function PresetSelector() {
  const router = useRouter();
  const { user, loading: userLoading } = useSupabase();
  
  // Check if there's an active session
  const isSessionActive = useSessionStore((state) => state.isSessionActive);
  
  // Use the session start hook that calls backend API
  const { startSessionEntry, isLoading: _isSessionStarting } = useSessionStart({
    navigateOnSuccess: true,
    onSuccess: (result) => {
      debugLog('PresetSelector', 'Session started successfully', { sessionId: result.sessionId });
    },
    onError: (error) => {
      logger.logError(error, { component: 'PresetSelector', action: 'start_session_on_error' });
      setIsStarting(false);
    },
  });
  
  // FIX #1: Pre-select first ritual by default - don't make user start from zero
  const [selectedPreset, setSelectedPreset] = useState<PresetType>('prepare');
  const [contextMode, setContextMode] = useState<ContextMode>('gaming');
  const [isStarting, setIsStarting] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [contextChanging, setContextChanging] = useState(false);
  
  // Trigger entrance animation on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);
  
  // Handle context mode change with animation
  const handleContextChange = (newMode: ContextMode) => {
    if (newMode === contextMode) return;
    
    setContextChanging(true);
    haptic('light');
    
    // Brief delay for exit animation
    setTimeout(() => {
      setContextMode(newMode);
      setContextChanging(false);
    }, 150);
  };
  
  const handleStartSession = async () => {
    if (!selectedPreset || !user) return;
    
    haptic('medium');
    setIsStarting(true);
    
    try {
      // Call backend API via useSessionStart hook
      // This creates local session + calls POST /sessions/start
      // and updates the store with real backend session_id and thread_id
      const result = await startSessionEntry({
        userId: user.id,
        preset: selectedPreset,
        contextMode,
      });
      
      if (result.success) {
        debugLog('PresetSelector', 'Session started', { sessionId: result.sessionId });
        // Navigation handled by hook (navigateOnSuccess: true)
      } else {
        const errorMessage = 'error' in result && typeof result.error === 'string' ? result.error : 'Unknown error';
        logger.logError(new Error(errorMessage), { component: 'PresetSelector', action: 'start_session_failed' });
        // Still navigates in offline mode (handled by hook)
      }
    } catch (error) {
      logger.logError(error, { component: 'PresetSelector', action: 'start_session' });
      setIsStarting(false);
    }
  };

  const isReady = selectedPreset && user && !userLoading;
  
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-10">
      {/* Header with fade-in */}
      <div className={cn(
        'text-center transition-all duration-500',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
      )}>
        <h1 className="text-3xl font-bold mb-3 text-sophia-text">
          Choose Your Ritual
        </h1>
        <p className="text-sophia-text2 text-lg">
          What would you like to focus on today?
        </p>
      </div>
      
      {/* Context Mode Selector with stagger */}
      <div className={cn(
        'flex justify-center gap-3 transition-all duration-500 delay-100',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      )}>
        {CONTEXT_MODES.map((mode) => (
          <ContextPill
            key={mode.value}
            mode={mode}
            isActive={contextMode === mode.value}
            onClick={() => handleContextChange(mode.value)}
          />
        ))}
      </div>
      
      {/* Continue Session Button - shows if active session exists */}
      {isSessionActive() && (
        <div className={cn(
          'flex justify-center transition-all duration-500',
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        )}>
          <button
            onClick={() => {
              haptic('medium');
              router.push('/session');
            }}
            className={cn(
              'px-8 py-3 rounded-2xl font-semibold transition-all duration-300 flex items-center gap-3',
              'bg-sophia-purple/20 border-2 border-sophia-purple/50 text-sophia-purple',
              'hover:bg-sophia-purple/30 hover:border-sophia-purple/70 hover:shadow-lg hover:-translate-y-0.5',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2'
            )}
          >
            <span className="text-lg">↩</span>
            Continue Last Session
          </button>
        </div>
      )}
      
      {/* Step indicator - helper line, not content */}
      <div className={cn(
        'flex items-center justify-center gap-1.5 text-xs transition-all duration-500',
        isVisible ? 'opacity-60' : 'opacity-0'
      )}>
        <span className="text-sophia-text2/60">Context</span>
        <span className="text-sophia-text2/40">→</span>
        <span className="text-sophia-purple/80">Ritual</span>
        <span className="text-sophia-text2/40">→</span>
        <span className="text-sophia-text2/60">Start</span>
      </div>
      
      {/* Preset Cards Grid - 2x2 grid for 4 cards */}
      <div className={cn(
        'grid grid-cols-1 sm:grid-cols-2 gap-5 transition-opacity duration-200',
        'md:min-h-[400px]', // Prevent container resize on context switch
        contextChanging ? 'opacity-50' : 'opacity-100'
      )}>
        {PRESETS.map((preset, index) => (
          <PresetCard
            key={preset.type}
            preset={preset}
            contextMode={contextMode}
            isSelected={selectedPreset === preset.type}
            onSelect={() => setSelectedPreset(preset.type)}
            index={index}
            isVisible={isVisible}
          />
        ))}
      </div>
      
      {/* FIX #5 & #6: Primary CTA + link alternative */}
      <div className={cn(
        'flex flex-col items-center gap-4 transition-all duration-500 delay-300',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      )}>
        {/* Primary CTA */}
        <button
          onClick={() => {
            if (!user && !userLoading) {
              router.push('/auth');
            } else {
              handleStartSession();
            }
          }}
          disabled={isStarting || (!selectedPreset && !!user)}
          className={cn(
            'relative px-10 py-4 rounded-2xl text-lg font-semibold transition-all duration-300 flex items-center gap-3 overflow-hidden',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-offset-2',
            (isReady || !user)
              ? 'bg-sophia-purple text-white shadow-lg hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:scale-95'
              : 'bg-sophia-purple/10 text-sophia-text2 border border-sophia-purple/30 hover:bg-sophia-purple/20'
          )}
        >
          {/* Animated background gradient when ready */}
          {(isReady || !user) && !isStarting && (
            <span className="absolute inset-0 bg-gradient-to-r from-sophia-purple via-sophia-glow to-sophia-purple bg-[length:200%_100%] animate-shimmer opacity-40" />
          )}
          
          {/* Content */}
          <span className="relative flex items-center gap-3">
            {isStarting ? (
              <>
                <span className="w-5 h-5 border-2 border-sophia-bg/30 border-t-sophia-bg rounded-full animate-spin" />
                Starting...
              </>
            ) : !user && !userLoading ? (
              <>
                Sign in to Start
                <span className="text-xl">→</span>
              </>
            ) : (
              <>
                <Sparkles className={cn(
                  'w-5 h-5 transition-transform duration-300',
                  isReady && 'animate-pulse'
                )} />
                Start Session
                <span className="text-xl">→</span>
              </>
            )}
          </span>
        </button>
      </div>
      
    </div>
  );
}

export default PresetSelector;
