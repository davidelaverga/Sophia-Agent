/**
 * VoiceFirstDashboard Component
 * Sprint 1 - Voice-First Redesign V3
 * Phase 4 Week 4 - Subphase 3: 3-Column Layout with History
 * 
 * The mic is a living organism, not a button.
 * Sophia's presence is always felt.
 * 
 * Layout (desktop/tablet):
 * [Recent Sessions] [Rituals + Mic] [History Drawer]
 * 
 * Layout (mobile):
 * Collapsed sidebars as floating buttons
 */

'use client';

import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useRouter } from 'next/navigation';
import { 
  RotateCcw,
  Clock,
} from 'lucide-react';
import { useSupabase } from '../providers';
import { useSessionStore, selectIsSessionActive, selectSession, selectSessionSummary } from '../stores/session-store';
import { useSessionHistoryStore } from '../stores/session-history-store';
import { useConnectivityStore, selectStatus } from '../stores/connectivity-store';
import { useUiStore } from '../stores/ui-store';
import { useConnectivity } from '../hooks/useConnectivity';
import { useSessionStart } from '../hooks/useSessionStart';
import { endSession as endSessionAPI, isSuccess } from '../lib/api/sessions-api';
import { fetchBootstrapOpener, type BootstrapOpenerResponse } from '../lib/api/bootstrap-api';
import { cn, isUuid } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { teardownSessionClientState } from '../lib/session-teardown';
import { emitTiming } from '../lib/telemetry';
import { debugLog, debugWarn } from '../lib/debug-logger';
import { resolveDashboardBootstrapState } from '../lib/dashboard-bootstrap-orchestration';
import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../lib/recent-session-end';
import { ResumeBanner } from './session/ResumeBanner';
import { humanizeTime } from '../lib/humanize-time';
import { EmotionAtmosphereCanvas } from './EmotionAtmosphereCanvas';
import { SettingsDrawer } from './dashboard/SettingsDrawer';
import type { PresetType, ContextMode } from '../types/session';

// Dashboard subcomponents
import {
  RitualCard,
  MicCTA,
  ContextTabs,
  DashboardCosmicBackground,
  RITUALS,
  CONTEXTS,
  type MicState,
} from './dashboard';

// Sidebar components with lazy loading
import {
  MobileFloatingButtons,
} from './dashboard/DashboardSidebar';

// Lazy load HistoryDrawer for mobile sheet
const HistoryDrawer = lazy(() => 
  import('./HistoryDrawer').then(mod => ({ default: mod.HistoryDrawer }))
);

const GENERIC_BOOTSTRAP_OPENERS = new Set([
  'hey there. how can i help today?',
  'hey there! how can i help you today?',
]);


// ============================================================================
// LAYOUT POSITION CONFIGS — each context mode is a different world
// ============================================================================
// All values in CSS units; RitualCard uses absolute positioning + transition.
// Container morphs its size; cards smoothly translate to new positions.

type RitualKey = 'prepare' | 'debrief' | 'reset' | 'vent';

type LayoutConfig = {
  containerClass: string;
  /** Flex alignment classes for the mic wrapper */
  micClass: string;
  cards: Record<RitualKey, React.CSSProperties>;
};

// Unified radial layout — cards orbit at compass points around the MicCTA
const RADIAL_LAYOUT: LayoutConfig = {
  containerClass: 'h-[380px] max-w-[420px]',
  micClass: 'items-center justify-center',
  cards: {
    prepare:  { top: 0, left: '10%' },
    debrief:  { top: 0, right: '10%' },
    reset:    { bottom: 0, left: '10%' },
    vent:     { bottom: 0, right: '10%' },
  },
};


// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function VoiceFirstDashboard() {
  const router = useRouter();
  const { user } = useSupabase();

  // Unified session state from session-store (single source of truth)
  const hasActiveSession = useSessionStore(selectIsSessionActive);
  const activeSession = useSessionStore(selectSession);
  const sessionSummary = useSessionStore(selectSessionSummary);
  const showToast = useUiStore((state) => state.showToast);
  
  // Connectivity monitoring - useConnectivity activates the health checks
  useConnectivity();
  const connectivityStatus = useConnectivityStore(selectStatus);
  // Determine connection state for UI
  const isOffline = connectivityStatus === 'offline' || connectivityStatus === 'degraded';
  const isConnecting = connectivityStatus === 'checking';
  
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const [backendActiveSession, setBackendActiveSession] = useState<{
    session_id: string;
    session_type: string;
    preset_context: string;
    started_at: string;
    turn_count: number;
    intention?: string;
  } | null>(null);
  
  const [contextMode, setContextMode] = useState<ContextMode>('gaming');
  const [selectedRitual, setSelectedRitual] = useState<PresetType | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [showReplaceSessionConfirm, setShowReplaceSessionConfirm] = useState(false);
  const { containerRef: replaceModalRef } = useFocusTrap(showReplaceSessionConfirm);
  const [pendingStart, setPendingStart] = useState<null | {
    preset: PresetType;
    userId: string;
    contextMode: ContextMode;
    voiceMode: boolean;
    intention?: string;
  }>(null);
  const [isLaunchingSession, setIsLaunchingSession] = useState(false);
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  
  // Bootstrap opener state - pre-computed personalized greeting
  const [bootstrapOpener, setBootstrapOpener] = useState<BootstrapOpenerResponse | null>(null);
  
  // ==========================================
  // HISTORY DRAWER STATE
  // ==========================================
  const [rightSidebarExpanded, setRightSidebarExpanded] = useState(false);
  
  // Mobile sheet states
  const [showMobileHistory, setShowMobileHistory] = useState(false);
  
  // Handle conversation loaded from history - navigate to session
  const handleConversationLoaded = useCallback(() => {
    setRightSidebarExpanded(false);
    setShowMobileHistory(false);
    router.push('/session');
  }, [router]);
  
  // Get current context config
  const currentContext = CONTEXTS.find(c => c.value === contextMode) || CONTEXTS[0];
  const normalizedBootstrapOpener = bootstrapOpener?.opener_text?.trim().toLowerCase() ?? '';
  const hasMeaningfulBootstrapOpener = Boolean(
    bootstrapOpener?.has_opener &&
    normalizedBootstrapOpener &&
    !GENERIC_BOOTSTRAP_OPENERS.has(normalizedBootstrapOpener)
  );
  
  // Session store actions
  const _createSession = useSessionStore((state) => state.createSession);
  const endSession = useSessionStore((state) => state.endSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  
  // Session start hook - calls backend API
  const { start: startSessionAPI, startSessionEntry, checkActiveSession, isLoading: isStartingSession } = useSessionStart({
    navigateOnSuccess: true, // Will navigate to /session after API call
  });
  
  // Resolve dashboard bootstrap state (resume vs opener) with recent-end-aware retries.
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
        debugWarn('Dashboard', 'Failed to resolve bootstrap state', err);
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
  
  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);
  
  // Handle ritual selection (toggle)
  const handleRitualSelect = useCallback((type: PresetType) => {
    if (selectedRitual === type) {
      setSelectedRitual(null);
    } else {
      setSelectedRitual(type);
      // Subtle aura pulse effect feedback
      haptic('light');
    }
  }, [selectedRitual]);
  
  // Handle starting a session (with or without ritual)
  const handleStartSession = useCallback(async (voiceMode: boolean = false) => {
    // Create session with selected ritual or 'open' for free chat
    const preset = selectedRitual;
    
    // Generate a temporary user ID if not logged in (for demo)
    const userId = user?.id || `demo-${Date.now()}`;
    
    // If there's already an active session, confirm before overwriting it.
    if (hasActiveSession) {
      haptic('light');
      setPendingStart({ preset: preset || 'open', userId, contextMode, voiceMode });
      setShowReplaceSessionConfirm(true);
      return;
    }

    // Start session via backend API (creates local + syncs with backend)
    // The hook handles navigation to /session
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
  }, [selectedRitual, user?.id, contextMode, startSessionEntry, hasActiveSession, showToast]);

  const handleConfirmReplaceSession = useCallback(async () => {
    if (!pendingStart) return;

    haptic('medium');
    setShowReplaceSessionConfirm(false);

    const currentSessionId = backendActiveSession?.session_id || activeSession?.sessionId;

    // Important: end backend active session first so next start is truly fresh
    if (currentSessionId && isUuid(currentSessionId)) {
      try {
        const endResult = await endSessionAPI({
          session_id: currentSessionId,
          offer_debrief: false,
        });

        if (!isSuccess(endResult)) {
          debugWarn('Dashboard', 'Failed to end backend session before replace', {
            sessionId: currentSessionId,
            error: endResult.error,
          });
        }
      } catch (error) {
        debugWarn('Dashboard', 'Error ending backend session before replace', {
          sessionId: currentSessionId,
          error,
        });
      }
    }

    // End current session and clear active session from persistence
    endSession();
    clearSession();
    teardownSessionClientState(currentSessionId);
    setBackendActiveSession(null);
    setShowResumeBanner(false);

    // Start the new session via backend API
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
  }, [pendingStart, backendActiveSession, activeSession, startSessionEntry, endSession, clearSession, showToast]);

  const handleCancelReplaceSession = useCallback(() => {
    haptic('light');
    setShowReplaceSessionConfirm(false);
    setPendingStart(null);
  }, []);
  
  // Handle "Call Sophia" - always starts a real session
  const handleCallSophia = useCallback(async () => {
    if (micState === 'idle') {
      // Start session - voice mode only for open sessions (no ritual)
      // If ritual is selected, user starts with ritual context, not listening
      const shouldAutoListen = !selectedRitual;
      await handleStartSession(shouldAutoListen);
      return;
    } else if (micState === 'listening') {
      // Stop listening, go to thinking
      setMicState('thinking');
      haptic('light');
    } else {
      // Interrupt speaking, go back to idle
      setMicState('idle');
      haptic('light');
    }
  }, [micState, selectedRitual, handleStartSession]);
  
  // Escape key dismisses replace-session dialog
  useEffect(() => {
    if (!showReplaceSessionConfirm) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancelReplaceSession();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showReplaceSessionConfirm, handleCancelReplaceSession]);

  // Handle continue last session (local session-store)
  const handleContinueSession = useCallback(() => {
    haptic('light');
    router.push('/session');
  }, [router]);
  
  // Handle resume from ResumeBanner (backend or local session)
  const handleResumeBanner = useCallback(async () => {
    haptic('light');
    if (backendActiveSession) {
      // Resume via API - will get is_resumed: true
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
    } else {
      // Resume local session from session-store
      router.push('/session');
    }
  }, [backendActiveSession, startSessionAPI, user?.id, router]);
  
  // Handle start fresh from ResumeBanner (properly ends session via API)
  const handleStartFresh = useCallback(async () => {
    haptic('light');
    
    // Get session info before clearing
    const sessionId = backendActiveSession?.session_id || activeSession?.sessionId;
    const presetType = (backendActiveSession?.session_type || activeSession?.presetType || 'open') as PresetType;
    const contextMode = (backendActiveSession?.preset_context || activeSession?.contextMode || 'life') as ContextMode;
    const startedAt = backendActiveSession?.started_at || activeSession?.startedAt || new Date().toISOString();
    const messageCount = backendActiveSession?.turn_count || activeSession?.messages?.length || 0;
    
    // Call backend API to properly end the session
    if (sessionId) {
      try {
        const result = await endSessionAPI({
          session_id: sessionId,
          offer_debrief: false, // Don't offer debrief when starting fresh
        });
        
        if (isSuccess(result)) {
          // Save to session history with backend data
          useSessionHistoryStore.getState().addSession({
            sessionId,
            presetType,
            contextMode,
            startedAt,
            endedAt: result.data.ended_at,
            messageCount: result.data.turn_count || messageCount,
            takeawayPreview: result.data.recap_artifacts?.takeaway,
          });
          debugLog('Dashboard', 'Session ended and saved to history', { sessionId });
        } else {
          // API failed - still save locally
          useSessionHistoryStore.getState().addSession({
            sessionId,
            presetType,
            contextMode,
            startedAt,
            endedAt: new Date().toISOString(),
            messageCount,
          });
          debugWarn('Dashboard', 'API end failed, saved locally');
        }
      } catch (err) {
        // Network error - save locally
        debugWarn('Dashboard', 'Network error ending session', { error: err });
        useSessionHistoryStore.getState().addSession({
          sessionId,
          presetType,
          contextMode,
          startedAt,
          endedAt: new Date().toISOString(),
          messageCount,
        });
      }
    }
    
    // Clear local stores
    if (sessionId) {
      markRecentSessionEnd(sessionId);
    }
    endSession();
    clearSession();
    teardownSessionClientState(sessionId);
    setBackendActiveSession(null);
    setShowResumeBanner(false);
  }, [endSession, clearSession, backendActiveSession, activeSession]);
  
  return (
    <div className={cn(
      'min-h-screen bg-sophia-bg transition-all duration-500 relative overflow-hidden',
      isVisible ? 'opacity-100' : 'opacity-0'
    )}>
      {/* Confirm: replace active session */}
      {showReplaceSessionConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/40"
            onClick={handleCancelReplaceSession}
          />
          <div
            ref={replaceModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="replace-session-title"
            className={cn(
              'relative w-full max-w-md rounded-2xl p-5',
              'bg-sophia-surface border border-sophia-surface-border shadow-soft'
            )}
          >
            {/* Header */}
            <div className="flex items-start gap-3">
              <div className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                'bg-sophia-purple/10 text-sophia-purple'
              )}>
                <RotateCcw className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3 id="replace-session-title" className="text-base font-semibold text-sophia-text">Continue your session?</h3>
                <p className="mt-0.5 text-xs text-sophia-text2">
                  You have an active session waiting
                </p>
              </div>
            </div>

            {/* Session Info Card */}
            {activeSession && (() => {
              // Get friendly labels
              const ritual = RITUALS.find(r => r.type === activeSession.presetType);
              const ritualLabel = ritual?.labels[activeSession.contextMode]?.title || activeSession.presetType;
              const contextLabel = CONTEXTS.find(c => c.value === activeSession.contextMode)?.label || activeSession.contextMode;
              const timeInfo = humanizeTime(activeSession.startedAt, 'relative');
              
              // Get last user message for preview
              const lastUserMessage = [...(activeSession.messages || [])].reverse().find(m => m.role === 'user');
              const preview = lastUserMessage?.content?.slice(0, 80);
              
              return (
                <div className="mt-4 rounded-xl border border-sophia-surface-border bg-sophia-bg/50 p-4">
                  {/* Ritual + Context */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-sophia-text">{ritualLabel}</span>
                    <span className="text-sophia-text2/50">·</span>
                    <span className="text-sm text-sophia-text2">{contextLabel}</span>
                    {activeSession.gameName && (
                      <>
                        <span className="text-sophia-text2/50">·</span>
                        <span className="text-sm text-sophia-purple">{activeSession.gameName}</span>
                      </>
                    )}
                  </div>
                  
                  {/* Time */}
                  <div className="mt-2 text-xs text-sophia-text2/70">
                    Started {timeInfo.text}
                    {activeSession.messages?.length ? ` · ${activeSession.messages.length} messages` : ''}
                  </div>
                  
                  {/* Preview of last message */}
                  {preview && (
                    <div className="mt-3 pt-3 border-t border-sophia-surface-border/50">
                      <p className="text-[11px] text-sophia-text2/60 uppercase tracking-wide mb-1">You said:</p>
                      <p className="text-xs text-sophia-text/80 italic line-clamp-2">
                        &quot;{preview}{preview.length >= 80 ? '…' : ''}&quot;
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Actions */}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  haptic('light');
                  setShowReplaceSessionConfirm(false);
                  setPendingStart(null);
                  router.push('/session');
                }}
                className={cn(
                  'flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition-all',
                  'bg-sophia-purple text-white hover:opacity-95',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
                )}
              >
                Continue Session
              </button>
              <button
                type="button"
                onClick={handleConfirmReplaceSession}
                className={cn(
                  'flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition-all',
                  'border border-sophia-surface-border bg-sophia-button hover:bg-sophia-button-hover',
                  'text-sophia-text2',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
                )}
              >
                Start Fresh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          EMOTION ATMOSPHERE: Canvas-based gradient wash driven by emotion band
          Renders behind all content (z-0)
          ========================================== */}
      <EmotionAtmosphereCanvas lastSessionEmotion={bootstrapOpener?.emotional_context?.last_emotion} />

      {/* ==========================================
          COSMIC BACKGROUND: Nebula + Starfield + Bloom + Vignette + Grain
          Premium atmospheric layer behind all UI
          ========================================== */}
      <DashboardCosmicBackground contextMode={contextMode} />
      
      {/* ==========================================
          MAIN LAYOUT CONTAINER
          ========================================== */}
      <div className="relative flex min-h-screen justify-center">
        
        {/* CENTER: Main Content */}
        <div className="flex-1 flex flex-col min-w-0 max-w-2xl">
          <div className="mx-auto px-6 py-8 w-full">
            
            {/* Header — logo opens settings drawer */}
            <div className="flex items-center justify-center mb-6">
              <button
                onClick={() => {
                  haptic('light');
                  setShowSettingsDrawer(true);
                }}
                className={cn(
                  'w-10 h-10 rounded-xl bg-sophia-purple text-white flex items-center justify-center text-lg font-bold shadow-lg',
                  'hover:scale-105 transition-transform duration-200',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                )}
                aria-label="Open menu"
              >
                S
              </button>
            </div>
            
            {/* Resume Banner - unified: shows for backend session OR local session-store */}
            {showResumeBanner && !isLaunchingSession && !isStartingSession && (backendActiveSession || sessionSummary) && (
              <div className="mb-4">
                <ResumeBanner
                  sessionType={(backendActiveSession?.session_type || sessionSummary?.sessionType || 'open') as PresetType}
                  contextMode={(backendActiveSession?.preset_context || activeSession?.contextMode || 'gaming') as 'gaming' | 'work' | 'life'}
                  startedAt={backendActiveSession?.started_at || sessionSummary?.startedAt || new Date().toISOString()}
                  messageCount={backendActiveSession?.turn_count || sessionSummary?.messageCount || 0}
                  lastMessagePreview={sessionSummary?.lastMessagePreview}
                  onResume={handleResumeBanner}
                  onStartFresh={handleStartFresh}
                  onDismiss={() => setShowResumeBanner(false)}
                />
              </div>
            )}
            
            {/* Voice-first title - changes based on context */}
            <div className="text-center mb-4">
              <h1 className="text-2xl font-bold text-sophia-text transition-all duration-300">
                {currentContext.title}
              </h1>
              {/* Dynamic subtitle - changes based on selected ritual or bootstrap */}
              <p 
                className="text-sm text-sophia-text2 mt-1.5 transition-all duration-200"
                aria-live="polite"
              >
                {selectedRitual === 'prepare' && 'Set your intention before you queue.'}
                {selectedRitual === 'debrief' && 'Cool down and learn from the session.'}
                {selectedRitual === 'reset' && 'Reset your tilt in under a minute.'}
                {selectedRitual === 'vent' && 'Let it out, then get steady.'}
                {!selectedRitual && (hasMeaningfulBootstrapOpener 
                  ? 'Tap a ritual or just call me.' 
                  : 'Pick a ritual or just talk — no pressure.'
                )}
              </p>
            </div>
            
            <p className="text-center text-[10px] text-sophia-text2/30 mb-6 uppercase tracking-widest font-medium">
              Rituals
            </p>
            
            {/* Context-Aware Layout: Cards + Mic */}
            <div className={cn(
              'relative mx-auto transition-all duration-700 ease-in-out',
              RADIAL_LAYOUT.containerClass,
            )}
            data-onboarding="ritual-grid"
            >
              
              {/* Ritual Cards - positioned by layout config (z-10) */}
              <RitualCard
                ritual={RITUALS[0]}
                context={contextMode}
                isSelected={selectedRitual === 'prepare'}
                hasSelection={selectedRitual !== null}
                onSelect={() => handleRitualSelect('prepare')}
                layoutStyle={RADIAL_LAYOUT.cards.prepare}
                isSuggested={bootstrapOpener?.suggested_ritual === 'prepare'}
                isPreparing={isStartingSession}
                compact
              />
              <RitualCard
                ritual={RITUALS[1]}
                context={contextMode}
                isSelected={selectedRitual === 'debrief'}
                hasSelection={selectedRitual !== null}
                onSelect={() => handleRitualSelect('debrief')}
                layoutStyle={RADIAL_LAYOUT.cards.debrief}
                isSuggested={bootstrapOpener?.suggested_ritual === 'debrief'}
                isPreparing={isStartingSession}
                compact
              />
              <RitualCard
                ritual={RITUALS[2]}
                context={contextMode}
                isSelected={selectedRitual === 'reset'}
                hasSelection={selectedRitual !== null}
                onSelect={() => handleRitualSelect('reset')}
                layoutStyle={RADIAL_LAYOUT.cards.reset}
                isSuggested={bootstrapOpener?.suggested_ritual === 'reset'}
                isPreparing={isStartingSession}
                compact
              />
              <RitualCard
                ritual={RITUALS[3]}
                context={contextMode}
                isSelected={selectedRitual === 'vent'}
                hasSelection={selectedRitual !== null}
                onSelect={() => handleRitualSelect('vent')}
                layoutStyle={RADIAL_LAYOUT.cards.vent}
                isSuggested={bootstrapOpener?.suggested_ritual === 'vent'}
                isPreparing={isStartingSession}
                compact
              />
              
              {/* Mic CTA - position adapts per context layout */}
              <div className={cn(
                'absolute inset-0 flex pointer-events-none transition-all duration-700',
                RADIAL_LAYOUT.micClass,
              )}>
                <div className="pointer-events-auto relative">
                  <MicCTA
                    selectedRitual={selectedRitual}
                    context={contextMode}
                    contextConfig={currentContext}
                    micState={micState}
                    isOffline={isOffline}
                    isConnecting={isConnecting}
                    isStartingSession={isStartingSession}
                    onCall={handleCallSophia}
                    onContinue={handleContinueSession}
                  />
                </div>
              </div>
            </div>
            
            {/* Context Mode Selector — below the ritual ring */}
            <div className="flex justify-center mt-4">
              <ContextTabs selected={contextMode} onSelect={setContextMode} />
            </div>

            {/* Smart opener preview — subtle hint below everything */}
            {hasMeaningfulBootstrapOpener && !showResumeBanner && (
              <p className="text-center text-sm text-sophia-text2/60 italic mt-4 max-w-md mx-auto animate-fadeIn">
                {bootstrapOpener?.opener_text}
              </p>
            )}
            
          </div>
        </div>
        
        {/* RIGHT SIDEBAR: History Drawer (desktop only) */}
        <div className="hidden lg:block flex-shrink-0 pt-8 pr-4">
          <button
            onClick={() => {
              haptic('light');
              setRightSidebarExpanded(!rightSidebarExpanded);
            }}
            className={cn(
              'flex items-center justify-center w-10 h-10 rounded-xl mb-4',
              'bg-sophia-surface border border-sophia-surface-border',
              'hover:border-sophia-purple/30 hover:scale-105',
              'transition-all duration-200 shadow-soft',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
            )}
            aria-label="Open history"
          >
            <Clock className="w-4 h-4 text-sophia-text2" />
          </button>
        </div>
        
        {/* History Drawer - opens when right sidebar toggle is clicked */}
        <Suspense fallback={null}>
          <HistoryDrawer
            isOpen={rightSidebarExpanded}
            onClose={() => setRightSidebarExpanded(false)}
            onConversationLoaded={handleConversationLoaded}
          />
        </Suspense>
      </div>
      
      {/* ==========================================
          MOBILE FLOATING BUTTONS
          ========================================== */}
      <MobileFloatingButtons
        onOpenHistory={() => setShowMobileHistory(true)}
      />
      
      {/* Mobile History uses full HistoryDrawer */}
      {showMobileHistory && (
        <Suspense fallback={null}>
          <HistoryDrawer
            isOpen={showMobileHistory}
            onClose={() => setShowMobileHistory(false)}
            onConversationLoaded={handleConversationLoaded}
          />
        </Suspense>
      )}
      
      {/* Settings Drawer — behind logo tap */}
      <SettingsDrawer
        isOpen={showSettingsDrawer}
        onClose={() => setShowSettingsDrawer(false)}
        onShowHistory={() => {
          setShowSettingsDrawer(false);
          setRightSidebarExpanded(true);
        }}
      />
      
    </div>
  );
}

export default VoiceFirstDashboard;
