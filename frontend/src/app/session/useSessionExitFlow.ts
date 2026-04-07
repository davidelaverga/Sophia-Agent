import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';

import { haptic } from '../hooks/useHaptics';
import {
  endSession as endSessionAPI,
  isSuccess,
  submitDebriefDecision,
} from '../lib/api/sessions-api';
import { mapBackendArtifactsToRecapV1 } from '../lib/artifacts-adapter';
import { errorCopy } from '../lib/error-copy';
import { logger } from '../lib/error-logger';
import { markRecentSessionEnd } from '../lib/recent-session-end';
import type { RecapArtifactsV1 } from '../lib/recap-types';
import { teardownSessionClientState } from '../lib/session-teardown';
import { useRecapStore } from '../stores/recap-store';
import { useSessionHistoryStore } from '../stores/session-history-store';
import { useUiStore as useUiToastStore } from '../stores/ui-store';
import type { PresetType, ContextMode, RitualArtifacts } from '../types/session';

interface DebriefData {
  prompt: string;
  durationMinutes: number;
  takeaway?: string;
  sessionId: string;
}

type ExitSessionMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt?: string;
};

function mapLiveArtifactsToRecapV1({
  sessionId,
  startedAt,
  endedAt,
  presetType,
  contextMode,
  currentArtifacts,
}: {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  presetType: PresetType;
  contextMode: ContextMode;
  currentArtifacts?: RitualArtifacts | null;
}) {
  if (!currentArtifacts) {
    return null;
  }

  const hasTakeaway = typeof currentArtifacts.takeaway === 'string' && currentArtifacts.takeaway.trim().length > 0;
  const hasReflection = typeof currentArtifacts.reflection_candidate?.prompt === 'string'
    && currentArtifacts.reflection_candidate.prompt.trim().length > 0;
  const hasMemories = Array.isArray(currentArtifacts.memory_candidates)
    && currentArtifacts.memory_candidates.length > 0;

  if (!hasTakeaway && !hasReflection && !hasMemories) {
    return null;
  }

  return mapBackendArtifactsToRecapV1(
    {
      session_id: sessionId,
      session_type: presetType,
      context_mode: contextMode,
      started_at: startedAt,
      ended_at: endedAt,
      takeaway: hasTakeaway ? currentArtifacts.takeaway : undefined,
      reflection_candidate: hasReflection
        ? {
            prompt: currentArtifacts.reflection_candidate?.prompt,
            tag: currentArtifacts.reflection_candidate?.category,
          }
        : undefined,
      memory_candidates: hasMemories
        ? currentArtifacts.memory_candidates?.map((candidate) => ({
            ...(candidate.id ? { id: candidate.id } : {}),
            text: candidate.memory,
            memory: candidate.memory,
            category: candidate.category,
            confidence: candidate.confidence,
            ...(candidate.created_at ? { created_at: candidate.created_at } : {}),
            ...(candidate.reason ? { reason: candidate.reason } : {}),
          }))
        : undefined,
    },
    sessionId,
  );
}

function serializeLiveArtifactsForSessionEnd(
  currentArtifacts?: RitualArtifacts | null,
): NonNullable<import('../types/session').SessionEndRequest['recap_artifacts']> | undefined {
  if (!currentArtifacts) {
    return undefined;
  }

  const hasTakeaway = typeof currentArtifacts.takeaway === 'string' && currentArtifacts.takeaway.trim().length > 0;
  const hasReflection = typeof currentArtifacts.reflection_candidate?.prompt === 'string'
    && currentArtifacts.reflection_candidate.prompt.trim().length > 0;
  const hasMemories = Array.isArray(currentArtifacts.memory_candidates)
    && currentArtifacts.memory_candidates.length > 0;

  if (!hasTakeaway && !hasReflection && !hasMemories) {
    return undefined;
  }

  return {
    takeaway: hasTakeaway ? currentArtifacts.takeaway : undefined,
    reflection_candidate: hasReflection
      ? {
          prompt: currentArtifacts.reflection_candidate?.prompt,
          tag: currentArtifacts.reflection_candidate?.category,
        }
      : undefined,
    memory_candidates: hasMemories
      ? currentArtifacts.memory_candidates?.map((candidate) => ({
          ...(candidate.id ? { id: candidate.id } : {}),
          text: candidate.memory,
          memory: candidate.memory,
          category: candidate.category,
          confidence: candidate.confidence,
          ...(candidate.created_at ? { created_at: candidate.created_at } : {}),
          ...(candidate.reason ? { reason: candidate.reason } : {}),
        }))
      : undefined,
    status: 'ready',
  };
}

