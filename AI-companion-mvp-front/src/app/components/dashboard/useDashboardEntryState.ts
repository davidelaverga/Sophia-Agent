'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { haptic } from '../../hooks/useHaptics';
import { useConnectivity } from '../../hooks/useConnectivity';
import { useSessionStart } from '../../hooks/useSessionStart';
import { useSupabase } from '../../providers';
import {
  useSessionStore,
  selectIsSessionActive,
  selectSession,
  selectSessionSummary,
} from '../../stores/session-store';
import { useSessionHistoryStore } from '../../stores/session-history-store';
import { useConnectivityStore, selectStatus } from '../../stores/connectivity-store';
import { useUiStore } from '../../stores/ui-store';
import { endSession as endSessionAPI, isSuccess } from '../../lib/api/sessions-api';
import { fetchBootstrapOpener, type BootstrapOpenerResponse } from '../../lib/api/bootstrap-api';
import { isUuid } from '../../lib/utils';
import { teardownSessionClientState } from '../../lib/session-teardown';
import { emitTiming } from '../../lib/telemetry';
import { debugLog, debugWarn } from '../../lib/debug-logger';
import { resolveDashboardBootstrapState } from '../../lib/dashboard-bootstrap-orchestration';
import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../lib/recent-session-end';
import type { ContextMode, PresetType } from '../../types/session';

type MicState = 'idle' | 'listening' | 'thinking' | 'speaking';

type PendingStart = {
  preset: PresetType;
  userId: string;
  contextMode: ContextMode;
  voiceMode: boolean;
};

const GENERIC_BOOTSTRAP_OPENERS = new Set([
  'hey there. how can i help today?',
  'hey there! how can i help you today?',
]);

