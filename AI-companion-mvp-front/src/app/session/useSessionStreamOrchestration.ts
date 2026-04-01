import { useCallback, useEffect, useRef } from 'react';
import type { InterruptPayload } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';
import type { StreamArtifactsPayload } from './stream-contract-adapters';
import { useSessionStreamContract } from './useSessionStreamContract';
import { debugLog } from '../lib/debug-logger';

type UseSessionStreamOrchestrationParams = {
  ingestArtifacts: (incoming: StreamArtifactsPayload, source: 'stream' | 'interrupt' | 'companion' | 'voice') => void;
  setCurrentContext: (threadId: string, sessionId: string, runId?: string) => void;
  setMessageMetadata: (messageId: string, metadata: Partial<SophiaMessageMetadata>) => void;
  sessionId: string;
  activeSessionId?: string;
  activeThreadId?: string;
  debugEnabled?: boolean;
};

export function useSessionStreamOrchestration({
  ingestArtifacts,
  setCurrentContext,
  setMessageMetadata,
  sessionId,
  activeSessionId,
  activeThreadId,
  debugEnabled = false,
}: UseSessionStreamOrchestrationParams) {
  const interruptSetterRef = useRef<(interrupt: InterruptPayload) => void>(() => undefined);

  const routeIncomingInterrupt = useCallback((interrupt: InterruptPayload) => {
    interruptSetterRef.current(interrupt);
  }, []);

  const setStreamInterruptHandler = useCallback((handler: (interrupt: InterruptPayload) => void) => {
    interruptSetterRef.current = handler;
  }, []);

  const {
    handleDataPart,
    handleFinish,
    markStreamTurnStarted,
  } = useSessionStreamContract({
    ingestArtifacts,
    setInterrupt: routeIncomingInterrupt,
    setCurrentContext,
    setMessageMetadata,
    sessionId,
    activeSessionId,
    activeThreadId,
  });

  useEffect(() => {
    if (!debugEnabled) return;
    debugLog('SessionPage', 'stream protocol', {
      ai_sdk_stream_enabled: true,
    });
  }, [debugEnabled]);

  return {
    handleDataPart,
    handleFinish,
    markStreamTurnStarted,
    setStreamInterruptHandler,
  };
}