function mergeRecapArtifacts(
  primary: RecapArtifactsV1 | null,
  fallback: RecapArtifactsV1 | null,
): RecapArtifactsV1 | null {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  return {
    ...primary,
    startedAt: primary.startedAt ?? fallback.startedAt,
    endedAt: primary.endedAt ?? fallback.endedAt,
    takeaway: primary.takeaway ?? fallback.takeaway,
    reflectionCandidate: primary.reflectionCandidate ?? fallback.reflectionCandidate,
    memoryCandidates: primary.memoryCandidates?.length
      ? primary.memoryCandidates
      : fallback.memoryCandidates,
    status: primary.status === 'ready' || fallback.status === 'ready'
      ? 'ready'
      : primary.status,
  };
}

function serializeSessionMessages(messages?: ExitSessionMessage[]): NonNullable<import('../types/session').SessionEndRequest['messages']> {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content.trim() : '',
      created_at: message.createdAt,
    }))
    .filter((message) => message.content.length > 0);
}

interface UseSessionExitFlowParams {
  isReadOnly: boolean;
  isSophiaResponding: boolean;
  stopStreaming: () => void;
  setEnding: (isEnding: boolean) => void;
  sessionId: string;
  sessionStartedAt?: string;
  sessionPresetType?: PresetType;
  sessionContextMode?: ContextMode;
  messageCount: number;
  endSessionStore: () => void;
  clearSessionStore: () => void;
  clearBootstrap: () => void;
  navigateTo: (path: string) => void;
  promoteToDebriefMode: () => void;
  startDebriefWithLLM: (debriefData: DebriefData) => void;
  currentArtifacts?: RitualArtifacts | null;
  userId?: string;
  threadId?: string;
  messages?: ExitSessionMessage[];
}

