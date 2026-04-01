import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArtifactStatusType } from '../components/session';
import type { RitualArtifacts } from '../types/session';
import {
  getLiveArtifactStatus,
  getPersistedArtifactStatus,
  mergeRitualArtifacts,
} from './artifacts';
import type { StreamArtifactsPayload } from './stream-contract-adapters';
import { debugLog } from '../lib/debug-logger';

type ArtifactStatusState = {
  takeaway: ArtifactStatusType;
  reflection: ArtifactStatusType;
  memories: ArtifactStatusType;
};

type ArtifactSource = 'stream' | 'interrupt' | 'companion' | 'voice';

const WAITING_STATUS: ArtifactStatusState = {
  takeaway: 'waiting',
  reflection: 'waiting',
  memories: 'waiting',
};

interface UseSessionArtifactsReducerParams {
  sessionId?: string;
  artifacts?: RitualArtifacts | null;
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  updateSession: (updates: { artifacts?: RitualArtifacts; summary?: string }) => void;
}

export function useSessionArtifactsReducer({
  sessionId,
  artifacts,
  storeArtifacts,
  updateSession,
}: UseSessionArtifactsReducerParams) {
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

  const ingestArtifacts = useCallback((incoming: StreamArtifactsPayload, _source: ArtifactSource) => {
    debugLog('ArtifactsFlow', 'artifact payload received', {
      source: _source,
      keys: Object.keys(incoming || {}),
      hasTakeaway: typeof incoming?.takeaway === 'string' && incoming.takeaway.trim().length > 0,
      hasReflection:
        typeof incoming?.reflection_candidate === 'string' ||
        (typeof incoming?.reflection_candidate === 'object' && incoming?.reflection_candidate !== null),
      memoryCandidatesCount: Array.isArray(incoming?.memory_candidates) ? incoming.memory_candidates.length : 0,
    });

    const currentArtifacts: RitualArtifacts = artifactsRef.current || { takeaway: '' };
    const { merged: mergedBase } = mergeRitualArtifacts(currentArtifacts, incoming, {
      filterFallbackReflection: true,
      filterFallbackTakeaway: true,
      mergeMemoryCandidates: true,
    });

    const merged: RitualArtifacts = _source === 'companion'
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

    debugLog('ArtifactsFlow', 'artifact store updated', {
      source: _source,
      takeawayLength: merged.takeaway?.trim().length ?? 0,
      hasReflection: Boolean(merged.reflection_candidate?.prompt),
      memoryCandidatesCount: merged.memory_candidates?.length ?? 0,
      status: nextStatus,
    });
  }, [storeArtifacts]);

  const applyMemoryCandidates = useCallback((nextCandidates: RitualArtifacts['memory_candidates']) => {
    const currentArtifacts: RitualArtifacts = artifactsRef.current || { takeaway: '' };
    const merged: RitualArtifacts = {
      ...currentArtifacts,
      memory_candidates: nextCandidates,
    };

    artifactsRef.current = merged;
    storeArtifacts(merged);
    liveStatusUntilRef.current = Date.now() + 1500;
    setArtifactStatus(getLiveArtifactStatus(merged));
  }, [storeArtifacts]);

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
