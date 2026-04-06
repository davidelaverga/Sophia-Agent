/**
 * Session Page
 * Sprint 1+ - Enhanced with Feedback UI
 * 
 * Active ritual session view with:
 * - useChat() from AI SDK for streaming responses
 * - Voice-first composer with state machine
 * - Artifacts panel (right on desktop, drawer on mobile)
 * - Exit protection when Sophia is responding
 * - Message feedback (👍/👎) for learning loop
 * 
 * Auth flow: Discord Login → Consent Gate → Session (protected)
 */

'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  VoiceComposerErrorBoundary,
} from '../components/error-boundaries';
import { ModeToggle } from '../components/ModeToggle';
import { OnboardingSessionExperience } from '../components/onboarding';
import { PresenceField, type PresenceFieldHandle } from '../components/presence-field';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { 
  SessionConversationPane,
  VoiceFirstComposer,
  VoiceCaption,
  PresenceArtifactPanel,
  ArtifactToggleIcon,
  WhisperIndicator,
  ReflectionOverlay,
  EmergenceOverlay,
  AtmosphericFeedback,
  FeedbackToast,
} from '../components/session';
import { SessionLayout } from '../components/SessionLayout';
import { SessionExpiredModal, MultiTabModal } from '../components/ui';
import { UsageLimitModal } from '../components/UsageLimitModal';
import { useChromeFade } from '../hooks/useChromeFade';
import { haptic } from '../hooks/useHaptics';
import { useIdleTimeout } from '../hooks/useIdleTimeout';
import { useSessionBootstrap } from '../hooks/useSessionBootstrap';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { debugLog } from '../lib/debug-logger';
import { errorCopy } from '../lib/error-copy';
import { cn } from '../lib/utils';
import { getFirstRunStepById } from '../onboarding';
import { useOnboardingStore } from '../stores/onboarding-store';
import { useUiStore } from '../stores/ui-store';

import { useSessionCompanionIntegration } from './useSessionCompanionIntegration';
import { useSessionConversationArchive } from './useSessionConversationArchive';
import { useSessionExitOrchestration } from './useSessionExitOrchestration';
import { useSessionInfrastructure } from './useSessionInfrastructure';
import { useSessionInitializationOrchestration } from './useSessionInitializationOrchestration';
import { useSessionInteractionOrchestration } from './useSessionInteractionOrchestration';
import { useSessionInterruptOrchestration } from './useSessionInterruptOrchestration';
import { useSessionInterruptRetryState } from './useSessionInterruptRetryState';
import { useSessionPageContext } from './useSessionPageContext';
import { useSessionPageGuards } from './useSessionPageGuards';
import { useSessionPageLocalState } from './useSessionPageLocalState';
import { useSessionQueueOrchestration } from './useSessionQueueOrchestration';
import { SESSION_REFLECTION_PREFIX, useSessionReflectionVoiceFlow } from './useSessionReflectionVoiceFlow';
import { useSessionRouteExperience } from './useSessionRouteExperience';
import { useSessionStreamPersistence } from './useSessionStreamPersistence';
import { useSessionUiDerivedState } from './useSessionUiDerivedState';
import { useSessionUiInteractions } from './useSessionUiInteractions';
import { useSessionValidationState } from './useSessionValidationState';
import { useSessionVoiceCommandSystem } from './useSessionVoiceCommandSystem';

// ============================================================================
// PROTECTED SESSION PAGE WRAPPER
// ============================================================================

export default function SessionPage() {
  const firstRunStatus = useOnboardingStore((state) => state.firstRun.status);
  const currentStepId = useOnboardingStore((state) => state.currentStepId);
  const activeStep = getFirstRunStepById(currentStepId);
  const showOnboardingSessionExperience = firstRunStatus === 'in_progress' && activeStep?.route === '/session';

  return (
    <ProtectedRoute>
      {showOnboardingSessionExperience ? (
        <div className="relative h-screen bg-[var(--bg)]">
          <PresenceField />
          <div className="relative z-10 h-full">
            <OnboardingSessionExperience />
          </div>
        </div>
      ) : (
        <SessionPageContent />
      )}
    </ProtectedRoute>
  );
}

// ============================================================================
// MAIN SESSION PAGE CONTENT
// ============================================================================

