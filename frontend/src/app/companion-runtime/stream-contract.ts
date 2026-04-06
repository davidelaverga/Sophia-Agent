import { useCallback, useRef } from 'react';

import { emitTiming } from '../lib/telemetry';
import {
  extractStreamMetadata,
  normalizeStreamDataPart,
  parseArtifactsPayload,
  parseInterruptPayload,
} from '../session/stream-contract-adapters';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

import type { UseCompanionStreamContractParams } from './types';

export function useCompanionStreamContract({
  ingestArtifacts,
  setInterrupt,
  setCurrentContext,
  setMessageMetadata,
  sessionId,
  activeSessionId,
  activeThreadId,
}: UseCompanionStreamContractParams) {
  const latestStreamMetaRef = useRef<Partial<SophiaMessageMetadata>>({});
  const streamTurnStartedAtRef = useRef<number | null>(null);

  const markStreamTurnStarted = useCallback((startedAtMs: number) => {
    streamTurnStartedAtRef.current = startedAtMs;
  }, []);

  const handleDataPart = useCallback((dataPart: unknown) => {
    const normalized = normalizeStreamDataPart(dataPart);
    if (!normalized) return;

    if (normalized.type === 'artifactsV1' || normalized.type === 'artifacts') {
      const artifactsPayload = parseArtifactsPayload(normalized.data);
      if (artifactsPayload) ingestArtifacts(artifactsPayload, 'stream');
      return;
    }

    if (normalized.type === 'interrupt') {
      const interruptPayload = parseInterruptPayload(normalized.data);
      if (interruptPayload) setInterrupt(interruptPayload);
      return;
    }

    if (normalized.type === 'sophia_meta' || normalized.type === 'meta') {
      latestStreamMetaRef.current = extractStreamMetadata(normalized.data, latestStreamMetaRef.current);

      if (latestStreamMetaRef.current.thread_id && activeSessionId) {
        setCurrentContext(
          latestStreamMetaRef.current.thread_id,
          activeSessionId,
          latestStreamMetaRef.current.run_id,
        );
      }
    }
  }, [activeSessionId, ingestArtifacts, setCurrentContext, setInterrupt]);

  const handleFinish = useCallback((options: { message: { id: string } }) => {
    const messageId = options.message.id;
    const sessionIdValue = activeSessionId || sessionId;
    const meta = latestStreamMetaRef.current || {};

    const metadata: Partial<SophiaMessageMetadata> = {
      thread_id: meta.thread_id || activeThreadId || '',
      run_id: meta.run_id,
      session_id: meta.session_id || sessionIdValue,
      skill_used: meta.skill_used,
      emotion_detected: meta.emotion_detected,
    };

    if (metadata.thread_id) {
      setCurrentContext(metadata.thread_id, metadata.session_id || sessionIdValue, metadata.run_id);
    }

    if (messageId) {
      setMessageMetadata(messageId, metadata);
    }

    if (streamTurnStartedAtRef.current) {
      emitTiming('session.stream.turn_ms', streamTurnStartedAtRef.current, {
        session_id: sessionIdValue,
      });
      streamTurnStartedAtRef.current = null;
    }
  }, [activeSessionId, activeThreadId, sessionId, setCurrentContext, setMessageMetadata]);

  return {
    handleDataPart,
    handleFinish,
    markStreamTurnStarted,
  };
}