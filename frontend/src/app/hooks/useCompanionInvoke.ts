/**
 * useCompanionInvoke Hook
 * Phase 3 - Subphase 3.3
 * 
 * Custom hook for companion invoke functionality.
 * Provides Quick Question, Plan Reminder, Tilt Reset, Micro Debrief.
 */

import { useState, useCallback } from 'react';

import { logger } from '../lib/error-logger';
import type { 
  InvokeType, 
  CompanionInvokeRequest, 
  CompanionInvokeResponse 
} from '../lib/session-types';
import { isUuid } from '../lib/utils';
import { useSessionStore } from '../stores/session-store';

interface UseCompanionInvokeOptions {
  threadId?: string;
  onSuccess?: (response: CompanionInvokeResponse) => void;
  onError?: (error: Error) => void;
}

interface UseCompanionInvokeReturn {
  /** Last successful response */
  response: CompanionInvokeResponse | null;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Invoke a companion action */
  invoke: (invokeType: InvokeType, transcript: string) => Promise<CompanionInvokeResponse | null>;
  /** Clear state */
  reset: () => void;
}

/**
 * Hook for invoking companion actions during a session
 * 
 * @example
 * const { invoke, isLoading } = useCompanionInvoke({
 *   threadId: session?.threadId,
 *   onSuccess: (res) => addMessage(res.message),
 * });
 * 
 * // User clicks "Quick Question"
 * await invoke('quick_question', currentTranscript);
 */
export function useCompanionInvoke(
  options: UseCompanionInvokeOptions = {}
): UseCompanionInvokeReturn {
  const [response, setResponse] = useState<CompanionInvokeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  const incrementCompanionInvokes = useSessionStore(
    (state) => state.incrementCompanionInvokes
  );
  const getSessionContext = useSessionStore(
    (state) => state.getSessionContext
  );
  
  const invoke = useCallback(async (
    invokeType: InvokeType,
    transcript: string
  ): Promise<CompanionInvokeResponse | null> => {
    setIsLoading(true);
    setError(null);
    setResponse(null);
    
    try {
      const sessionContext = getSessionContext();
      
      const safeThreadId = isUuid(options.threadId) ? options.threadId : undefined;
      const request: CompanionInvokeRequest = {
        invoke_type: invokeType,
        transcript,
        thread_id: safeThreadId,
        session_context: sessionContext || undefined,
      };
      
      // Call API — auth handled server-side by proxy (httpOnly cookie)
      const res = await fetch('/api/companion/invoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Companion invoke failed: ${res.status}`);
      }
      
      const result: CompanionInvokeResponse = await res.json();
      
      setResponse(result);
      
      // Track invoke count in session store
      incrementCompanionInvokes(invokeType);
      
      // Callback
      options.onSuccess?.(result);
      
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      options.onError?.(error);
      logger.logError(error, {
        component: 'useCompanionInvoke',
        action: 'invoke',
      });
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [options, incrementCompanionInvokes, getSessionContext]);
  
  const reset = useCallback(() => {
    setResponse(null);
    setError(null);
    setIsLoading(false);
  }, []);
  
  return {
    response,
    isLoading,
    error,
    invoke,
    reset,
  };
}

export default useCompanionInvoke;
