/**
 * useIdleTimeout Hook
 * Unit 7+
 *
 * Fires after 10 minutes of no user interaction (touch, keypress, mouse movement).
 * Returns { isIdle, resetIdle } so the parent can show a whisper overlay and dismiss it.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'pointermove',
  'keydown',
  'scroll',
  'touchstart',
];

interface UseIdleTimeoutOptions {
  enabled?: boolean;
  timeoutMs?: number;
}

export function useIdleTimeout({
  enabled = true,
  timeoutMs = IDLE_TIMEOUT_MS,
}: UseIdleTimeoutOptions = {}) {
  const [isIdle, setIsIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setIsIdle(true);
    }, timeoutMs);
  }, [clearTimer, timeoutMs]);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
    startTimer();
  }, [startTimer]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      setIsIdle(false);
      return;
    }

    startTimer();

    const handleActivity = () => {
      if (!isIdle) {
        // Only restart timer if not already in idle state —
        // once idle, require explicit resetIdle() from parent
        startTimer();
      }
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    return () => {
      clearTimer();
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, handleActivity);
      }
    };
  }, [enabled, clearTimer, startTimer, isIdle]);

  return { isIdle, resetIdle };
}
