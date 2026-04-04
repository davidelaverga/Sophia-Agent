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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SessionLayout } from '../components/SessionLayout';
import { OnboardingSessionExperience } from '../components/onboarding';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { 
  ArtifactsPanel, 
  ArtifactsRail,
  SessionConversationPane,
  VoiceFirstComposer,
  VoiceCaption,
  PresenceArtifactPanel,
  ArtifactToggleIcon,
  MobileDrawer,
  FeedbackToast,
  // BootstrapCards archived - dead code (see _archived_BootstrapCards.tsx)
  CompanionRail,
  DebriefOfferModal,
} from '../components/session';
import { SessionExpiredModal, MultiTabModal } from '../components/ui';
import {
  VoiceComposerErrorBoundary,
  ArtifactsPanelErrorBoundary,
} from '../components/error-boundaries';
import { ModeToggle } from '../components/ModeToggle';
import { useUiStore } from '../stores/ui-store';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { useSessionBootstrap } from '../hooks/useSessionBootstrap';
import { errorCopy } from '../lib/error-copy';
import { UsageLimitModal } from '../components/UsageLimitModal';
import { useSessionUiInteractions } from './useSessionUiInteractions';
import { useSessionCompanionIntegration } from './useSessionCompanionIntegration';
import { useSessionConversationArchive } from './useSessionConversationArchive';
import { useSessionVoiceCommandSystem } from './useSessionVoiceCommandSystem';
import { useSessionStreamPersistence } from './useSessionStreamPersistence';
import { SESSION_REFLECTION_PREFIX, useSessionReflectionVoiceFlow } from './useSessionReflectionVoiceFlow';
import { useSessionUiDerivedState } from './useSessionUiDerivedState';
import { useSessionInterruptRetryState } from './useSessionInterruptRetryState';
import { useSessionPageContext } from './useSessionPageContext';
import { useSessionPageGuards } from './useSessionPageGuards';
import { useSessionInteractionOrchestration } from './useSessionInteractionOrchestration';
import { useSessionInfrastructure } from './useSessionInfrastructure';
import { useSessionValidationState } from './useSessionValidationState';
import { useSessionInitializationOrchestration } from './useSessionInitializationOrchestration';
import { useSessionInterruptOrchestration } from './useSessionInterruptOrchestration';
import { useSessionQueueOrchestration } from './useSessionQueueOrchestration';
import { useSessionExitOrchestration } from './useSessionExitOrchestration';
import { useSessionPageLocalState } from './useSessionPageLocalState';
import { useSessionRouteExperience } from './useSessionRouteExperience';
import { debugLog } from '../lib/debug-logger';
import { getFirstRunStepById } from '../onboarding';
import { useOnboardingStore } from '../stores/onboarding-store';

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
      {showOnboardingSessionExperience ? <OnboardingSessionExperience /> : <SessionPageContent />}
    </ProtectedRoute>
  );
}

// ============================================================================
// MAIN SESSION PAGE CONTENT
// ============================================================================

