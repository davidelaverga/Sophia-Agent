import { useCallback, useState } from 'react';
import { haptic } from '../hooks/useHaptics';
import { useSessionHistoryStore } from '../stores/session-history-store';
import { useRecapStore } from '../stores/recap-store';
import { useUiStore as useUiToastStore } from '../stores/ui-store';
import {
  endSession as endSessionAPI,
  isSuccess,
  submitDebriefDecision,
} from '../lib/api/sessions-api';
import { mapBackendArtifactsToRecapV1 } from '../lib/artifacts-adapter';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { markRecentSessionEnd } from '../lib/recent-session-end';
import { errorCopy } from '../lib/error-copy';
import type { PresetType, ContextMode } from '../types/session';

interface DebriefData {
  prompt: string;
  durationMinutes: number;
  takeaway?: string;
  sessionId: string;
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
      setIsNavigatingToRecap(true);
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
    const shouldOfferDebrief = presetType !== 'debrief';

    try {
      const result = await endSessionAPI({
        session_id: recapSessionId,
        offer_debrief: shouldOfferDebrief,
      });

      if (isSuccess(result)) {
        useSessionHistoryStore.getState().addSession({
          sessionId: recapSessionId,
          presetType,
          contextMode,
          startedAt,
          endedAt: result.data.ended_at,
          messageCount: result.data.turn_count || messageCount,
          takeawayPreview: result.data.recap_artifacts?.takeaway,
        });

        if (result.data.recap_artifacts) {
          const mappedArtifacts = mapBackendArtifactsToRecapV1(
            {
              ...result.data.recap_artifacts,
              session_id: recapSessionId,
              session_type: presetType,
              context_mode: contextMode,
              started_at: startedAt,
              ended_at: result.data.ended_at,
            },
            recapSessionId,
          );

          if (mappedArtifacts) {
            useRecapStore.getState().setArtifacts(recapSessionId, mappedArtifacts);
          }
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
            takeaway: result.data.recap_artifacts?.takeaway,
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
        useSessionHistoryStore.getState().addSession({
          sessionId: recapSessionId,
          presetType,
          contextMode,
          startedAt,
          endedAt: new Date().toISOString(),
          messageCount,
          takeawayPreview: undefined,
        });
      }
    } catch (error) {
      logger.logError(error, {
        component: 'SessionPage',
        action: 'end_session_network',
      });
      useSessionHistoryStore.getState().addSession({
        sessionId: recapSessionId,
        presetType,
        contextMode,
        startedAt,
        endedAt: new Date().toISOString(),
        messageCount,
        takeawayPreview: undefined,
      });
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
    finalizeExitToRecap,
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