function SessionPageContent() {
  const router = useRouter();
  const focusMode = useUiStore((s) => s.mode);
  const { chromeOpacity } = useChromeFade();
  const presenceRef = useRef<PresenceFieldHandle | null>(null);
  const handleImpulse = useCallback(() => {
    presenceRef.current?.fireImpulse('coreIntensity', 0.15, 1500);
  }, []);
  const handleDimPresence = useCallback(() => {
    // Dim nebula for emergence overlay (R19)
    presenceRef.current?.fireImpulse('coreIntensity', -0.3, 8000);
    presenceRef.current?.fireImpulse('flowEnergy', -0.2, 8000);
  }, []);
  const { isIdle, resetIdle } = useIdleTimeout();
  const debugEnabled = useMemo(() => {
    // 🔒 SECURITY: debug mode restricted to development only
    return process.env.NODE_ENV === 'development';
  }, []);
  const {
    setMessageMetadata,
    setCurrentContext,
    showToast,
    connectivityStatus,
    isOffline,
    queueMessage,
    getQueuedMessages,
    removeFromQueue,
    incrementRetry,
    queueMemoryApproval,
    getQueuedMemoryApprovals,
    removeMemoryApprovalFromQueue,
    incrementMemoryApprovalRetry,
    markOffline,
    recordConnectivityFailure,
    limitModalOpen,
    limitInfo,
    closeLimitModal,
    showUsageLimitModal,
    setFeedback,
    feedbackByMessage,
  } = useSessionInfrastructure();

  // Session persistence - handles automatic snapshot persistence on safe moments
  // This listens to event bus and persists on: done, send, mode change, beforeunload
  useSessionPersistence();
  
  // Bootstrap management - handles greeting/memory persistence and deduplication
  const {
    bootstrap,
    hasBootstrap,
    greetingRendered,
    markGreetingRendered,
    clearBootstrap,
  } = useSessionBootstrap();

  const {
    session,
    artifacts,
    storedMessages,
    updateMessages,
    updateSession,
    storeArtifacts,
    endSession,
    clearSession,
    setEnding,
    isEnding,
    sessionId,
    backendSessionId,
    hasValidBackendSessionId,
    userId,
    safeSessionId,
    sessionPresetType,
    sessionContextMode,
    isReadOnly,
    initialGreeting,
    greetingMessageId,
    greetingAnchorId,
    memoryHighlights,
    chatRequestBody,
  } = useSessionPageContext({
    bootstrapSessionId: bootstrap?.sessionId,
    bootstrapMessageId: bootstrap?.messageId,
    bootstrapMemoryHighlights: bootstrap?.memoryHighlights,
  });

  const {
    sessionExpired,
    sessionMultiTab,
    takeOverSession,
    clearSessionError,
  } = useSessionValidationState();

  const {
    hasShownReconnectRef,
    input,
    setInput,
    showArtifacts,
    setShowArtifacts,
    mobileDrawerOpen,
    setMobileDrawerOpen,
    userOpenedArtifacts,
    setUserOpenedArtifacts,
    justSent,
    setJustSent,
    showScaffold,
    setShowScaffold,
    dismissedError,
    setDismissedError,
    showFeedbackToast,
    setShowFeedbackToast,
    handleReconnectOnline,
  } = useSessionPageLocalState({
    sessionId: session?.sessionId,
  });

  const {
    cancelledMessageId,
    setCancelledMessageId,
    lastUserMessageId,
    setLastUserMessageId,
    lastUserMessageContent,
    setLastUserMessageContent,
    isInterruptedByRefresh,
    setIsInterruptedByRefresh,
    interruptedResponseMode,
    setInterruptedResponseMode,
    refreshInterruptedAt,
    setRefreshInterruptedAt,
    resumeError,
    resumeRetryOptionId,
    setInterruptSelectHandler,
    handleInterruptSelectWithRetry,
    handleResumeRetryPress,
    clearResumeError,
    handleResumeError,
  } = useSessionInterruptRetryState();

  const {
    artifactStatus,
    ingestArtifacts,
    applyMemoryCandidates,
    chatMessages,
    sendChatMessage,
    chatStatus,
    chatError,
    setChatMessages,
    stopStreaming,
    messages,
    latestAssistantMessage,
    setMessageTimestamp,
    setStreamInterruptHandler,
    sendMessage,
    voiceState,
    voiceStatus,
    isReflectionTtsActive,
    appendVoiceUserMessage,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
    voiceRetryState,
    handleVoiceRetryPress,
    handleDismissVoiceRetry,
    queueVoiceRetryFromCancel,
    baseHandleMicClick,
    setVoiceStatusCompat,
  } = useSessionRouteExperience({
    sessionId,
    activeSessionId: session?.sessionId,
    activeThreadId: session?.threadId,
    chatRequestBody,
    hasValidBackendSessionId,
    backendSessionId,
    userId,
    artifacts,
    storeArtifacts,
    updateSession,
    showUsageLimitModal,
    recordConnectivityFailure,
    showToast,
    setCurrentContext,
    setMessageMetadata,
    greetingAnchorId,
    markOffline,
    debugEnabled,
    memoryHighlightsCount: memoryHighlights?.length ?? 0,
  });

  const removeInternalDebriefTriggerBubble = useCallback((triggerText: string) => {
    setChatMessages((prev) => {
      const index = [...prev]
        .reverse()
        .findIndex((message) => {
          if (message.role !== 'user') return false;
          const text = message.parts
            .map((part) => {
              if (part && typeof part === 'object' && 'text' in part) {
                const textValue = (part as { text?: unknown }).text;
                return typeof textValue === 'string' ? textValue : '';
              }
              return '';
            })
            .join('')
            .trim();
          return text === triggerText;
        });

      if (index < 0) return prev;

      const targetIndex = prev.length - 1 - index;
      return prev.filter((_, messageIndex) => messageIndex !== targetIndex);
    });
  }, [setChatMessages]);

  const isStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
  const isTyping = isStreaming;
  
  const { isInitializingChat } = useSessionInitializationOrchestration({
    session,
    storedMessages,
    greeting: {
      initialGreeting,
      greetingMessageId,
      hasBootstrap,
      bootstrap,
      greetingRendered,
      markGreetingRendered,
    },
    context: {
      memoryHighlights,
      sessionPresetType,
      sessionContextMode,
    },
    chat: {
      setChatMessages,
      setMessageTimestamp,
    },
    retry: {
      setLastUserMessageId,
      setLastUserMessageContent,
      setCancelledMessageId,
      setIsInterruptedByRefresh,
      setInterruptedResponseMode,
      setRefreshInterruptedAt,
      hasShownReconnectRef,
    },
    showToast,
  });

  const {
    pendingInterrupt,
    interruptQueue,
    resolvedInterrupts,
    isResuming,
    handleInterruptSnooze,
    handleInterruptDismiss,
  } = useSessionInterruptOrchestration({
    sessionId,
    threadId: session?.threadId,
    sessionContextMode,
    sessionPresetType,
    artifacts,
    ingestArtifacts,
    setChatMessages,
    clearResumeError,
    handleResumeError,
    setInterruptSelectHandler,
    setStreamInterruptHandler,
    showToast,
    isTyping,
  });

  const {
    nudgeSuggestion,
    handleNudgeAccept,
    handleNudgeDismiss,
  } = useSessionCompanionIntegration({
    sessionThreadId: session?.threadId,
    sessionContextMode,
    sessionPresetType,
    chatMessageCount: chatMessages.length,
    messages,
    isTyping,
    isReadOnly,
    setMessageTimestamp,
    setChatMessages,
    ingestArtifacts,
  });

  useSessionStreamPersistence({
    messages,
    chatStatus,
    updateMessages,
  });

  useSessionConversationArchive({
    sessionId,
    messages,
  });
  
  // NOTE: Removed the interval-based persist - the above sync persist handles it

  useSessionQueueOrchestration({
    chatStatus,
    chatMessages,
    connectivityStatus,
    onReconnectOnline: handleReconnectOnline,
    sessionId,
    getQueuedMessages,
    getQueuedMemoryApprovals,
    sendMessage,
    removeFromQueue,
    incrementRetry,
    removeMemoryApprovalFromQueue,
    incrementMemoryApprovalRetry,
    setChatMessages,
    showToast,
  });

  const {
    isReflectionVoiceFlowActive,
    handleReflectionTap,
    getReflectionWhy,
  } = useSessionReflectionVoiceFlow({
    reflectionPrefix: SESSION_REFLECTION_PREFIX,
    messages,
    isStreaming,
    chatStatus,
    isTyping,
    voiceStatus,
    isReflectionTtsActive,
    speakText: voiceState.speakText,
    sendMessage,
    connectivityStatus,
    queueMessage,
    sessionId,
    setChatMessages,
    showToast,
  });

  const {
    showArtifactsUi,
    isSophiaResponding,
    exitProtectionResponseMode,
    isVoiceThinking,
    showThinkingIndicator,
    inputPlaceholder,
    presenceStatus,
  } = useSessionUiDerivedState({
    isTyping,
    messages,
    artifacts,
    isStreaming,
    isReflectionVoiceFlowActive,
    userOpenedArtifacts,
    voiceStatus,
    isReflectionTtsActive,
    sessionPresetType,
    sessionContextMode,
  });

  const [hasNewArtifacts, setHasNewArtifacts] = useState(false);
  const previousArtifactCountRef = useRef(0);
  const previousReadyCountRef = useRef(0);
  const previousArtifactSignatureRef = useRef('');

  const artifactContentCount = useMemo(() => {
    const hasTakeaway = Boolean(artifacts?.takeaway?.trim());
    const hasReflection = Boolean(artifacts?.reflection_candidate?.prompt?.trim());
    const memoryCount = artifacts?.memory_candidates?.length ?? 0;
    return (hasTakeaway ? 1 : 0) + (hasReflection ? 1 : 0) + Math.min(1, memoryCount);
  }, [artifacts]);

  const readyArtifactCount = useMemo(() => {
    return [artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories].filter(
      (status) => status === 'ready'
    ).length;
  }, [artifactStatus]);

  const waitingArtifactCount = useMemo(() => {
    return [artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories].filter(
      (status) => status === 'waiting'
    ).length;
  }, [artifactStatus]);

  const hasPendingArtifacts = useMemo(() => {
    return (
      artifactStatus.takeaway === 'capturing' ||
      artifactStatus.reflection === 'capturing' ||
      artifactStatus.memories === 'capturing'
    );
  }, [artifactStatus]);

  const artifactSignature = useMemo(() => {
    const takeaway = artifacts?.takeaway?.trim() ?? '';
    const reflection = artifacts?.reflection_candidate?.prompt?.trim() ?? '';
    const memories = (artifacts?.memory_candidates ?? [])
      .map((candidate) => candidate?.memory?.trim() ?? '')
      .filter((memory) => memory.length > 0)
      .join('|');

    return `${takeaway}::${reflection}::${memories}`;
  }, [artifacts]);

  const hasDesktopStyleBadge = hasPendingArtifacts || waitingArtifactCount > 0;

  useEffect(() => {
    const previousCount = previousArtifactCountRef.current;
    const previousReady = previousReadyCountRef.current;
    const previousSignature = previousArtifactSignatureRef.current;

    const countIncreased = artifactContentCount > previousCount;
    const readyIncreasedWithContent = readyArtifactCount > previousReady && artifactContentCount > 0;
    const contentChangedWithArtifacts = artifactContentCount > 0 && artifactSignature !== previousSignature;
    const generationStarted =
      previousReady === 0 &&
      previousCount === 0 &&
      hasPendingArtifacts;

    if (!userOpenedArtifacts && (countIncreased || readyIncreasedWithContent || contentChangedWithArtifacts || generationStarted)) {
      setHasNewArtifacts(true);
    }

    previousArtifactCountRef.current = artifactContentCount;
    previousReadyCountRef.current = readyArtifactCount;
    previousArtifactSignatureRef.current = artifactSignature;
  }, [artifactContentCount, readyArtifactCount, hasPendingArtifacts, artifactSignature, userOpenedArtifacts]);

  useEffect(() => {
    if (showArtifacts || mobileDrawerOpen || userOpenedArtifacts) {
      setHasNewArtifacts(false);
    }
  }, [showArtifacts, mobileDrawerOpen, userOpenedArtifacts]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobileViewport = window.matchMedia('(max-width: 1023px)').matches;
    debugLog('ArtifactsFlow', 'mobile indicator mount', {
      isMobileViewport,
    });
  }, []);

  useEffect(() => {
    debugLog('ArtifactsFlow', 'mobile indicator props/state', {
      showArtifactsUi,
      hasNewArtifacts,
      hasPendingArtifacts,
      readyArtifactCount,
      waitingArtifactCount,
      hasDesktopStyleBadge,
      artifactContentCount,
      mobileDrawerOpen,
      userOpenedArtifacts,
    });
  }, [
    showArtifactsUi,
    hasNewArtifacts,
    hasPendingArtifacts,
    readyArtifactCount,
    waitingArtifactCount,
    hasDesktopStyleBadge,
    artifactContentCount,
    mobileDrawerOpen,
    userOpenedArtifacts,
  ]);
  
  const {
    showExitConfirm,
    showEmergence,
    showFeedback,
    isNavigatingToRecap,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleEmergenceComplete,
    handleFeedbackComplete,
  } = useSessionExitOrchestration({
    isReadOnly,
    isSophiaResponding,
    stopStreaming: () => {
      void stopStreaming();
    },
    setEnding,
    sessionId,
    sessionStartedAt: session?.startedAt,
    sessionPresetType,
    sessionContextMode,
    messageCount: chatMessages.length,
    endSessionStore: endSession,
    clearSessionStore: clearSession,
    clearBootstrap,
    navigateTo: (href) => {
      void router.push(href);
    },
    promoteToDebriefMode: () => {
      updateSession({
        presetType: 'debrief',
        status: 'active',
        isActive: true,
        endedAt: undefined,
      });
    },
    startDebriefWithLLM: (debriefData: {
      prompt: string;
      durationMinutes: number;
      takeaway?: string;
      sessionId: string;
    }) => {
      if (!hasValidBackendSessionId) return;

      const debriefTrigger = [
        'Debrief mode is now active for the session that just ended.',
        `Duration: ${debriefData.durationMinutes} minutes.`,
        debriefData.takeaway ? `Session takeaway: ${debriefData.takeaway}` : null,
        `Debrief prompt to follow: ${debriefData.prompt}`,
        'Start directly with one reflective debrief question.',
        'Do not use pre-game framing, hype, or readiness language.',
      ].filter(Boolean).join(' ');

      const debriefBody = {
        ...(chatRequestBody ?? {}),
        session_id: safeSessionId ?? backendSessionId,
        user_id: userId,
        session_type: 'debrief',
        context_mode: sessionContextMode,
      };

      void sendChatMessage(
        { text: debriefTrigger },
        { body: debriefBody },
      );

      setTimeout(() => removeInternalDebriefTriggerBubble(debriefTrigger), 0);
      setTimeout(() => removeInternalDebriefTriggerBubble(debriefTrigger), 180);
    },
    currentArtifacts: artifacts,
    userId,
    threadId: session?.threadId,
    persistedSessionId: session?.sessionId,
    responseMode: exitProtectionResponseMode,
    messages,
    updateMessages,
    isEnding,
  });

  useSessionVoiceCommandSystem({
    onUserTranscript: appendVoiceUserMessage,
    reflectionCandidate: artifacts?.reflection_candidate,
    handleReflectionTap,
    pendingInterrupt,
    isResuming,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
    isEnding,
    isReadOnly,
    handleVoiceEndSession,
    voiceState,
    showToast,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
  });

  const {
    messagesEndRef,
    inputRef,
    composerFocusToken,
    handleMicClick,
    focusComposer,
    handleCloseArtifactsPanel,
    handleOpenArtifactsPanel,
  } = useSessionUiInteractions({
    messages,
    isTyping,
    isReadOnly,
    showArtifacts,
    showArtifactsUi,
    mobileDrawerOpen,
    setShowArtifacts,
    setMobileDrawerOpen,
    setUserOpenedArtifacts,
    setShowScaffold,
    triggerLightHaptic: () => haptic('light'),
    onBaseMicClick: baseHandleMicClick,
  });
  
  const { shouldShowLoading, navigateHome } = useSessionPageGuards({
    hasSession: !!session,
    isEnding,
    isNavigatingToRecap,
    navigateTo: (href) => {
      void router.push(href);
    },
  });

  const {
    handleSubmit,
    handleCancelThinking,
    handleDismissCancelled,
    handleCancelledRetryPress,
    handlePromptSelect,
    handleMessageFeedback,
    handleStreamErrorRetry,
    handleDismissStreamError,
    handleGoToDashboard,
    handleFeedbackToastClose,
    handleSessionExpiredRetry,
    handleSessionExpiredGoHome,
    handleMultiTabGoHome,
    handleMultiTabTakeOver,
    handleMemoryApprove,
    handleMemoryReject,
  } = useSessionInteractionOrchestration({
    input,
    setInput,
    isTyping,
    isReadOnly,
    sendMessage,
    connectivityStatus,
    queueMessage,
    sessionId,
    chatMessagesLength: chatMessages.length,
    setChatMessages,
    showToast,
    voiceStatus,
    setVoiceStatus: setVoiceStatusCompat,
    setShowScaffold,
    setJustSent,
    setDismissedError,
    setLastUserMessageContent,
    setCancelledMessageId,
    stopStreaming: () => {
      void stopStreaming();
    },
    voiceState,
    queueVoiceRetryFromCancel,
    cancelledRetryMessage: errorCopy.responseCancelled,
    lastUserMessageContent,
    isInterruptedByRefresh,
    hasValidBackendSessionId,
    backendSessionId,
    refreshInterruptedAt,
    cancelledMessageId,
    lastUserMessageId,
    chatMessages,
    setLastUserMessageId,
    setIsInterruptedByRefresh,
    setInterruptedResponseMode,
    setRefreshInterruptedAt,
    setMessageTimestamp,
    interruptedResponseMode,
    sessionVoiceMode: session?.voiceMode,
    latestAssistantMessage,
    setFeedback,
    setShowFeedbackToast,
    focusComposer,
    messages,
    navigateHome: () => {
      void navigateHome();
    },
    clearSessionError,
    endSession: () => {
      void endSession();
    },
    takeOverSession: () => {
      void takeOverSession();
    },
    artifacts,
    applyMemoryCandidates,
    isOffline,
    queueMemoryApproval,
    backendSessionIdForMemory: session?.sessionId,
  });
  
  // Loading state — the breathing nebula IS the loading indicator (R41)
  if (shouldShowLoading) {
    return (
      <div className="h-screen bg-[var(--bg)]">
        <PresenceField />
      </div>
    );
  }
  
  // ============================================================================
  // RENDER
  // ============================================================================
  
  return (
    <SessionLayout
      store={session}
      onEndSession={handleEndSession}
      isEnding={isEnding}
      isSophiaResponding={isSophiaResponding}
      isReadOnly={isReadOnly}
      presenceRef={presenceRef}
    >
      <div className="relative flex h-full animate-fadeIn">
        {/* Main Chat Area */}
        <div className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Reading corridor — calms the nebula behind text so messages are effortless to read.
              A radial vignette that darkens the center (where text lives) and fades to
              transparent at the edges, letting the cosmic field breathe through. */}
          {focusMode === 'text' && (
            <div
              className="cosmic-reading-corridor absolute inset-0 z-0 pointer-events-none"
            />
          )}

          {/* Conversation pane — hidden in voice mode but stays mounted to preserve scroll */}
          <div className={focusMode !== 'text' ? 'hidden' : 'flex-1 flex flex-col min-h-0'}>
            <SessionConversationPane
            messages={messages}
            isInitializingChat={isInitializingChat}
            sessionPresetType={sessionPresetType}
            sessionContextMode={sessionContextMode}
            onPromptSelect={handlePromptSelect}
            reflectionPrefix={SESSION_REFLECTION_PREFIX}
            getReflectionWhy={getReflectionWhy}
            feedbackByMessage={feedbackByMessage}
            onFeedback={handleMessageFeedback}
            greetingAnchorId={greetingAnchorId}
            memoryHighlights={memoryHighlights}
            resolvedInterrupts={resolvedInterrupts}
            pendingInterrupt={pendingInterrupt}
            isTyping={isTyping}
            isReadOnly={isReadOnly}
            onInterruptSelectWithRetry={handleInterruptSelectWithRetry}
            onInterruptSnooze={handleInterruptSnooze}
            onInterruptDismiss={handleInterruptDismiss}
            isResuming={isResuming}
            resumeError={resumeError}
            resumeRetryOptionId={resumeRetryOptionId}
            onResumeRetry={handleResumeRetryPress}
            onDismissResumeError={clearResumeError}
            interruptQueueLength={interruptQueue.length}
            showScaffold={showScaffold}
            showThinkingIndicator={showThinkingIndicator}
            isVoiceThinking={isVoiceThinking}
            onCancelThinking={handleCancelThinking}
            cancelledMessageId={cancelledMessageId}
            cancelledRetryMessage={isInterruptedByRefresh ? errorCopy.responseInterrupted : errorCopy.responseCancelled}
            onRetryCancelled={handleCancelledRetryPress}
            onDismissCancelled={handleDismissCancelled}
            voiceRetryState={voiceRetryState}
            onRetryVoice={handleVoiceRetryPress}
            onDismissVoiceRetry={handleDismissVoiceRetry}
            chatError={chatError}
            dismissedError={dismissedError}
            onRetryStreamError={handleStreamErrorRetry}
            onDismissStreamError={handleDismissStreamError}
            messagesEndRef={messagesEndRef}
            nudgeSuggestion={nudgeSuggestion}
            onNudgeAccept={handleNudgeAccept}
            onNudgeDismiss={handleNudgeDismiss}
            onImpulse={handleImpulse}
            onGoToDashboard={handleGoToDashboard}
          />
          </div>
          
          {/* Voice Caption — ephemeral text overlay in voice mode */}
          <VoiceCaption
            messages={messages}
            isVoiceMode={focusMode !== 'text'}
          />
          
          {/* Whisper Indicator — atmospheric presence label */}
          <WhisperIndicator opacity={chromeOpacity} />

          {/* Reflection Overlay — center-screen atmospheric prompt (voice mode) */}
          {focusMode !== 'text' && (
            <ReflectionOverlay
              question={isReflectionVoiceFlowActive ? (artifacts?.reflection_candidate?.prompt ?? null) : null}
              onDismiss={() => {
                const prompt = artifacts?.reflection_candidate?.prompt;
                if (prompt) void handleReflectionTap({ prompt }, 'tap');
              }}
              onActivate={() => presenceRef.current?.fireImpulse('flowEnergy', 0.12, 2000)}
            />
          )}
          
          {/* Mode Toggle — whisper-style voice/text switcher */}
          <div
            className={cn(
              'flex justify-center',
              focusMode !== 'text'
                ? 'fixed bottom-[100px] left-1/2 -translate-x-1/2 z-30'
                : 'pt-2'
            )}
            style={{ opacity: chromeOpacity, transition: 'opacity 0.6s ease' }}
          >
            <ModeToggle opacity={chromeOpacity} />
          </div>
          
          {/* Inline Artifact Panel — text mode: above composer, voice mode: floating above mic */}
          {focusMode === 'text' && showArtifacts && showArtifactsUi && (
            <PresenceArtifactPanel
              artifacts={artifacts}
              isVisible={showArtifacts && showArtifactsUi}
              onDismiss={handleCloseArtifactsPanel}
              isVoiceMode={false}
              onReflectionTap={handleReflectionTap ? (r) => handleReflectionTap(r, 'tap') : undefined}
              onMemoryApprove={handleMemoryApprove}
              onMemoryReject={handleMemoryReject}
            />
          )}

          {/* Artifact toggle pill — centered above composer when dismissed in text mode */}
          {focusMode === 'text' && !showArtifacts && showArtifactsUi && (
            <div className="flex justify-center mb-2">
              <ArtifactToggleIcon
                hasArtifacts={!!(artifacts?.takeaway)}
                onClick={handleOpenArtifactsPanel}
              />
            </div>
          )}
          
          {/* Voice-First Composer */}
          <VoiceComposerErrorBoundary>
            <VoiceFirstComposer
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onMicClick={handleMicClick}
              placeholder={isReadOnly ? 'Read-only session' : inputPlaceholder}
              disabled={isTyping || isReadOnly}
              inputRef={inputRef}
              justSent={justSent}
              voiceStatus={voiceStatus}
              isTyping={isTyping}
              statusText={isReadOnly ? 'Read-only session' : presenceStatus}
              isOffline={isOffline}
              isConnecting={connectivityStatus === 'checking'}
              focusRequestToken={composerFocusToken}
              textOnly={focusMode === 'text'}
            />
          </VoiceComposerErrorBoundary>
        </div>
        
        {/* Voice mode: Floating artifact panel above mic */}
        {focusMode !== 'text' && (
          <PresenceArtifactPanel
            artifacts={artifacts}
            isVisible={showArtifacts && showArtifactsUi}
            onDismiss={handleCloseArtifactsPanel}
            isVoiceMode={true}
            onReflectionTap={handleReflectionTap ? (r) => handleReflectionTap(r, 'tap') : undefined}
            onMemoryApprove={handleMemoryApprove}
            onMemoryReject={handleMemoryReject}
          />
        )}
      </div>
      
      {/* Exit Confirmation Modal */}
      {showExitConfirm && (
        <div 
          className="cosmic-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center animate-fadeIn"
          onClick={handleCancelExit}
        >
          <div 
            className="cosmic-surface-panel-strong w-[90%] max-w-sm rounded-2xl p-6 animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--cosmic-panel-soft)' }}>
                <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: 'var(--cosmic-border-soft)', borderTopColor: 'var(--cosmic-text-whisper)' }} />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-lg font-semibold" style={{ color: 'var(--cosmic-text-strong)' }}>
                  Sophia is still responding
                </h3>
                <p className="text-sm" style={{ color: 'var(--cosmic-text-muted)' }}>
                  If you leave now, her response will be saved but may be incomplete.
                </p>
              </div>
              
              <div className="flex gap-3 w-full mt-2">
                <button
                  onClick={handleCancelExit}
                  className="cosmic-ghost-pill cosmic-focus-ring flex-1 rounded-xl px-4 py-2.5 font-medium transition-colors"
                >
                  Stay
                </button>
                <button
                  onClick={handleEndSession}
                  className="cosmic-accent-pill cosmic-focus-ring flex-1 rounded-xl px-4 py-2.5 font-medium transition-colors"
                >
                  Leave anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Feedback Toast */}
      {showFeedbackToast && (
        <FeedbackToast
          feedback={showFeedbackToast}
          onClose={handleFeedbackToastClose}
        />
      )}

      {/* Emergence Overlay — staggered session summary (R18-R19) */}
      <EmergenceOverlay
        artifacts={artifacts}
        isVisible={showEmergence}
        onComplete={handleEmergenceComplete}
        onDimPresence={handleDimPresence}
      />

      {/* Atmospheric Feedback — session-level rating (R20, R29) */}
      <AtmosphericFeedback
        sessionId={sessionId}
        isVisible={showFeedback}
        onComplete={handleFeedbackComplete}
      />

      {/* Idle Timeout Whisper Overlay */}
      {isIdle && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center animate-fadeIn"
          style={{ backgroundColor: 'var(--cosmic-modal-backdrop)' }}
        >
          <div className="text-center space-y-4">
            <p className="font-cormorant italic text-[18px]" style={{ color: 'var(--cosmic-text-muted)' }}>
              still there?
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => resetIdle()}
                className="cosmic-accent-pill cosmic-focus-ring rounded-full px-4 py-1.5 text-[11px] tracking-[0.08em] uppercase transition-all"
              >
                I&apos;m here
              </button>
              <button
                onClick={() => { resetIdle(); void handleEndSession(); }}
                className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-4 py-1.5 text-[11px] tracking-[0.08em] uppercase transition-all"
              >
                end session
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Session Expired Modal */}
      <SessionExpiredModal
        isOpen={sessionExpired}
        onRetry={handleSessionExpiredRetry}
        onGoHome={handleSessionExpiredGoHome}
      />
      
      {/* Multi-Tab Conflict Modal */}
      <MultiTabModal
        isOpen={sessionMultiTab}
        onGoHome={handleMultiTabGoHome}
        onTakeOver={handleMultiTabTakeOver}
      />
      
      {/* DebriefOfferModal removed — R34: debrief offered conversationally */}
      
      <UsageLimitModal
        open={limitModalOpen}
        onClose={closeLimitModal}
        info={limitInfo}
      />
    </SessionLayout>
  );
}