function SessionPageContent() {
  const SHOW_SESSION_MEMORY_REJECT = false;
  const router = useRouter();
  const focusMode = useUiStore((s) => s.mode);
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
    detectedEmotion,
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
    activeInvoke,
    nudgeSuggestion,
    isInvoking,
    handleCompanionInvoke,
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
    showCompanionRail,
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
  const mobileIndicatorDotClass = hasPendingArtifacts
    ? 'bg-amber-500 animate-pulse'
    : readyArtifactCount > 0
      ? 'bg-emerald-500'
      : 'bg-white/20';

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
    showDebriefOffer,
    debriefData,
    isNavigatingToRecap,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
  } = useSessionExitOrchestration({
    isReadOnly,
    isSophiaResponding,
    stopStreaming,
    setEnding,
    sessionId,
    sessionStartedAt: session?.startedAt,
    sessionPresetType,
    sessionContextMode,
    messageCount: chatMessages.length,
    endSessionStore: endSession,
    clearSessionStore: clearSession,
    clearBootstrap,
    navigateTo: router.push,
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
    persistedSessionId: session?.sessionId,
    responseMode: exitProtectionResponseMode,
    messages,
    updateMessages,
    isEnding,
  });

  const {
    handleVoiceTranscript: _handleVoiceTranscript,
    isAssistantResponseSuppressed: _isAssistantResponseSuppressed,
  } = useSessionVoiceCommandSystem({
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
    handleToggleMobileArtifactsTab,
    handleToggleMobileDrawer,
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
    navigateTo: router.push,
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
    stopStreaming,
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
    navigateHome,
    clearSessionError,
    endSession,
    takeOverSession,
    artifacts,
    applyMemoryCandidates,
    isOffline,
    queueMemoryApproval,
    backendSessionIdForMemory: session?.sessionId,
  });
  
  // Loading state
  if (shouldShowLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#030308]">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
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
    >
      <div className="relative flex h-full animate-fadeIn">
        {/* Main Chat Area */}
        <div className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Conversation pane — hidden in voice mode but stays mounted to preserve scroll */}
          <div className={cn(focusMode !== 'text' && 'hidden', 'flex-1 flex flex-col min-h-0')}>
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
            onGoToDashboard={handleGoToDashboard}
          />
          </div>
          
          {/* Voice Caption — ephemeral text overlay in voice mode */}
          <VoiceCaption
            messages={messages}
            isVoiceMode={focusMode !== 'text'}
          />
          
          {/* Quick Actions rows removed – CompanionRail on left side now */}
          
          {/* Mode Toggle */}
          <div className="px-4 pt-2">
            <div className="max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto">
              <ModeToggle />
            </div>
          </div>
          
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
        
        {/* Desktop Artifacts Panel — replaced by PresenceArtifactPanel bottom-sheet */}
        <PresenceArtifactPanel
          artifacts={artifacts}
          isVisible={showArtifacts && showArtifactsUi}
          onDismiss={handleCloseArtifactsPanel}
          isVoiceMode={focusMode !== 'text'}
        />

        {/* Companion Rail – LEFT side (both mobile & desktop) */}
        {showCompanionRail && (
          <CompanionRail
            contextMode={sessionContextMode}
            onInvoke={handleCompanionInvoke}
            isInvoking={isInvoking}
            activeInvoke={activeInvoke}
            disabled={isTyping || isReadOnly}
            className={cn(
              'fixed left-0 top-1/2 -translate-y-1/2 z-30',
              'w-8 h-8 lg:w-10 lg:h-10',
              'rounded-r-lg',
              'cursor-pointer',
            )}
          />
        )}

        {/* Ghost toggle for text mode — reopens artifact panel when dismissed */}
        {focusMode === 'text' && !showArtifacts && showArtifactsUi && (
          <ArtifactToggleIcon
            hasArtifacts={!!(artifacts?.takeaway)}
            onClick={handleOpenArtifactsPanel}
          />
        )}
      </div>
      
      {/* Exit Confirmation Modal */}
      {showExitConfirm && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fadeIn"
          onClick={handleCancelExit}
        >
          <div 
            className="w-[90%] max-w-sm bg-[rgba(8,8,18,0.78)] backdrop-blur-[28px] rounded-2xl p-6 shadow-xl border border-white/[0.03] animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-12 h-12 rounded-full bg-white/[0.04] flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white/[0.08] border-t-white/30 rounded-full animate-spin" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-white/80">
                  Sophia is still responding
                </h3>
                <p className="text-sm text-white/40">
                  If you leave now, her response will be saved but may be incomplete.
                </p>
              </div>
              
              <div className="flex gap-3 w-full mt-2">
                <button
                  onClick={handleCancelExit}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-white/[0.04] border border-white/[0.06] text-white/60 font-medium transition-colors hover:bg-white/[0.08]"
                >
                  Stay
                </button>
                <button
                  onClick={handleEndSession}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-white/[0.08] text-white/70 font-medium transition-colors hover:bg-white/[0.12]"
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
      
      {/* Debrief Offer Modal */}
      <DebriefOfferModal
        isOpen={showDebriefOffer}
        debriefPrompt={debriefData?.prompt || ''}
        durationMinutes={debriefData?.durationMinutes || 0}
        takeaway={debriefData?.takeaway}
        onStartDebrief={handleStartDebrief}
        onSkipToRecap={handleSkipToRecap}
      />
      
      <UsageLimitModal
        open={limitModalOpen}
        onClose={closeLimitModal}
        info={limitInfo}
      />
    </SessionLayout>
  );
}
