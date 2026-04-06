/**
 * useMicroBriefing Hook
 * Sprint 1+ Phase 3
 * 
 * Provides micro-briefing functionality for:
 * - Timer-based check-ins during session
 * - Quick resets when user requests
 * - Reflection prompts
 * - Inactivity nudges
 * 
 * This hook connects to POST /api/v1/sessions/micro-briefing
 * and returns lightweight, fast responses (no LLM latency).
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

import { getMicroBriefing, isSuccess } from '../lib/api/sessions-api';
import type { 
  MicroBriefingIntent, 
  MemoryHighlight,
  ContextMode,
  PresetType,
} from '../types/session';

// ============================================================================
// TYPES
// ============================================================================

export interface MicroBriefingResult {
  messageId: string;
  text: string;
  highlights: MemoryHighlight[];
  hasMemory: boolean;
}

export interface UseMicroBriefingOptions {
  /** Preset context for the session */
  presetContext: ContextMode;
  /** Session type (optional) */
  sessionType?: PresetType;
  /** Auto-nudge interval in minutes (0 = disabled) */
  autoNudgeIntervalMinutes?: number;
  /** Callback when nudge is triggered */
  onNudge?: (result: MicroBriefingResult) => void;
}

export interface UseMicroBriefingReturn {
  // State
  isLoading: boolean;
  lastResult: MicroBriefingResult | null;
  error: string | null;
  
  // Actions
  /** Trigger a check-in prompt */
  triggerCheckIn: () => Promise<MicroBriefingResult | null>;
  /** Trigger a quick reset prompt */
  triggerQuickReset: () => Promise<MicroBriefingResult | null>;
  /** Trigger a reflection prompt */
  triggerReflection: () => Promise<MicroBriefingResult | null>;
  /** Trigger an inactivity nudge */
  triggerNudge: () => Promise<MicroBriefingResult | null>;
  /** Generic trigger with custom intent */
  trigger: (intent: MicroBriefingIntent) => Promise<MicroBriefingResult | null>;
  /** Clear the last result */
  clearResult: () => void;
  /** Reset the auto-nudge timer */
  resetTimer: () => void;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useMicroBriefing(options: UseMicroBriefingOptions): UseMicroBriefingReturn {
  const { 
    presetContext, 
    sessionType,
    autoNudgeIntervalMinutes = 0,
    onNudge,
  } = options;
  
  const [isLoading, setIsLoading] = useState(false);
  const [lastResult, setLastResult] = useState<MicroBriefingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Timer ref for auto-nudge
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  
  /**
   * Core trigger function
   */
  const trigger = useCallback(async (
    intent: MicroBriefingIntent
  ): Promise<MicroBriefingResult | null> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await getMicroBriefing({
        intent,
        preset_context: presetContext,
        session_type: sessionType,
      });
      
      if (!isSuccess(result)) {
        setError(result.error);
        return null;
      }
      
      const response = result.data;
      const briefingResult: MicroBriefingResult = {
        messageId: response.message_id,
        text: response.assistant_text,
        highlights: response.highlights,
        hasMemory: response.has_memory,
      };
      
      setLastResult(briefingResult);
      return briefingResult;
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [presetContext, sessionType]);
  
  /**
   * Convenience methods for specific intents
   */
  const triggerCheckIn = useCallback(async () => {
    return trigger('interrupt_checkin');
  }, [trigger]);
  
  const triggerQuickReset = useCallback(async () => {
    return trigger('quick_reset');
  }, [trigger]);
  
  const triggerReflection = useCallback(async () => {
    return trigger('reflection_prompt');
  }, [trigger]);
  
  const triggerNudge = useCallback(async () => {
    const result = await trigger('nudge');
    if (result) {
      onNudge?.(result);
    }
    return result;
  }, [trigger, onNudge]);
  
  /**
   * Clear last result
   */
  const clearResult = useCallback(() => {
    setLastResult(null);
    setError(null);
  }, []);
  
  /**
   * Reset auto-nudge timer
   */
  const resetTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    
    if (autoNudgeIntervalMinutes > 0) {
      const intervalMs = autoNudgeIntervalMinutes * 60 * 1000;
      timerRef.current = setInterval(() => {
        void triggerNudge();
      }, intervalMs);
    }
  }, [autoNudgeIntervalMinutes, triggerNudge]);
  
  /**
   * Setup auto-nudge timer
   */
  useEffect(() => {
    if (autoNudgeIntervalMinutes > 0) {
      resetTimer();
    }
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [autoNudgeIntervalMinutes, resetTimer]);
  
  return {
    isLoading,
    lastResult,
    error,
    triggerCheckIn,
    triggerQuickReset,
    triggerReflection,
    triggerNudge,
    trigger,
    clearResult,
    resetTimer,
  };
}

export default useMicroBriefing;