export function useDashboardEntryState() {
  const router = useRouter();
  const { user } = useSupabase();

  const hasActiveSession = useSessionStore(selectIsSessionActive);
  const activeSession = useSessionStore(selectSession);
  const sessionSummary = useSessionStore(selectSessionSummary);
  const endSession = useSessionStore((state) => state.endSession);
  const clearSession = useSessionStore((state) => state.clearSession);

  useConnectivity();

  const connectivityStatus = useConnectivityStore(selectStatus);
  const showToast = useUiStore((state) => state.showToast);

  const isOffline = connectivityStatus === 'offline' || connectivityStatus === 'degraded';
  const isConnecting = connectivityStatus === 'checking';

  const [contextMode, setContextMode] = useState<ContextMode>('gaming');
  const [selectedRitual, setSelectedRitual] = useState<PresetType | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [showReplaceSessionConfirm, setShowReplaceSessionConfirm] = useState(false);
  const { containerRef: replaceModalRef } = useFocusTrap(showReplaceSessionConfirm);
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);
  const [isLaunchingSession, setIsLaunchingSession] = useState(false);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const [backendActiveSession, setBackendActiveSession] = useState<{
    session_id: string;
    session_type: string;
    preset_context: string;
    started_at: string;
    turn_count: number;
    intention?: string;
  } | null>(null);
  const [bootstrapOpener, setBootstrapOpener] = useState<BootstrapOpenerResponse | null>(null);

  const { start: startSessionAPI, startSessionEntry, checkActiveSession, isLoading: isStartingSession } = useSessionStart({
    navigateOnSuccess: true,
  });

  const normalizedBootstrapOpener = bootstrapOpener?.opener_text?.trim().toLowerCase() ?? '';
  const hasMeaningfulBootstrapOpener = Boolean(
    bootstrapOpener?.has_opener &&
      normalizedBootstrapOpener &&
      !GENERIC_BOOTSTRAP_OPENERS.has(normalizedBootstrapOpener)
  );

  const shouldShowResumeSurface =
    showResumeBanner && !isLaunchingSession && !isStartingSession && Boolean(backendActiveSession || sessionSummary);

  const currentContext = useMemo(() => {
    return contextMode;
  }, [contextMode]);

  useEffect(() => {
    let isCancelled = false;

    async function resolveBootstrap() {
      if (isLaunchingSession || isStartingSession) {
        setShowResumeBanner(false);
        return;
      }

      const hasRecentEndHint = Boolean(getRecentSessionEndHint());

      if (!user) {
        setBackendActiveSession(null);
        setBootstrapOpener(null);
        setShowResumeBanner(Boolean(hasActiveSession && sessionSummary));
        return;
      }

      const bootstrapStartedAt = Date.now();

      try {
        const state = await resolveDashboardBootstrapState({
          hasLocalActiveSession: Boolean(hasActiveSession && sessionSummary),
          hasRecentSessionEndHint: hasRecentEndHint,
          checkActiveSession,
          fetchBootstrapOpener,
        });

        if (isCancelled) return;

        if (state.mode === 'resume-backend') {
          setBackendActiveSession(state.session);
          setShowResumeBanner(true);
          setBootstrapOpener(null);
          if (!hasRecentEndHint) {
            clearRecentSessionEndHint();
          }
          return;
        }

        if (state.mode === 'resume-local') {
          setBackendActiveSession(null);
          setShowResumeBanner(true);
          setBootstrapOpener(null);
          return;
        }

        setBackendActiveSession(null);
        setShowResumeBanner(false);

        if (state.mode === 'opener') {
          setBootstrapOpener(state.opener);
          emitTiming('dashboard.bootstrap.fetch_ms', bootstrapStartedAt, {
            has_opener: true,
          });

          if (state.opener.suggested_ritual && !selectedRitual) {
            setSelectedRitual(state.opener.suggested_ritual);
          }

          clearRecentSessionEndHint();
          return;
        }

        setBootstrapOpener(null);
        emitTiming('dashboard.bootstrap.fetch_ms', bootstrapStartedAt, {
          has_opener: false,
        });
      } catch (err) {
        if (isCancelled) return;
        debugWarn('EnhancedFieldDashboard', 'Failed to resolve bootstrap state', err);
      }
    }

    void resolveBootstrap();

    return () => {
      isCancelled = true;
    };
  }, [
    user,
    hasActiveSession,
    sessionSummary,
    checkActiveSession,
    selectedRitual,
    isLaunchingSession,
    isStartingSession,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 60);
    return () => clearTimeout(timer);
  }, []);

  const handleRitualSelect = useCallback(
    (type: PresetType) => {
      if (selectedRitual === type) {
        setSelectedRitual(null);
        return;
      }

      setSelectedRitual(type);
      haptic('light');
    },
    [selectedRitual]
  );

  const handleStartSession = useCallback(
    async (voiceMode = false) => {
      const preset = selectedRitual;
      const userId = user?.id || `demo-${Date.now()}`;

      if (hasActiveSession) {
        haptic('light');
        setPendingStart({ preset: preset || 'open', userId, contextMode, voiceMode });
        setShowReplaceSessionConfirm(true);
        return;
      }

      setIsLaunchingSession(true);
      try {
        const result = await startSessionEntry({
          userId,
          preset,
          contextMode,
          voiceMode,
        });

        if (!result.success) {
          const errorMessage = 'error' in result && typeof result.error === 'string' ? result.error : null;
          showToast({
            message: errorMessage || "Couldn't start session.",
            variant: 'warning',
            durationMs: 3200,
          });
        }
      } finally {
        setIsLaunchingSession(false);
      }
    },
    [selectedRitual, user?.id, hasActiveSession, contextMode, startSessionEntry, showToast]
  );

  const handleConfirmReplaceSession = useCallback(async () => {
    if (!pendingStart) return;

    haptic('medium');
    setShowReplaceSessionConfirm(false);

    const currentSessionId = backendActiveSession?.session_id || activeSession?.sessionId;

    if (currentSessionId && isUuid(currentSessionId)) {
      try {
        const endResult = await endSessionAPI({
          session_id: currentSessionId,
          offer_debrief: false,
        });

        if (!isSuccess(endResult)) {
          debugWarn('EnhancedFieldDashboard', 'Failed to end backend session before replace', {
            sessionId: currentSessionId,
            error: endResult.error,
          });
        }
      } catch (error) {
        debugWarn('EnhancedFieldDashboard', 'Error ending backend session before replace', {
          sessionId: currentSessionId,
          error,
        });
      }
    }

    endSession();
    clearSession();
    teardownSessionClientState(currentSessionId);
    setBackendActiveSession(null);
    setShowResumeBanner(false);

    setIsLaunchingSession(true);
    try {
      const result = await startSessionEntry({
        userId: pendingStart.userId,
        preset: pendingStart.preset,
        contextMode: pendingStart.contextMode,
        voiceMode: pendingStart.voiceMode,
      });
      if (!result.success) {
        const errorMessage = 'error' in result && typeof result.error === 'string' ? result.error : null;
        showToast({
          message: errorMessage || "Couldn't start session.",
          variant: 'warning',
          durationMs: 3200,
        });
      }
    } finally {
      setIsLaunchingSession(false);
    }

    setPendingStart(null);
  }, [pendingStart, backendActiveSession, activeSession, endSession, clearSession, startSessionEntry, showToast]);

  const handleCancelReplaceSession = useCallback(() => {
    haptic('light');
    setShowReplaceSessionConfirm(false);
    setPendingStart(null);
  }, []);

  const handleCallSophia = useCallback(async () => {
    if (micState === 'idle') {
      await handleStartSession(!selectedRitual);
      return;
    }

    if (micState === 'listening') {
      setMicState('thinking');
      haptic('light');
      return;
    }

    setMicState('idle');
    haptic('light');
  }, [micState, selectedRitual, handleStartSession]);

  useEffect(() => {
    if (!showReplaceSessionConfirm) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancelReplaceSession();
    };

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showReplaceSessionConfirm, handleCancelReplaceSession]);

  const handleContinueSession = useCallback(() => {
    haptic('light');
    router.push('/session');
  }, [router]);

  const handleDismissResumeBanner = useCallback(() => {
    haptic('light');
    setShowResumeBanner(false);
  }, []);

  const handleResumeBanner = useCallback(async () => {
    haptic('light');

    if (backendActiveSession) {
      setIsLaunchingSession(true);
      try {
        await startSessionAPI(
          user?.id || `demo-${Date.now()}`,
          backendActiveSession.session_type as PresetType,
          backendActiveSession.preset_context as ContextMode,
          {
            intention: backendActiveSession.intention,
          }
        );
      } finally {
        setIsLaunchingSession(false);
      }
      return;
    }

    router.push('/session');
  }, [backendActiveSession, startSessionAPI, user?.id, router]);

  const handleStartFresh = useCallback(async () => {
    haptic('light');

    const sessionId = backendActiveSession?.session_id || activeSession?.sessionId;
    const presetType = (backendActiveSession?.session_type || activeSession?.presetType || 'open') as PresetType;
    const activeContextMode = (backendActiveSession?.preset_context || activeSession?.contextMode || 'life') as ContextMode;
    const startedAt = backendActiveSession?.started_at || activeSession?.startedAt || new Date().toISOString();
    const messageCount = backendActiveSession?.turn_count || activeSession?.messages?.length || 0;

    if (sessionId) {
      try {
        const result = await endSessionAPI({
          session_id: sessionId,
          offer_debrief: false,
        });

        if (isSuccess(result)) {
          useSessionHistoryStore.getState().addSession({
            sessionId,
            presetType,
            contextMode: activeContextMode,
            startedAt,
            endedAt: result.data.ended_at,
            messageCount: result.data.turn_count || messageCount,
            takeawayPreview: result.data.recap_artifacts?.takeaway,
          });
          debugLog('EnhancedFieldDashboard', 'Session ended and saved to history', { sessionId });
        } else {
          useSessionHistoryStore.getState().addSession({
            sessionId,
            presetType,
            contextMode: activeContextMode,
            startedAt,
            endedAt: new Date().toISOString(),
            messageCount,
          });
          debugWarn('EnhancedFieldDashboard', 'API end failed, saved locally');
        }
      } catch (error) {
        debugWarn('EnhancedFieldDashboard', 'Network error ending session', { error });
        useSessionHistoryStore.getState().addSession({
          sessionId,
          presetType,
          contextMode: activeContextMode,
          startedAt,
          endedAt: new Date().toISOString(),
          messageCount,
        });
      }
    }

    if (sessionId) {
      markRecentSessionEnd(sessionId);
    }

    endSession();
    clearSession();
    teardownSessionClientState(sessionId);
    setBackendActiveSession(null);
    setShowResumeBanner(false);
  }, [backendActiveSession, activeSession, endSession, clearSession]);

  const handleConversationLoaded = useCallback(() => {
    setShowHistoryDrawer(false);
    router.push('/session');
  }, [router]);

  return {
    user,
    currentContext,
    contextMode,
    setContextMode,
    selectedRitual,
    handleRitualSelect,
    micState,
    isOffline,
    isConnecting,
    isVisible,
    bootstrapOpener,
    hasMeaningfulBootstrapOpener,
    showResumeBanner,
    shouldShowResumeSurface,
    backendActiveSession,
    activeSession,
    sessionSummary,
    isLaunchingSession,
    isStartingSession,
    showSettingsDrawer,
    setShowSettingsDrawer,
    showHistoryDrawer,
    setShowHistoryDrawer,
    showReplaceSessionConfirm,
    replaceModalRef,
    handleConfirmReplaceSession,
    handleCancelReplaceSession,
    handleCallSophia,
    handleContinueSession,
    handleDismissResumeBanner,
    handleResumeBanner,
    handleStartFresh,
    handleConversationLoaded,
  };
}