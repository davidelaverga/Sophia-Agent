'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useConnectivity } from '../../hooks/useConnectivity';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { haptic } from '../../hooks/useHaptics';
import { useSessionStart } from '../../hooks/useSessionStart';
import { fetchBootstrapOpener, type BootstrapOpenerResponse } from '../../lib/api/bootstrap-api';
import { endSession as endSessionAPI, isSuccess } from '../../lib/api/sessions-api';
import { resolveDashboardBootstrapState } from '../../lib/dashboard-bootstrap-orchestration';
import { debugLog, debugWarn } from '../../lib/debug-logger';
import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../lib/recent-session-end';
import { teardownSessionClientState } from '../../lib/session-teardown';
import { emitTiming } from '../../lib/telemetry';
import { isUuid } from '../../lib/utils';
import { useAuth } from '../../providers';
import { useConnectivityStore, selectStatus } from '../../stores/connectivity-store';
import { useSessionHistoryStore } from '../../stores/session-history-store';
import {
  useSessionStore,
  selectIsSessionActive,
  selectSession,
  selectSessionSummary,
} from '../../stores/session-store';
import { useUiStore } from '../../stores/ui-store';
import type { ContextMode, PresetType, SessionInfo } from '../../types/session';

type MicState = 'idle' | 'listening' | 'thinking' | 'speaking';

type PendingStart = {
  preset: PresetType;
  userId: string;
  contextMode: ContextMode;
  voiceMode: boolean;
};

type FreshStartSeed = {
  userId: string;
  sessionId?: string;
  presetType: PresetType;
  contextMode: ContextMode;
  startedAt: string;
  messageCount: number;
  intention?: string;
  focusCue?: string;
  voiceMode: boolean;
};

const GENERIC_BOOTSTRAP_OPENERS = new Set([
  'hey there. how can i help today?',
  'hey there! how can i help you today?',
]);

export function useDashboardEntryState() {
  const router = useRouter();
  const { user } = useAuth();

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
  const [showFreshStartPrompt, setShowFreshStartPrompt] = useState(false);
  const { containerRef: freshStartModalRef } = useFocusTrap(showFreshStartPrompt);
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);
  const [isLaunchingSession, setIsLaunchingSession] = useState(false);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const [backendActiveSession, setBackendActiveSession] = useState<SessionInfo | null>(null);
  const [bootstrapOpener, setBootstrapOpener] = useState<BootstrapOpenerResponse | null>(null);

  const { resumeSession: resumeSessionAPI, startSessionEntry, checkActiveSession, isLoading: isStartingSession } = useSessionStart({
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
        await resumeSessionAPI(backendActiveSession, user?.id || 'dev-user');
      } finally {
        setIsLaunchingSession(false);
      }
      return;
    }

    router.push('/session');
  }, [backendActiveSession, resumeSessionAPI, user?.id, router]);

  const buildFreshStartSeed = useCallback((): FreshStartSeed => ({
    userId: user?.id || `demo-${Date.now()}`,
    sessionId: backendActiveSession?.session_id || activeSession?.sessionId,
    presetType: (backendActiveSession?.session_type || activeSession?.presetType || 'open') as PresetType,
    contextMode: (backendActiveSession?.preset_context || activeSession?.contextMode || 'life') as ContextMode,
    startedAt: backendActiveSession?.started_at || activeSession?.startedAt || new Date().toISOString(),
    messageCount: backendActiveSession?.turn_count || activeSession?.messages?.length || 0,
    intention: backendActiveSession?.intention || activeSession?.intention,
    focusCue: backendActiveSession?.focus_cue || activeSession?.focusCue,
    voiceMode: activeSession?.voiceMode ?? false,
  }), [backendActiveSession, activeSession, user?.id]);

  const finalizeFreshStart = useCallback(async (): Promise<FreshStartSeed> => {
    const seed = buildFreshStartSeed();
    const {
      sessionId,
      presetType,
      contextMode: freshContextMode,
      startedAt,
      messageCount,
    } = seed;

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
            contextMode: freshContextMode,
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
            contextMode: freshContextMode,
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
          contextMode: freshContextMode,
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
    setBootstrapOpener(null);
    setShowResumeBanner(false);

    return seed;
  }, [buildFreshStartSeed, endSession, clearSession]);

  const handleStartFresh = useCallback(async () => {
    haptic('light');
    setShowFreshStartPrompt(true);
  }, []);

  const handleCancelFreshStart = useCallback(() => {
    haptic('light');
    setShowFreshStartPrompt(false);
  }, []);

  const handleRestartWithSameRitual = useCallback(async () => {
    haptic('medium');
    setShowFreshStartPrompt(false);

    const seed = await finalizeFreshStart();
    const ritualSelection = seed.presetType === 'prepare' || seed.presetType === 'debrief' || seed.presetType === 'reset' || seed.presetType === 'vent'
      ? seed.presetType
      : null;

    setContextMode(seed.contextMode);
    setSelectedRitual(ritualSelection);

    setIsLaunchingSession(true);
    try {
      const result = await startSessionEntry({
        userId: seed.userId,
        preset: seed.presetType,
        contextMode: seed.contextMode,
        voiceMode: seed.voiceMode,
        intention: seed.intention,
        focusCue: seed.focusCue,
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
  }, [finalizeFreshStart, startSessionEntry, showToast]);

  const handleChooseDifferentRitual = useCallback(async () => {
    haptic('light');
    setShowFreshStartPrompt(false);

    const seed = await finalizeFreshStart();
    setContextMode(seed.contextMode);
    setSelectedRitual(null);
    showToast({
      message: 'Previous session cleared. Choose how you want to begin.',
      variant: 'info',
      durationMs: 2800,
    });
  }, [finalizeFreshStart, showToast]);

  useEffect(() => {
    if (!showFreshStartPrompt) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancelFreshStart();
    };

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showFreshStartPrompt, handleCancelFreshStart]);

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
    showReplaceSessionConfirm,
    replaceModalRef,
    showFreshStartPrompt,
    freshStartModalRef,
    handleConfirmReplaceSession,
    handleCancelReplaceSession,
    handleCallSophia,
    handleContinueSession,
    handleDismissResumeBanner,
    handleResumeBanner,
    handleStartFresh,
    handleCancelFreshStart,
    handleRestartWithSameRitual,
    handleChooseDifferentRitual,
  };
}