export function useSessionExitFlow({
  isReadOnly,
  isSophiaResponding,
  stopStreaming,
  setEnding,
  sessionId,
  sessionStartedAt,
  sessionPresetType,
  sessionContextMode,
  messageCount,
  endSessionStore,
  clearSessionStore,
  clearBootstrap,
  navigateTo,
  promoteToDebriefMode,
  startDebriefWithLLM,
  currentArtifacts,
  userId,
  threadId,
  messages,
}: UseSessionExitFlowParams) {
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showDebriefOffer, setShowDebriefOffer] = useState(false);
  const [debriefData, setDebriefData] = useState<DebriefData | null>(null);
  const [isNavigatingToRecap, setIsNavigatingToRecap] = useState(false);
  const [showEmergence, setShowEmergence] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [pendingRecapSessionId, setPendingRecapSessionId] = useState<string | null>(null);

  const openExitConfirm = useCallback(() => {
    setShowExitConfirm(true);
  }, []);

  const finalizeExitToRecap = useCallback(
    (recapSessionId: string) => {
      flushSync(() => {
        setIsNavigatingToRecap(true);
        setPendingRecapSessionId(null);
        setShowEmergence(false);
        setShowFeedback(false);
      });
      markRecentSessionEnd(recapSessionId);
      endSessionStore();
      clearSessionStore();
      teardownSessionClientState(recapSessionId);
      clearBootstrap();

      useUiToastStore.getState().showToast({
        message: errorCopy.sessionEnded,
        variant: 'success',
        durationMs: 4000,
        action: {
          label: 'View recap',
          onClick: () => navigateTo(`/recap/${recapSessionId}`),
        },
      });

      navigateTo(`/recap/${recapSessionId}`);
    },
    [endSessionStore, clearSessionStore, clearBootstrap, navigateTo],
  );

  const finalizeSessionEnd = useCallback(async () => {
    stopStreaming();

    haptic('medium');
    setEnding(true);
    setShowExitConfirm(false);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const recapSessionId = sessionId;
    const startedAt = sessionStartedAt || new Date().toISOString();
    const presetType = sessionPresetType || 'open';
    const contextMode = sessionContextMode || 'life';
    // Session exit should always continue into the recap feedback flow.
    const shouldOfferDebrief = false;
    const serializedMessages = serializeSessionMessages(messages);
    const serializedArtifacts = serializeLiveArtifactsForSessionEnd(currentArtifacts);

    try {
      const result = await endSessionAPI({
        session_id: recapSessionId,
        thread_id: threadId || recapSessionId,
        user_id: userId,
        offer_debrief: shouldOfferDebrief,
        session_type: presetType,
        context_mode: contextMode,
        started_at: startedAt,
        turn_count: messageCount,
        messages: serializedMessages,
        recap_artifacts: serializedArtifacts,
      });

      if (isSuccess(result)) {
        const mappedArtifactsFromResponse = result.data.recap_artifacts
          ? mapBackendArtifactsToRecapV1(
              {
                ...result.data.recap_artifacts,
                session_id: recapSessionId,
                session_type: presetType,
                context_mode: contextMode,
                started_at: startedAt,
                ended_at: result.data.ended_at,
              },
              recapSessionId,
            )
          : null;

        const mappedArtifactsFromLiveSession = mapLiveArtifactsToRecapV1({
          sessionId: recapSessionId,
          startedAt,
          endedAt: result.data.ended_at,
          presetType,
          contextMode,
          currentArtifacts,
        });

        const resolvedRecapArtifacts = mergeRecapArtifacts(
          mappedArtifactsFromResponse,
          mappedArtifactsFromLiveSession,
        );

        useSessionHistoryStore.getState().addSession({
          sessionId: recapSessionId,
          presetType,
          contextMode,
          startedAt,
          endedAt: result.data.ended_at,
          messageCount: result.data.turn_count || messageCount,
          takeawayPreview: resolvedRecapArtifacts?.takeaway,
        });

        if (resolvedRecapArtifacts) {
          useRecapStore.getState().setArtifacts(recapSessionId, resolvedRecapArtifacts);
        }

        if (
          shouldOfferDebrief &&
          result.data.offer_debrief &&
          result.data.debrief_prompt &&
          result.data.duration_minutes >= 5
        ) {
          setDebriefData({
            prompt: result.data.debrief_prompt,
            durationMinutes: result.data.duration_minutes,
            takeaway: resolvedRecapArtifacts?.takeaway,
            sessionId: recapSessionId,
          });
          setShowDebriefOffer(true);
          setEnding(false);
          return;
        }
      } else {
        logger.warn('API end failed, saving locally', {
          component: 'SessionPage',
          action: 'end_session',
          metadata: { error: result.error },
        });

        const localEndedAt = new Date().toISOString();
        const mappedArtifactsFromLiveSession = mapLiveArtifactsToRecapV1({
          sessionId: recapSessionId,
          startedAt,
          endedAt: localEndedAt,
          presetType,
          contextMode,
          currentArtifacts,
        });

        useSessionHistoryStore.getState().addSession({
          sessionId: recapSessionId,
          presetType,
          contextMode,
          startedAt,
          endedAt: localEndedAt,
          messageCount,
          takeawayPreview: mappedArtifactsFromLiveSession?.takeaway,
        });

        if (mappedArtifactsFromLiveSession) {
          useRecapStore.getState().setArtifacts(recapSessionId, mappedArtifactsFromLiveSession);
        }
      }
    } catch (error) {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'end_session_network',
      });

      const localEndedAt = new Date().toISOString();
      const mappedArtifactsFromLiveSession = mapLiveArtifactsToRecapV1({
        sessionId: recapSessionId,
        startedAt,
        endedAt: localEndedAt,
        presetType,
        contextMode,
        currentArtifacts,
      });

      useSessionHistoryStore.getState().addSession({
        sessionId: recapSessionId,
        presetType,
        contextMode,
        startedAt,
        endedAt: localEndedAt,
        messageCount,
        takeawayPreview: mappedArtifactsFromLiveSession?.takeaway,
      });

      if (mappedArtifactsFromLiveSession) {
        useRecapStore.getState().setArtifacts(recapSessionId, mappedArtifactsFromLiveSession);
      }
    }

    // Start emergence flow instead of navigating directly
    setPendingRecapSessionId(recapSessionId);
    setShowEmergence(true);
    setEnding(false);
  }, [
    stopStreaming,
    setEnding,
    sessionId,
    sessionStartedAt,
    sessionPresetType,
    sessionContextMode,
    messageCount,
    currentArtifacts,
    userId,
    threadId,
    messages,
  ]);

  // ── Emergence → Feedback → Recap flow ─────────────────────────────────────

  const handleEmergenceComplete = useCallback(() => {
    setShowEmergence(false);
    setShowFeedback(true);
  }, []);

  const handleFeedbackComplete = useCallback(() => {
    setShowFeedback(false);
    if (pendingRecapSessionId) {
      finalizeExitToRecap(pendingRecapSessionId);
    }
  }, [pendingRecapSessionId, finalizeExitToRecap]);

  /** Skip emergence for abrupt exits (network drop, tab close) */
  const handleAbruptExit = useCallback((recapSessionId: string) => {
    finalizeExitToRecap(recapSessionId);
  }, [finalizeExitToRecap]);

  const handleEndSession = useCallback(async () => {
    if (isReadOnly) {
      useUiToastStore.getState().showToast({
        message: 'This session is read-only and cannot be ended again.',
        variant: 'info',
        durationMs: 2400,
      });
      return;
    }

    if (isSophiaResponding && !showExitConfirm) {
      setShowExitConfirm(true);
      haptic('light');
      return;
    }

    await finalizeSessionEnd();
  }, [
    isReadOnly,
    isSophiaResponding,
    showExitConfirm,
    finalizeSessionEnd,
  ]);

  const handleVoiceEndSession = useCallback(async () => {
    if (isReadOnly) {
      useUiToastStore.getState().showToast({
        message: 'This session is read-only and cannot be ended again.',
        variant: 'info',
        durationMs: 2400,
      });
      return;
    }

    await finalizeSessionEnd();
  }, [isReadOnly, finalizeSessionEnd]);

  const handleCancelExit = useCallback(() => {
    setShowExitConfirm(false);
    haptic('light');
  }, []);

  const handleStartDebrief = useCallback(() => {
    if (!debriefData) return;

    haptic('medium');
    setShowDebriefOffer(false);
    void submitDebriefDecision({
      session_id: debriefData.sessionId,
      decision: 'debrief',
    }).then((result) => {
      if (!isSuccess(result)) {
        logger.warn('Failed to record debrief decision', {
          component: 'SessionPage',
          action: 'record_debrief_decision',
          metadata: {
            sessionId: debriefData.sessionId,
            decision: 'debrief',
            error: result.error,
          },
        });
      }
    }).catch((error) => {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'record_debrief_decision_network',
        metadata: {
          sessionId: debriefData.sessionId,
          decision: 'debrief',
        },
      });
    });
    promoteToDebriefMode();
    startDebriefWithLLM(debriefData);
  }, [debriefData, promoteToDebriefMode, startDebriefWithLLM]);

  const handleSkipToRecap = useCallback(() => {
    if (!debriefData) return;

    haptic('light');
    setShowDebriefOffer(false);
    void submitDebriefDecision({
      session_id: debriefData.sessionId,
      decision: 'skip',
    }).then((result) => {
      if (!isSuccess(result)) {
        logger.warn('Failed to record debrief decision', {
          component: 'SessionPage',
          action: 'record_debrief_decision',
          metadata: {
            sessionId: debriefData.sessionId,
            decision: 'skip',
            error: result.error,
          },
        });
      }
    }).catch((error) => {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'record_debrief_decision_network',
        metadata: {
          sessionId: debriefData.sessionId,
          decision: 'skip',
        },
      });
    });

    setIsNavigatingToRecap(true);
    markRecentSessionEnd(debriefData.sessionId);
    endSessionStore();
    clearSessionStore();
    teardownSessionClientState(debriefData.sessionId);
    clearBootstrap();

    navigateTo(`/recap/${debriefData.sessionId}`);
  }, [debriefData, endSessionStore, clearSessionStore, clearBootstrap, navigateTo]);

  return {
    showExitConfirm,
    showDebriefOffer,
    showEmergence,
    showFeedback,
    debriefData,
    isNavigatingToRecap,
    openExitConfirm,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
    handleFeedbackComplete,
    handleAbruptExit,
  };
}
