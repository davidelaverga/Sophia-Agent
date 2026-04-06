import { useCallback, useEffect, useRef, useState } from 'react';

import { debugLog } from '../lib/debug-logger';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import {
  getLiveArtifactStatus,
  getPersistedArtifactStatus,
  mergeRitualArtifacts,
} from '../session/artifacts';
import type { RitualArtifacts } from '../types/session';

import type { ArtifactStatusState, UseCompanionArtifactsRuntimeParams } from './artifacts-runtime.types';
import type { CompanionArtifactSource } from './types';

const WAITING_STATUS: ArtifactStatusState = {
  takeaway: 'waiting',
  reflection: 'waiting',
  memories: 'waiting',
};

export function useCompanionArtifactsRuntime({
  sessionId,
  artifacts,
  storeArtifacts,
  updateSession,
}: UseCompanionArtifactsRuntimeParams) {
  const [artifactStatus, setArtifactStatus] = useState<ArtifactStatusState>(WAITING_STATUS);
  const artifactsRef = useRef<RitualArtifacts | null>(artifacts ?? null);
  const previousSessionIdRef = useRef<string | null>(null);
  const liveStatusUntilRef = useRef<number>(0);

  useEffect(() => {
    artifactsRef.current = artifacts ?? null;
  }, [artifacts]);

  useEffect(() => {
    const currentSessionId = sessionId ?? null;

    if (
      previousSessionIdRef.current &&
      currentSessionId &&
      previousSessionIdRef.current !== currentSessionId
    ) {
      updateSession({ artifacts: undefined, summary: undefined });
      artifactsRef.current = null;
      liveStatusUntilRef.current = 0;
      setArtifactStatus(WAITING_STATUS);
    }

    previousSessionIdRef.current = currentSessionId;
  }, [sessionId, updateSession]);

  const ingestArtifacts = useCallback((incoming: CompanionArtifactsPayload, source: CompanionArtifactSource) => {
    debugLog('ArtifactsFlow', 'artifact payload received', {
      source,
      keys: Object.keys(incoming || {}),
      hasTakeaway: typeof incoming?.takeaway === 'string' && incoming.takeaway.trim().length > 0,
      hasReflection:
        typeof incoming?.reflection_candidate === 'string' ||
        (typeof incoming?.reflection_candidate === 'object' && incoming?.reflection_candidate !== null) ||
        typeof incoming?.reflection === 'string' ||
        (typeof incoming?.reflection === 'object' && incoming?.reflection !== null),
      memoryCandidatesCount: Array.isArray(incoming?.memory_candidates) ? incoming.memory_candidates.length : 0,
    });

    const currentArtifacts: RitualArtifacts = artifactsRef.current || { takeaway: '' };
    const { merged: mergedBase } = mergeRitualArtifacts(currentArtifacts, incoming, {
      filterFallbackReflection: true,
      filterFallbackTakeaway: true,
      mergeMemoryCandidates: true,
    });

    const merged: RitualArtifacts = source === 'companion'
      ? {
          ...mergedBase,
          takeaway: currentArtifacts.takeaway,
        }
      : mergedBase;

    artifactsRef.current = merged;
    storeArtifacts(merged);
    liveStatusUntilRef.current = Date.now() + 1500;
    const nextStatus = getLiveArtifactStatus(merged);
    setArtifactStatus(nextStatus);
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'ingest-artifacts',
      payload: {
        sessionId: sessionId ?? null,
        source,
        incoming,
        merged,
        status: nextStatus,
      },
    });

    debugLog('ArtifactsFlow', 'artifact store updated', {
      source,
      takeawayLength: merged.takeaway?.trim().length ?? 0,
      hasReflection: Boolean(merged.reflection_candidate?.prompt),
      memoryCandidatesCount: merged.memory_candidates?.length ?? 0,
      status: nextStatus,
    });
  }, [sessionId, storeArtifacts]);

  const applyMemoryCandidates = useCallback((nextCandidates: RitualArtifacts['memory_candidates']) => {
    const currentArtifacts: RitualArtifacts = artifactsRef.current || { takeaway: '' };
    const merged: RitualArtifacts = {
      ...currentArtifacts,
      memory_candidates: nextCandidates,
    };

    artifactsRef.current = merged;
    storeArtifacts(merged);
    liveStatusUntilRef.current = Date.now() + 1500;
    const nextStatus = getLiveArtifactStatus(merged);
    setArtifactStatus(nextStatus);
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'apply-memory-candidates',
      payload: {
        sessionId: sessionId ?? null,
        memoryCandidatesCount: nextCandidates?.length ?? 0,
        merged,
        status: nextStatus,
      },
    });
  }, [sessionId, storeArtifacts]);

  useEffect(() => {
    if (!artifacts) return;

    const useLiveStatus = Date.now() <= liveStatusUntilRef.current;
    setArtifactStatus(useLiveStatus ? getLiveArtifactStatus(artifacts) : getPersistedArtifactStatus(artifacts));
  }, [artifacts]);

  return {
    artifactStatus,
    ingestArtifacts,
    applyMemoryCandidates,
  };
}

type CompanionArtifactsPayload = {
  takeaway?: string;
  reflection_candidate?: string | { prompt?: string; why?: string };
  reflection?: string | { prompt?: string; why?: string };
  memory_candidates?: unknown[];
  [key: string]: unknown;
};