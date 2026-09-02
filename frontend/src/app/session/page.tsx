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

import { Paperclip } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentBar, type AttachmentPickerRef } from '../components/chat/AttachmentBar';
import {
  VoiceComposerErrorBoundary,
} from '../components/error-boundaries';
import { ModeToggle } from '../components/ModeToggle';
import { PresenceField, type PresenceFieldHandle } from '../components/presence-field';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { 
  SessionConversationPane,
  VoiceFirstComposer,
  VoiceCaption,
  VoiceMetricsPanel,
  PresenceArtifactPanel,
  SessionArtifactTrayLauncher,
  WhisperIndicator,
  ReflectionOverlay,
  EmergenceOverlay,
  DebriefOfferModal,
  FeedbackToast,
} from '../components/session';
import {
  BuilderCompletionCard,
  getBuilderCompletionFallbackBody,
  getBuilderCompletionFallbackLabel,
} from '../components/session/BuilderCompletionCard';
import {
  exactActiveArtifactMatchesBuilderCompletion,
  recordSyntheticBuilderCanvasProjection,
} from '../lib/synthetic-builder-evidence';
import { BuilderTaskNotice } from '../components/session/BuilderTaskNotice';
import { SessionLayout } from '../components/SessionLayout';
import { SessionExpiredModal, MultiTabModal } from '../components/ui';
import { UsageLimitModal } from '../components/UsageLimitModal';
import { useChromeFade } from '../hooks/useChromeFade';
import { haptic } from '../hooks/useHaptics';
import { useIdleTimeout } from '../hooks/useIdleTimeout';
import { useSessionBootstrap } from '../hooks/useSessionBootstrap';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import {
  ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION,
  clearArtifactCanvasOpenState,
  hashArtifactCanvasRestoreIdentity,
  persistArtifactCanvasOpenState,
  restoreArtifactCanvasOpenState,
  type ArtifactCanvasRestoreContext,
} from '../lib/artifact-canvas-restore-state';
import {
  clearArtifactLibraryOpenHandoff,
  peekArtifactLibraryOpenHandoff,
} from '../lib/artifact-library-open-handoff';
import { isArtifactRegistryLibraryVisibleCandidate } from '../lib/artifact-registry';
import { detectArtifactRendererKind, type ArtifactRendererKind } from '../lib/artifact-renderers';
import type { ArtifactReviewVoiceCommandRouter } from '../lib/artifact-review-voice-commands';
import { buildArtifactHref, buildThreadArtifactHref, getBuilderArtifactFiles, normalizeBuilderArtifactPath } from '../lib/builder-artifacts';
import { GeminiStillFrameTransport } from '../lib/co-review-still-frame-transport';
import {
  coreviewFeedbackSuppressedTelemetryPayload,
  coreviewFeedbackTelemetryPayload,
  dedupeCoreviewActionFeedback,
  type CoreviewActionFeedback,
} from '../lib/coreview-action-feedback';
import { buildCoreviewArtifactStableIdentity } from '../lib/coreview-artifact-identity';
import type {
  CoreviewArtifactUpdateContext,
  CoreviewArtifactUpdateMode,
  CoreviewBuilderCancelAdapterResult,
  CoreviewBuilderStartAdapterResult,
  CoreviewBuilderTaskStatus,
} from '../lib/coreview-builder-actions';
import { debugLog } from '../lib/debug-logger';
import { errorCopy } from '../lib/error-copy';
import {
  loadArtifactSessionIndex,
  openArtifactInSessionIndex,
  registerArtifactInSessionIndex,
  type ArtifactRecord,
  type ArtifactRegisterSource,
  type ArtifactSessionIndexContext,
  type RegisterArtifactInput,
} from '../lib/session-artifact-index';
import { recordSophiaCaptureEvent } from '../lib/session-capture';
import { useVoiceLabControlAdapter } from '../hooks/useVoiceLabControlAdapter';
import { cn } from '../lib/utils';
import { useUiStore } from '../stores/ui-store';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';

import { findBuilderTaskArtifactRecord } from './builderArtifactRecovery';
import { resolveBuilderSurface } from './builderSurfaceArbitration';
import { suppressSessionLeaveGuardForCoreviewBuilderUpdate } from './session-annotation-navigation-guard';
import { useSessionBuilderArtifactLibrary } from './useSessionBuilderArtifactLibrary';
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

const MISSING_BUILDER_DELIVERABLE_ERROR = 'Builder finished without a deliverable artifact.';
const MISSING_BUILDER_DELIVERABLE_RETRY_MESSAGE = `${MISSING_BUILDER_DELIVERABLE_ERROR} Please try again.`;
const COREVIEW_ARTIFACT_UPDATE_SURFACE_RECENT_MS = 60_000;

type CoreviewArtifactUpdateSurfaceClaim = {
  artifactPath: string | null;
  artifactStableIdentity: string | null;
  rendererKind: string | null;
  requestedAt: number;
  taskId: string | null;
  runId: string | null;
};

function normalizedBuilderPathsEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeBuilderArtifactPath(left);
  const normalizedRight = normalizeBuilderArtifactPath(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function builderCompletionMatchesCoreviewClaim(
  completion: BuilderCompletionEventV1 | null | undefined,
  claim: CoreviewArtifactUpdateSurfaceClaim | null,
): boolean {
  if (!completion || claim?.rendererKind !== 'html') {
    return false;
  }
  if (normalizedBuilderPathsEqual(completion.revision_of_artifact_path, claim.artifactPath)) {
    return true;
  }
  if (normalizedBuilderPathsEqual(completion.source_artifact_path, claim.artifactPath)) {
    return true;
  }
  if (claim.taskId && completion.task_id === claim.taskId) {
    return true;
  }
  if (claim.runId && completion.run_id === claim.runId) {
    return true;
  }
  return false;
}

type BuilderLibraryBaseline = {
  taskId: string;
  runId: string | null;
  items: Set<string>;
};

function builderLibraryItemSignature(item: { path: string; modifiedAt?: string | null; sizeBytes?: number | null }) {
  return `${item.path}:${item.modifiedAt ?? ''}:${item.sizeBytes ?? ''}`;
}

function builderRunMatches(left: string | null | undefined, right: string | null | undefined) {
  return !left || !right || left === right;
}

// ============================================================================
// PROTECTED SESSION PAGE WRAPPER
// ============================================================================

export default function SessionPage() {
  return (
    <ProtectedRoute>
      <SessionPageContent />
    </ProtectedRoute>
  );
}

// ============================================================================
// MAIN SESSION PAGE CONTENT
// ============================================================================

/**
 * Composer-aligned attach button rendered into ``VoiceFirstComposer``'s
 * ``slotLeftAction`` slot so the paperclip shares a horizontal baseline
 * with the Send button (B4 of the silent-attach fix, 2026-05-28).
 *
 * Extracted into its own component so ``SessionPageContent``'s CC
 * stays under Sentrux's CC ≥ 16 threshold — adding the conditional
 * + JSX inline pushed the count over.
 */
function ComposerAttachButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Attach a file"
      title="Attach a file"
      data-testid="composer-attach-button"
      className="cosmic-focus-ring shrink-0 self-end rounded-2xl p-2.5 transition-all duration-200 hover:bg-sophia-purple/10 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ color: 'var(--cosmic-text-whisper)' }}
    >
      <Paperclip className="w-4 h-4" />
    </button>
  );
}

function getBuilderArtifactFilename(path: string): string {
  return path.split('/').filter(Boolean).pop() || 'Builder deliverable';
}

function isRegistryBackedSessionArtifact(artifact: ArtifactRecord | null | undefined): boolean {
  if (!artifact) {
    return false;
  }
  return (
    artifact.storageProvider !== 'local'
    || Boolean(artifact.storageObjectPath || artifact.contentUrl || artifact.downloadUrl)
    || !artifact.artifactId.startsWith('artifact:')
  );
}

type SessionArtifactRegisterMetadata = Partial<Omit<RegisterArtifactInput, 'context' | 'localPath'>> & {
  source?: ArtifactRegisterSource;
};

function inferSessionArtifactType(
  path: string,
  rendererKind: ArtifactRendererKind,
  artifactType?: string | null,
): string {
  if (artifactType?.trim()) {
    return artifactType.trim();
  }
  if (rendererKind === 'html') return 'webpage';
  if (rendererKind === 'pdf') return 'pdf';
  if (rendererKind === 'image') return 'visual_report';
  if (rendererKind === 'markdown') return 'document';
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ppt', 'pptx'].includes(extension)) return 'presentation';
  if (['csv', 'json', 'xls', 'xlsx'].includes(extension)) return 'data_analysis';
  return 'document';
}

function inferSessionArtifactRendererKind({
  path,
  title,
  mimeType,
  artifactType,
}: {
  path: string;
  title?: string | null;
  mimeType?: string | null;
  artifactType?: string | null;
}): ArtifactRendererKind {
  return detectArtifactRendererKind(
    {
      path,
      name: title ?? getBuilderArtifactFilename(path),
      ...(mimeType ? { mimeType } : {}),
    },
    artifactType ? { artifactType } : null,
  );
}

function SessionPageContent() {
  const router = useRouter();
  const focusMode = useUiStore((s) => s.mode);
  const setFocusMode = useUiStore((s) => s.setMode);
  const setFocusModeManualOverride = useUiStore((s) => s.setManualOverride);
  const { chromeOpacity } = useChromeFade();
  const presenceRef = useRef<PresenceFieldHandle | null>(null);
  // Mutable function ref shared between the AttachmentBar (which owns
  // the hidden file input and populates this with its openPicker
  // callback) and the Composer's slotLeftAction button (which calls
  // it on click). B4 of the silent-attach fix (2026-05-28) — keeps
  // the paperclip on the same horizontal baseline as the Send button.
  const attachmentPickerRef = useRef<(() => void) | null>(null) as AttachmentPickerRef;
  const handleOpenAttachPicker = useCallback(() => {
    attachmentPickerRef.current?.();
  }, []);
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
    builderArtifact: storedBuilderArtifact,
    storedMessages,
    updateMessages,
    updateSession,
    storeArtifacts,
    storeBuilderArtifact,
    endSession,
    clearSession,
    setEnding,
    isEnding,
    sessionId,
    backendSessionId,
    hasValidBackendSessionId,
    userId,
    resolvedThreadId,
    safeSessionId,
    sessionPresetType,
    sessionContextMode,
    isReadOnly,
    initialGreeting,
    greetingMessageId,
    greetingAnchorId,
    memoryHighlights,
    chatRequestBody,
    hasUploadsInFlight,
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

  const [selectedBuilderArtifactPath, setSelectedBuilderArtifactPath] = useState<string | null>(null);
  const [pendingBuilderArtifactReview, setPendingBuilderArtifactReview] = useState(false);
  const [coreviewArtifactUpdateSurfaceClaim, setCoreviewArtifactUpdateSurfaceClaim] = useState<CoreviewArtifactUpdateSurfaceClaim | null>(null);

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
    builderArtifact,
    builderTask,
    clearBuilderTask,
    clearBuilderArtifact,
    cancelBuilderTask,
    isCancellingBuilderTask,
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
    appendVoiceAssistantMessage,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
    voiceRetryState,
    handleVoiceRetryPress,
    handleDismissVoiceRetry,
    queueVoiceRetryFromCancel,
    baseHandleMicClick,
    setVoiceStatusCompat,
    // PR-B: completion-card surface
    builderCompletion,
    builderCanvasEvents,
    handleBuilderRetry,
    handleBuilderCompletionDismiss,
  } = useSessionRouteExperience({
    sessionId,
    activeSessionId: session?.sessionId,
    activeThreadId: resolvedThreadId,
    chatRequestBody,
    hasValidBackendSessionId,
    backendSessionId,
    userId,
    artifacts,
    storedBuilderArtifact,
    storeArtifacts,
    storeBuilderArtifact,
    updateSession,
    showUsageLimitModal,
    recordConnectivityFailure,
    showToast,
    setCurrentContext,
    setMessageMetadata,
    greetingAnchorId,
    sessionVoiceMode: session?.voiceMode,
    markOffline,
    debugEnabled,
    memoryHighlightsCount: memoryHighlights?.length ?? 0,
    artifactReviewActive: showArtifacts && Boolean(selectedBuilderArtifactPath || storedBuilderArtifact),
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
    threadId: resolvedThreadId,
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
    sessionThreadId: resolvedThreadId,
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

  const { flushSessionTranscript, getSessionTranscriptRevision } = useSessionStreamPersistence({
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

  const [artifactLibraryRefreshNonce, setArtifactLibraryRefreshNonce] = useState(0);
  const [builderLibraryBaseline, setBuilderLibraryBaseline] = useState<BuilderLibraryBaseline | null>(null);
  const [dismissedBuilderLibraryPath, setDismissedBuilderLibraryPath] = useState<string | null>(null);

  const builderArtifactRefreshToken = useMemo(() => [
    builderArtifact?.artifactTitle ?? '',
    builderArtifact?.artifactPath ?? '',
    (builderArtifact?.supportingFiles ?? []).join('|'),
    builderTask?.taskId ?? '',
    builderTask?.runId ?? '',
    builderTask?.phase ?? '',
    builderCompletion?.task_id ?? '',
    builderCompletion?.run_id ?? '',
    artifactLibraryRefreshNonce,
  ].join('::'), [artifactLibraryRefreshNonce, builderArtifact, builderCompletion?.run_id, builderCompletion?.task_id, builderTask?.phase, builderTask?.runId, builderTask?.taskId]);

  const {
    items: builderArtifactLibrary,
  } = useSessionBuilderArtifactLibrary({
    threadId: resolvedThreadId,
    refreshToken: builderArtifactRefreshToken,
    pollIntervalMs: builderTask?.phase === 'running' ? 5000 : null,
    refreshOnFocus: true,
  });

  const hasBuilderArtifactLibrary = builderArtifactLibrary.length > 0;
  const hasSelectedBuilderArtifactPath = Boolean(selectedBuilderArtifactPath);
  const coReviewSessionId = backendSessionId || safeSessionId || sessionId || null;
  const sessionArtifactIndexContext = useMemo<ArtifactSessionIndexContext>(() => ({
    userId: userId ?? null,
    threadId: resolvedThreadId ?? null,
    sessionId: coReviewSessionId,
    parentThreadId: resolvedThreadId ?? null,
  }), [coReviewSessionId, resolvedThreadId, userId]);
  const sessionArtifactIndexContextSignature = useMemo(() => [
    sessionArtifactIndexContext.userId ?? 'unknown',
    sessionArtifactIndexContext.threadId ?? 'unknown',
    sessionArtifactIndexContext.sessionId ?? 'unknown',
  ].join('|'), [sessionArtifactIndexContext]);
  const [sessionArtifactIndex, setSessionArtifactIndex] = useState(() => (
    loadArtifactSessionIndex(sessionArtifactIndexContext)
  ));
  const sessionArtifactIndexDedupedCountRef = useRef(0);
  const sessionArtifactIndexRestoreCountRef = useRef(0);
  const artifactRegistryBackfillKeysRef = useRef(new Set<string>());
  const canvasRestoreContext = useMemo<ArtifactCanvasRestoreContext>(() => ({
    userId: userId ?? null,
    threadId: resolvedThreadId ?? null,
    sessionId: coReviewSessionId,
  }), [coReviewSessionId, resolvedThreadId, userId]);
  const canvasRestoreContextSignature = useMemo(() => [
    canvasRestoreContext.userId ?? 'unknown',
    canvasRestoreContext.threadId ?? 'unknown',
    canvasRestoreContext.sessionId ?? 'unknown',
  ].join('|'), [canvasRestoreContext]);
  const coReviewVoiceAgentSessionId = voiceState.runtimeTelemetry.runtime === 'gemini_live'
    ? voiceState.runtimeTelemetry.sessionId
    : voiceState.runtimeTelemetry.voiceAgentSessionId;
  const artifactPanelThreadId = resolvedThreadId || undefined;
  const coReviewTransport = useMemo(
    () => new GeminiStillFrameTransport({
      sendArtifactFrame: voiceState.sendArtifactFrame,
      getStatus: voiceState.getArtifactFrameTransportStatus,
    }),
    [voiceState.getArtifactFrameTransportStatus, voiceState.sendArtifactFrame],
  );
  const artifactReviewVoiceCommandRouterRef = useRef<ArtifactReviewVoiceCommandRouter | null>(null);
  const coreviewActionFeedbackDedupeRef = useRef(new Set<string>());
  const handleArtifactReviewVoiceCommandRouteChange = useCallback((handler: ArtifactReviewVoiceCommandRouter | null) => {
    artifactReviewVoiceCommandRouterRef.current = handler;
  }, []);
  const routeArtifactReviewVoiceCommand = useCallback<ArtifactReviewVoiceCommandRouter>((text) => (
    artifactReviewVoiceCommandRouterRef.current?.(text) ?? { handled: false }
  ), []);
  const handleCoreviewActionFeedback = useCallback((feedback: CoreviewActionFeedback) => {
    const deduped = dedupeCoreviewActionFeedback(feedback, coreviewActionFeedbackDedupeRef.current);
    if (deduped.suppressed) {
      recordSophiaCaptureEvent({
        category: 'voice-session',
        name: 'coreview-action-feedback',
        payload: coreviewFeedbackSuppressedTelemetryPayload(feedback, deduped.suppressedCount),
      });
      return;
    }

    const nextFeedback = deduped.feedback;
    if (!nextFeedback) {
      return;
    }

    const transcript = nextFeedback.shouldSpeak
      ? nextFeedback.spokenMessage ?? nextFeedback.displayMessage
      : nextFeedback.displayMessage;
    if (nextFeedback.shouldShowToastOrCard || nextFeedback.shouldSpeak) {
      appendVoiceAssistantMessage(transcript, false);
    }

    const shouldAttemptAudio = nextFeedback.shouldSpeak && Boolean(nextFeedback.spokenMessage);
    if (!shouldAttemptAudio) {
      recordSophiaCaptureEvent({
        category: 'voice-session',
        name: 'coreview-action-feedback',
        payload: coreviewFeedbackTelemetryPayload(nextFeedback, {
          spoken: false,
          audioAttempted: false,
          audioResult: 'not_attempted',
        }),
      });
      return;
    }

    void voiceState.speakText(nextFeedback.spokenMessage ?? nextFeedback.displayMessage)
      .then((spoken) => {
        recordSophiaCaptureEvent({
          category: 'voice-session',
          name: 'coreview-action-feedback',
          payload: coreviewFeedbackTelemetryPayload(nextFeedback, {
            spoken,
            audioAttempted: true,
            audioResult: spoken ? 'spoken' : 'unavailable',
            voiceAudioAckUnavailable: !spoken,
          }),
        });
      })
      .catch(() => {
        recordSophiaCaptureEvent({
          category: 'voice-session',
          name: 'coreview-action-feedback',
          payload: coreviewFeedbackTelemetryPayload(nextFeedback, {
            spoken: false,
            audioAttempted: true,
            audioResult: 'failed',
            voiceAudioAckUnavailable: true,
          }),
        });
      });
  }, [appendVoiceAssistantMessage, voiceState]);
  const handleCoreviewBuilderUpdateRequest = useCallback(async ({
    context,
    prompt,
    updateMode,
  }: {
    context: CoreviewArtifactUpdateContext;
    prompt: string;
    updateMode: CoreviewArtifactUpdateMode;
  }): Promise<CoreviewBuilderStartAdapterResult> => {
    suppressSessionLeaveGuardForCoreviewBuilderUpdate();
    setCoreviewArtifactUpdateSurfaceClaim({
      artifactPath: normalizeBuilderArtifactPath(context.artifactPath),
      artifactStableIdentity: context.artifactStableIdentity ?? null,
      rendererKind: context.rendererKind,
      requestedAt: Date.now(),
      taskId: builderTask?.taskId ?? null,
      runId: builderTask?.runId ?? null,
    });
    await sendMessage({ text: prompt });
    return {
      ok: true,
      taskId: builderTask?.taskId ?? null,
      runId: builderTask?.runId ?? null,
      userFacingMessage: updateMode === 'revise_version'
        ? `Sophia is preparing a new version of ${context.artifactTitle ?? 'this artifact'}.`
        : `Sophia is updating ${context.artifactTitle ?? 'this artifact'}.`,
    };
  }, [builderTask?.runId, builderTask?.taskId, sendMessage]);
  const handleCoreviewBuilderCancelRequest = useCallback(async ({
    task,
  }: {
    context: CoreviewArtifactUpdateContext | null;
    task: CoreviewBuilderTaskStatus;
  }): Promise<CoreviewBuilderCancelAdapterResult> => {
    suppressSessionLeaveGuardForCoreviewBuilderUpdate();
    if (!task.taskId || task.phase !== 'running') {
      return {
        ok: false,
        taskId: task.taskId,
        runId: task.runId,
        status: task.phase,
        blockedReason: 'no_active_builder_task',
        userFacingMessage: "I don't see an active artifact update right now.",
      };
    }
    const response = await cancelBuilderTask();
    if (!response) {
      return {
        ok: false,
        taskId: task.taskId,
        runId: task.runId,
        status: 'idle',
        blockedReason: 'no_active_builder_task',
        userFacingMessage: "I don't see an active artifact update right now.",
      };
    }
    const status = response.status ?? 'cancelled';
    return {
      ok: status !== 'failed',
      taskId: response.task_id ?? task.taskId,
      runId: response.run_id ?? task.runId,
      status,
      blockedReason: status === 'failed' ? 'builder_cancel_failed' : null,
      userFacingMessage: response.detail ?? (status === 'cancelled'
        ? 'The artifact update was cancelled.'
      : 'Builder cancellation was requested.'),
    };
  }, [cancelBuilderTask]);
  useEffect(() => {
    if (!coreviewArtifactUpdateSurfaceClaim || !builderTask) {
      return;
    }
    const nextTaskId = builderTask.taskId ?? null;
    const nextRunId = builderTask.runId ?? null;
    if (coreviewArtifactUpdateSurfaceClaim.taskId === nextTaskId && coreviewArtifactUpdateSurfaceClaim.runId === nextRunId) {
      return;
    }
    if (
      (coreviewArtifactUpdateSurfaceClaim.taskId && coreviewArtifactUpdateSurfaceClaim.taskId !== nextTaskId)
      || (coreviewArtifactUpdateSurfaceClaim.runId && nextRunId && coreviewArtifactUpdateSurfaceClaim.runId !== nextRunId)
    ) {
      return;
    }
    setCoreviewArtifactUpdateSurfaceClaim((current) => current
      ? {
          ...current,
          taskId: current.taskId ?? nextTaskId,
          runId: current.runId ?? nextRunId,
        }
      : current);
  }, [builderTask, coreviewArtifactUpdateSurfaceClaim]);
  const builderArtifactLibraryRef = useRef(builderArtifactLibrary);

  useEffect(() => {
    builderArtifactLibraryRef.current = builderArtifactLibrary;
  }, [builderArtifactLibrary]);

  useEffect(() => {
    if (!builderTask?.taskId) {
      setBuilderLibraryBaseline(null);
      return;
    }

    if (builderTask.phase !== 'running') {
      setBuilderLibraryBaseline((current) => {
        if (
          current?.taskId === builderTask.taskId
          && builderRunMatches(current.runId, builderTask.runId)
        ) {
          return current;
        }
        return null;
      });
      return;
    }

    setBuilderLibraryBaseline(
      {
        taskId: builderTask.taskId,
        runId: builderTask.runId ?? null,
        items: new Set(builderArtifactLibraryRef.current.map(builderLibraryItemSignature)),
      },
    );
  }, [builderTask?.phase, builderTask?.runId, builderTask?.taskId]);

  useEffect(() => {
    if (builderTask?.taskId || builderCompletion?.task_id) {
      setArtifactLibraryRefreshNonce((value) => value + 1);
    }
  }, [builderCompletion?.run_id, builderCompletion?.task_id, builderTask?.phase, builderTask?.runId, builderTask?.taskId]);

  useEffect(() => {
    if (chatStatus === 'ready') {
      setArtifactLibraryRefreshNonce((value) => value + 1);
    }
  }, [chatStatus]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = () => {
      setArtifactLibraryRefreshNonce((value) => value + 1);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  const {
    hasArtifactsContent,
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
    builderArtifact,
    hasBuilderArtifactLibrary: hasBuilderArtifactLibrary || hasSelectedBuilderArtifactPath,
    isBuilderRunning: builderTask?.phase === 'running',
    isStreaming,
    isReflectionVoiceFlowActive,
    userOpenedArtifacts,
    voiceStatus,
    isReflectionTtsActive,
    sessionPresetType,
    sessionContextMode,
  });

  const voiceReadinessStatusText = useMemo(() => {
    if (focusMode === 'text' || voiceState.runtimeTelemetry.runtime !== 'gemini_live') {
      return presenceStatus;
    }

    switch (voiceState.runtimeTelemetry.reviewTranscriptPromotionBlockedReason) {
      case 'provider_transcript_not_surfaced':
        return 'Voice transcript is delayed';
      case 'voice_input_detected_waiting_for_transcript':
        return 'Voice input detected, waiting for transcript';
      default:
        return presenceStatus;
    }
  }, [focusMode, presenceStatus, voiceState.runtimeTelemetry]);

  const [hasNewArtifacts, setHasNewArtifacts] = useState(false);
  const [, setIsVoiceCaptionVisible] = useState(false);
  const previousArtifactCountRef = useRef(0);
  const previousReadyCountRef = useRef(0);
  const previousArtifactSignatureRef = useRef('');
  const previousBuilderSurfaceTelemetrySignatureRef = useRef('');
  const sessionArtifactTrayTelemetrySignatureRef = useRef('');
  const canvasRestoreAttemptedContextRef = useRef<string | null>(null);
  const canvasRestoreClosedByUserRef = useRef(false);

  const artifactContentCount = useMemo(() => {
    const hasBuilderArtifact = Boolean(builderArtifact) || hasBuilderArtifactLibrary || hasSelectedBuilderArtifactPath;
    const hasTakeaway = Boolean(artifacts?.takeaway?.trim());
    const hasReflection = Boolean(artifacts?.reflection_candidate?.prompt?.trim());
    const memoryCount = artifacts?.memory_candidates?.length ?? 0;
    return (hasBuilderArtifact ? 1 : 0) + (hasTakeaway ? 1 : 0) + (hasReflection ? 1 : 0) + Math.min(1, memoryCount);
  }, [artifacts, builderArtifact, hasBuilderArtifactLibrary, hasSelectedBuilderArtifactPath]);

  const readyArtifactCount = useMemo(() => {
    return [artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories].filter(
      (status) => status === 'ready'
    ).length + ((builderArtifact || hasBuilderArtifactLibrary || hasSelectedBuilderArtifactPath) ? 1 : 0);
  }, [artifactStatus, builderArtifact, hasBuilderArtifactLibrary, hasSelectedBuilderArtifactPath]);

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
    const builder = builderArtifact
      ? [
          builderArtifact.artifactTitle,
          builderArtifact.artifactPath ?? '',
          (builderArtifact.supportingFiles ?? []).join('|'),
        ].join('::')
      : '';
    const takeaway = artifacts?.takeaway?.trim() ?? '';
    const reflection = artifacts?.reflection_candidate?.prompt?.trim() ?? '';
    const memories = (artifacts?.memory_candidates ?? [])
      .map((candidate) => candidate?.memory?.trim() ?? '')
      .filter((memory) => memory.length > 0)
      .join('|');
    const library = builderArtifactLibrary.map((item) => item.path).join('|');

    return `${builder}::${library}::${selectedBuilderArtifactPath ?? ''}::${takeaway}::${reflection}::${memories}`;
  }, [artifacts, builderArtifact, builderArtifactLibrary, selectedBuilderArtifactPath]);

  const hasDesktopStyleBadge = hasPendingArtifacts || waitingArtifactCount > 0;
  const recoveredBuilderLibraryItem = useMemo(() => {
    if (!builderLibraryBaseline) {
      return null;
    }
    const matchesBuilderTask = Boolean(
      builderTask?.taskId === builderLibraryBaseline.taskId
      && builderRunMatches(builderLibraryBaseline.runId, builderTask.runId),
    );
    const matchesBuilderCompletion = Boolean(
      builderCompletion?.task_id === builderLibraryBaseline.taskId
      && builderRunMatches(builderLibraryBaseline.runId, builderCompletion.run_id),
    );
    if (!matchesBuilderTask && !matchesBuilderCompletion) {
      return null;
    }
    const newItems = builderArtifactLibrary.filter((item) => (
      !builderLibraryBaseline.items.has(builderLibraryItemSignature(item))
    ));
    // The completion event names the requested primary deliverable — prefer it
    // over any render-source/preview sibling uploaded in the same run.
    const completionFilename = builderCompletion?.artifact_filename?.trim().toLowerCase();
    if (completionFilename) {
      const completionMatch = newItems.find((item) => item.name.toLowerCase() === completionFilename);
      if (completionMatch) {
        return completionMatch;
      }
    }
    return newItems[0] ?? null;
  }, [
    builderArtifactLibrary,
    builderCompletion?.artifact_filename,
    builderCompletion?.run_id,
    builderCompletion?.task_id,
    builderLibraryBaseline,
    builderTask?.runId,
    builderTask?.taskId,
  ]);
  const builderArtifactPrimaryFile = useMemo(
    () => getBuilderArtifactFiles(builderArtifact)[0] ?? null,
    [builderArtifact],
  );
  const recoveredBuilderSessionArtifact = useMemo(
    () => findBuilderTaskArtifactRecord(sessionArtifactIndex.artifacts, builderTask),
    [builderTask, sessionArtifactIndex.artifacts],
  );
  const recoveredBuilderSessionFile = useMemo(() => {
    const path = normalizeBuilderArtifactPath(recoveredBuilderSessionArtifact?.localPath);
    if (!path || !recoveredBuilderSessionArtifact) {
      return null;
    }
    const name = recoveredBuilderSessionArtifact.filename
      ?? getBuilderArtifactFilename(path);
    return {
      path,
      name,
      label: recoveredBuilderSessionArtifact.title || name,
      isPrimary: true,
      ...(recoveredBuilderSessionArtifact.mimeType
        ? { mimeType: recoveredBuilderSessionArtifact.mimeType }
        : {}),
    };
  }, [recoveredBuilderSessionArtifact]);
  const isBuilderActivelyRunning = (
    builderTask?.phase === 'running'
    && !recoveredBuilderSessionArtifact
  );
  const builderLibraryPrimaryFile = useMemo(
    () => recoveredBuilderLibraryItem ?? (!isBuilderActivelyRunning ? builderArtifactLibrary[0] : null) ?? null,
    [builderArtifactLibrary, isBuilderActivelyRunning, recoveredBuilderLibraryItem],
  );
  const selectedBuilderPrimaryFile = useMemo(() => {
    if (!selectedBuilderArtifactPath) {
      return null;
    }
    const name = getBuilderArtifactFilename(selectedBuilderArtifactPath);
    return {
      path: selectedBuilderArtifactPath,
      name,
      label: name,
      isPrimary: true,
    };
  }, [selectedBuilderArtifactPath]);
  const builderPrimaryFile = useMemo(() => {
    if (recoveredBuilderSessionFile) {
      return recoveredBuilderSessionFile;
    }
    if (builderArtifactPrimaryFile) {
      return builderArtifactPrimaryFile;
    }
    if (builderLibraryPrimaryFile) {
      return {
        path: builderLibraryPrimaryFile.path,
        name: builderLibraryPrimaryFile.name,
        label: builderLibraryPrimaryFile.name,
        isPrimary: true,
      };
    }
    return selectedBuilderPrimaryFile;
  }, [
    builderArtifactPrimaryFile,
    builderLibraryPrimaryFile,
    recoveredBuilderSessionFile,
    selectedBuilderPrimaryFile,
  ]);
  const builderCompletionRecoveryFile = recoveredBuilderLibraryItem
    ? {
        path: recoveredBuilderLibraryItem.path,
        name: recoveredBuilderLibraryItem.name,
        label: recoveredBuilderLibraryItem.name,
        isPrimary: true,
      }
    : null;
  const hasRecoveredBuilderArtifact = Boolean(
    recoveredBuilderLibraryItem || recoveredBuilderSessionArtifact,
  );
  const showBuilderTaskNotice = Boolean(builderTask) && !hasRecoveredBuilderArtifact;
  const builderReadyTitle = recoveredBuilderSessionArtifact?.title
    ?? builderArtifact?.artifactTitle
    ?? builderPrimaryFile?.name
    ?? 'Builder deliverable';
  const builderPrimarySessionRecord = useMemo(() => {
    const normalizedPath = normalizeBuilderArtifactPath(builderPrimaryFile?.path);
    if (!normalizedPath) {
      return null;
    }
    return sessionArtifactIndex.artifacts.find((artifact) => (
      normalizeBuilderArtifactPath(artifact.localPath) === normalizedPath
    )) ?? null;
  }, [builderPrimaryFile?.path, sessionArtifactIndex.artifacts]);
  const builderOpenHref = useMemo(
    () => buildArtifactHref({
      threadId: resolvedThreadId,
      artifactPath: builderPrimaryFile?.path,
      artifactId: builderPrimarySessionRecord?.artifactId ?? null,
      contentUrl: builderPrimarySessionRecord?.contentUrl ?? null,
      downloadUrl: builderPrimarySessionRecord?.downloadUrl ?? null,
      preferArtifactId: isRegistryBackedSessionArtifact(builderPrimarySessionRecord),
    }),
    [builderPrimaryFile?.path, builderPrimarySessionRecord, resolvedThreadId],
  );
  const builderDownloadHref = useMemo(
    () => buildArtifactHref({
      threadId: resolvedThreadId,
      artifactPath: builderPrimaryFile?.path,
      artifactId: builderPrimarySessionRecord?.artifactId ?? null,
      contentUrl: builderPrimarySessionRecord?.contentUrl ?? null,
      downloadUrl: builderPrimarySessionRecord?.downloadUrl ?? null,
      preferArtifactId: isRegistryBackedSessionArtifact(builderPrimarySessionRecord),
    }, { download: true }),
    [builderPrimaryFile?.path, builderPrimarySessionRecord, resolvedThreadId],
  );
  const resolveBuilderCanvasArtifactForPath = useCallback((path: string | null | undefined) => {
    const normalizedPath = normalizeBuilderArtifactPath(path);
    if (!normalizedPath || !resolvedThreadId) {
      return null;
    }

    const builderFile = getBuilderArtifactFiles(builderArtifact).find((file) => (
      normalizeBuilderArtifactPath(file.path) === normalizedPath
    )) ?? null;
    const libraryItem = builderArtifactLibrary.find((item) => (
      normalizeBuilderArtifactPath(item.path) === normalizedPath
    )) ?? null;
    const name = libraryItem?.name ?? builderFile?.name ?? getBuilderArtifactFilename(normalizedPath);
    const file = {
      path: normalizedPath,
      name,
      label: name,
      isPrimary: true,
      ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
      ...(typeof libraryItem?.sizeBytes === 'number' ? { sizeBytes: libraryItem.sizeBytes } : {}),
    };
    const rendererArtifact = builderFile && builderArtifact
      ? builderArtifact
      : {
          artifactPath: normalizedPath,
          artifactTitle: name,
          artifactType: 'document',
          decisionsMade: [],
          supportingFiles: [],
        };
    const rendererKind = detectArtifactRendererKind(file, rendererArtifact);
    const openHref = buildThreadArtifactHref(resolvedThreadId, normalizedPath);
    if (!openHref) {
      return null;
    }

    return {
      normalizedPath,
      rendererKind,
      openHref,
    };
  }, [builderArtifact, builderArtifactLibrary, resolvedThreadId]);
  const recordCanvasRestoreTelemetry = useCallback((payload: {
    attempted: boolean;
    result: string;
    source: string;
    artifactPath?: string | null;
    artifactIdentityHash?: string | null;
    storageKeyHash?: string | null;
  }) => {
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'artifact-canvas-restore',
      payload: {
        canvasRestoreAttempted: payload.attempted,
        canvasRestoreResult: payload.result,
        canvasRestoreSource: payload.source,
        canvasRestoredArtifactIdentityHash: payload.artifactIdentityHash ?? null,
        canvasRestoreStorageKeyHash: payload.storageKeyHash ?? null,
        canvasRestoreStorageVersion: ARTIFACT_CANVAS_RESTORE_STORAGE_VERSION,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    });
  }, []);
  useEffect(() => {
    const restored = loadArtifactSessionIndex(sessionArtifactIndexContext);
    setSessionArtifactIndex(restored);
    if (restored.artifacts.length > 0) {
      sessionArtifactIndexRestoreCountRef.current += 1;
      recordSophiaCaptureEvent({
        category: 'artifacts-runtime',
        name: 'session-artifact-index-restore',
        payload: {
          sessionArtifactIndexEnabled: true,
          sessionArtifactIndexRestoreCount: sessionArtifactIndexRestoreCountRef.current,
          sessionArtifactIndexArtifactCount: restored.artifacts.length,
          sessionArtifactIndexActiveArtifactPresent: Boolean(restored.activeArtifactId),
          sessionArtifactVersionCount: restored.artifacts.filter((artifact) => (
            artifact.logicalArtifactId === restored.artifacts.find((candidate) => candidate.artifactId === restored.activeArtifactId)?.logicalArtifactId
          )).length || 0,
          rawArtifactContentExcluded: true,
          rawArtifactTextExcluded: true,
          rawCommentTextExcluded: true,
          rawFrameExcluded: true,
        },
      });
    }
  }, [sessionArtifactIndexContext, sessionArtifactIndexContextSignature]);

  const recordSessionArtifactIndexTelemetry = useCallback((payload: Record<string, unknown>) => {
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'session-artifact-index',
      payload: {
        sessionArtifactIndexEnabled: true,
        rawArtifactContentExcluded: true,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
        ...payload,
      },
    });
  }, []);

  useEffect(() => {
    if (!sessionArtifactIndexContext.userId || !sessionArtifactIndexContext.threadId) {
      return;
    }
    for (const artifact of sessionArtifactIndex.artifacts) {
      const normalizedPath = normalizeBuilderArtifactPath(artifact.localPath);
      if (!normalizedPath) {
        continue;
      }
      if (!isArtifactRegistryLibraryVisibleCandidate({
        localPath: normalizedPath,
        title: artifact.title,
        artifactType: artifact.artifactType,
        rendererKind: artifact.rendererKind,
      })) {
        continue;
      }
      const key = [
        artifact.artifactId,
        artifact.versionId,
        artifact.updatedAt,
      ].join('|');
      if (artifactRegistryBackfillKeysRef.current.has(key)) {
        continue;
      }
      artifactRegistryBackfillKeysRef.current.add(key);
      void fetch('/api/artifacts/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: sessionArtifactIndexContext.userId,
          thread_id: artifact.threadId,
          session_id: artifact.sessionId ?? sessionArtifactIndexContext.sessionId ?? null,
          parent_thread_id: artifact.parentThreadId ?? null,
          task_id: artifact.taskId ?? null,
          run_id: artifact.runId ?? null,
          artifact_id: artifact.artifactId,
          logical_artifact_id: artifact.logicalArtifactId,
          version_id: artifact.versionId,
          parent_version_id: artifact.parentVersionId ?? null,
          title: artifact.title,
          artifact_type: artifact.artifactType,
          renderer_kind: artifact.rendererKind,
          mime_type: artifact.mimeType ?? null,
          safe_summary: artifact.safeSummary ?? null,
          source: 'file_library_backfill',
          local_path: normalizedPath,
          storage_provider: artifact.storageProvider,
          storage_bucket: artifact.storageBucket ?? null,
          storage_object_path: artifact.storageObjectPath ?? null,
          content_hash: artifact.contentHash ?? null,
          storage_status: artifact.review?.missing ? 'missing' : 'available',
          created_at: artifact.createdAt,
          updated_at: artifact.updatedAt,
          raw_content_excluded: true,
          signed_url_excluded: true,
        }),
      }).catch(() => {
        artifactRegistryBackfillKeysRef.current.delete(key);
      });
    }
  }, [
    sessionArtifactIndex.artifacts,
    sessionArtifactIndexContext.sessionId,
    sessionArtifactIndexContext.threadId,
    sessionArtifactIndexContext.userId,
  ]);

  const registerSessionArtifact = useCallback((
    localPath: string | null | undefined,
    metadata: SessionArtifactRegisterMetadata = {},
  ): ArtifactRecord | null => {
    const normalizedPath = normalizeBuilderArtifactPath(localPath);
    if (!normalizedPath) {
      return null;
    }
    const rendererKind = metadata.rendererKind ?? inferSessionArtifactRendererKind({
      path: normalizedPath,
      title: metadata.title,
      mimeType: metadata.mimeType,
      artifactType: metadata.artifactType,
    });
    const result = registerArtifactInSessionIndex({
      ...metadata,
      context: sessionArtifactIndexContext,
      localPath: normalizedPath,
      rendererKind,
      artifactType: inferSessionArtifactType(normalizedPath, rendererKind, metadata.artifactType),
      source: metadata.source ?? 'manual',
    });
    if (result.deduped) {
      sessionArtifactIndexDedupedCountRef.current += 1;
    }
    setSessionArtifactIndex(result.index);
    recordSessionArtifactIndexTelemetry({
      sessionArtifactIndexRegisterSource: metadata.source ?? 'manual',
      sessionArtifactIndexArtifactCount: result.index.artifacts.length,
      sessionArtifactIndexActiveArtifactPresent: Boolean(result.index.activeArtifactId),
      sessionArtifactIndexDedupedCount: sessionArtifactIndexDedupedCountRef.current,
      sessionArtifactVersionCount: result.record
        ? result.index.artifacts.filter((artifact) => artifact.logicalArtifactId === result.record?.logicalArtifactId).length
        : 0,
      sessionArtifactIndexRegisterResult: result.result,
    });
    return result.record;
  }, [recordSessionArtifactIndexTelemetry, sessionArtifactIndexContext]);

  const registerSessionArtifactByPath = useCallback((
    path: string | null | undefined,
    metadata: SessionArtifactRegisterMetadata = {},
  ): ArtifactRecord | null => {
    const normalizedPath = normalizeBuilderArtifactPath(path);
    if (!normalizedPath) {
      return null;
    }
    const builderFiles = getBuilderArtifactFiles(builderArtifact);
    const builderFile = builderFiles.find((file) => (
      normalizeBuilderArtifactPath(file.path) === normalizedPath
    )) ?? null;
    const libraryItem = builderArtifactLibrary.find((item) => (
      normalizeBuilderArtifactPath(item.path) === normalizedPath
    )) ?? null;
    const title = metadata.title
      ?? (builderFile?.isPrimary ? builderArtifact?.artifactTitle : builderFile?.label)
      ?? libraryItem?.name
      ?? getBuilderArtifactFilename(normalizedPath);
    const mimeType = metadata.mimeType ?? libraryItem?.mimeType ?? null;
    const artifactType = metadata.artifactType ?? builderArtifact?.artifactType ?? null;
    const rendererKind = metadata.rendererKind ?? inferSessionArtifactRendererKind({
      path: normalizedPath,
      title,
      mimeType,
      artifactType,
    });
    return registerSessionArtifact(normalizedPath, {
      ...metadata,
      title,
      mimeType,
      artifactType: inferSessionArtifactType(normalizedPath, rendererKind, artifactType),
      rendererKind,
    });
  }, [builderArtifact, builderArtifactLibrary, registerSessionArtifact]);

  const openSessionArtifactRecord = useCallback((
    artifactIdOrPath: string | null | undefined,
    source: string,
  ): ArtifactRecord | null => {
    const result = openArtifactInSessionIndex(sessionArtifactIndexContext, artifactIdOrPath);
    setSessionArtifactIndex(result.index);
    recordSessionArtifactIndexTelemetry({
      sessionArtifactOpenAttempted: true,
      sessionArtifactOpenResult: result.result,
      sessionArtifactOpenRendererKind: result.record?.rendererKind ?? null,
      sessionArtifactIndexActiveArtifactPresent: Boolean(result.index.activeArtifactId),
      sessionArtifactIndexArtifactCount: result.index.artifacts.length,
      sessionArtifactOpenSource: source,
      sessionArtifactVersionCount: result.record
        ? result.index.artifacts.filter((artifact) => artifact.logicalArtifactId === result.record?.logicalArtifactId).length
        : 0,
    });
    return result.record;
  }, [recordSessionArtifactIndexTelemetry, sessionArtifactIndexContext]);
  const persistSelectedBuilderCanvasState = useCallback((path: string | null | undefined, source: string) => {
    const artifact = resolveBuilderCanvasArtifactForPath(path);
    if (!artifact) {
      recordCanvasRestoreTelemetry({
        attempted: false,
        result: 'invalid_artifact',
        source,
        artifactPath: normalizeBuilderArtifactPath(path),
      });
      return null;
    }

    const result = persistArtifactCanvasOpenState(canvasRestoreContext, {
      artifactPath: artifact.normalizedPath,
      rendererKind: artifact.rendererKind,
    });
    recordCanvasRestoreTelemetry({
      attempted: false,
      result: result.result,
      source,
      artifactPath: artifact.normalizedPath,
      artifactIdentityHash: result.state?.stableArtifactIdentityHash
        ?? hashArtifactCanvasRestoreIdentity(result.state?.stableArtifactIdentity),
      storageKeyHash: result.storageKeyHash,
    });
    return artifact.normalizedPath;
  }, [canvasRestoreContext, recordCanvasRestoreTelemetry, resolveBuilderCanvasArtifactForPath]);
  const clearSelectedBuilderCanvasState = useCallback((source: string) => {
    const result = clearArtifactCanvasOpenState(canvasRestoreContext);
    recordCanvasRestoreTelemetry({
      attempted: false,
      result: result.result,
      source,
      storageKeyHash: result.storageKeyHash,
    });
  }, [canvasRestoreContext, recordCanvasRestoreTelemetry]);
  const builderCompletionForDisplay: BuilderCompletionEventV1 | null = useMemo(() => {
    if (!builderCompletion) {
      return null;
    }
    const hasActionPath = Boolean(builderCompletion.artifact_path || builderCompletion.artifact_url);
    const isMissingDeliverableError = (
      builderCompletion.status === 'error'
      && builderCompletion.error_message === MISSING_BUILDER_DELIVERABLE_ERROR
    );
    if (hasActionPath) {
      return builderCompletion;
    }
    if (!builderCompletionRecoveryFile?.path) {
      if (builderCompletion.status === 'success') {
        console.warn('[builder-artifacts] success completion downgraded because no action is available', {
          thread_id: (builderCompletion.thread_id || resolvedThreadId || '').slice(0, 12),
          task_id: builderCompletion.task_id.slice(0, 12),
          run_id: builderCompletion.run_id?.slice(0, 12) ?? null,
        });
        return {
          ...builderCompletion,
          thread_id: builderCompletion.thread_id || resolvedThreadId || '',
          status: 'error',
          error_message: builderCompletion.error_message ?? MISSING_BUILDER_DELIVERABLE_RETRY_MESSAGE,
          source: builderCompletion.source ?? 'artifact_missing_reclassified',
        };
      }
      return builderCompletion;
    }
    if (builderCompletion.status !== 'success' && !isMissingDeliverableError) {
      return builderCompletion;
    }
    const recovered: BuilderCompletionEventV1 = {
      ...builderCompletion,
      thread_id: builderCompletion.thread_id || resolvedThreadId || '',
      status: 'success',
      artifact_path: builderCompletionRecoveryFile.path,
      artifact_filename: builderCompletion.artifact_filename ?? builderCompletionRecoveryFile.name,
      artifact_title: builderCompletion.artifact_title ?? builderReadyTitle,
      error_message: null,
      source: 'artifact_library_recovery',
    };
    console.warn('[builder-artifacts] completion action recovered from library', {
      thread_id: resolvedThreadId?.slice(0, 12) ?? null,
      task_id: builderCompletion.task_id.slice(0, 12),
      run_id: builderCompletion.run_id?.slice(0, 12) ?? null,
      artifact_path_present: true,
    });
    return recovered;
  }, [builderCompletion, builderCompletionRecoveryFile?.name, builderCompletionRecoveryFile?.path, builderReadyTitle, resolvedThreadId]);

  useEffect(() => {
    if (builderCompletionForDisplay?.status !== 'success') return;
    if (builderCompletionForDisplay.artifact_path || builderCompletionForDisplay.artifact_url) return;
    console.warn('[builder-artifacts] terminal completion has no action href', {
      thread_id: builderCompletionForDisplay.thread_id.slice(0, 12),
      task_id: builderCompletionForDisplay.task_id.slice(0, 12),
      run_id: builderCompletionForDisplay.run_id?.slice(0, 12) ?? null,
    });
  }, [builderCompletionForDisplay]);
  const builderCompletionFallbackLabel = useMemo(
    () => builderCompletionForDisplay ? getBuilderCompletionFallbackLabel(builderCompletionForDisplay) : null,
    [builderCompletionForDisplay],
  );
  const canonicalCompletedBuilderTask = useMemo(() => {
    if (!builderPrimaryFile) {
      return null;
    }

    const fallbackBody = builderCompletionForDisplay
      ? getBuilderCompletionFallbackBody(builderCompletionForDisplay)
      : null;
    const completionCopy = builderCompletionForDisplay?.status === 'success'
      ? builderCompletionForDisplay.summary ?? builderCompletionForDisplay.user_next_action ?? null
      : null;

    return {
      phase: 'completed' as const,
      taskId: builderTask?.taskId ?? builderCompletionForDisplay?.task_id,
      runId: builderTask?.runId ?? builderCompletionForDisplay?.run_id ?? undefined,
      label: 'Builder artifact ready',
      detail: fallbackBody
        ?? builderArtifact?.userNextAction
        ?? builderArtifact?.companionSummary
        ?? completionCopy
        ?? 'Ready to review in canvas.',
      todos: builderTask?.todos,
      activityLog: builderTask?.activityLog,
      completedAt: builderTask?.completedAt ?? builderCompletionForDisplay?.completed_at ?? undefined,
      canvasStreamed: builderTask?.canvasStreamed,
    };
  }, [
    builderArtifact?.companionSummary,
    builderArtifact?.userNextAction,
    builderCompletionForDisplay,
    builderPrimaryFile,
    builderTask?.activityLog,
    builderTask?.canvasStreamed,
    builderTask?.completedAt,
    builderTask?.runId,
    builderTask?.taskId,
    builderTask?.todos,
  ]);
  const builderReadyDismissed = Boolean(
    builderPrimaryFile?.path && dismissedBuilderLibraryPath === builderPrimaryFile.path,
  );
  const artifactStageVisibilityProtected = showArtifacts && (
    Boolean(builderArtifact)
    || hasBuilderArtifactLibrary
    || hasSelectedBuilderArtifactPath
  );
  const effectiveShowArtifactsUi = showArtifactsUi || artifactStageVisibilityProtected;

  useEffect(() => {
    const signature = [
      showArtifacts && effectiveShowArtifactsUi ? 'visible' : 'hidden',
      sessionArtifactIndex.artifacts.length,
      sessionArtifactIndex.activeArtifactId ?? 'none',
    ].join('|');
    if (sessionArtifactTrayTelemetrySignatureRef.current === signature) {
      return;
    }
    sessionArtifactTrayTelemetrySignatureRef.current = signature;
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'session-artifact-tray',
      payload: {
        sessionArtifactTrayVisible: showArtifacts && effectiveShowArtifactsUi && sessionArtifactIndex.artifacts.length > 0,
        sessionArtifactTrayArtifactCount: sessionArtifactIndex.artifacts.length,
        sessionArtifactIndexEnabled: true,
        sessionArtifactIndexArtifactCount: sessionArtifactIndex.artifacts.length,
        sessionArtifactIndexActiveArtifactPresent: Boolean(sessionArtifactIndex.activeArtifactId),
        rawArtifactContentExcluded: true,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    });
  }, [
    effectiveShowArtifactsUi,
    sessionArtifactIndex.activeArtifactId,
    sessionArtifactIndex.artifacts.length,
    showArtifacts,
  ]);

  useEffect(() => {
    if (!artifactStageVisibilityProtected || showArtifactsUi) {
      return;
    }
    recordSophiaCaptureEvent({
      category: 'builder-ui',
      name: 'artifact-stage-protected-from-snapshot',
      payload: {
        artifactStageProtectedFromSnapshot: true,
        artifactStageUnmountPrevented: true,
        builderSnapshotIgnoredForActiveArtifact: true,
        selectedBuilderArtifactPathPresent: hasSelectedBuilderArtifactPath,
        builderArtifactPresent: Boolean(builderArtifact),
        builderArtifactLibraryCount: builderArtifactLibrary.length,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    });
  }, [
    artifactStageVisibilityProtected,
    builderArtifact,
    builderArtifactLibrary.length,
    hasSelectedBuilderArtifactPath,
    showArtifactsUi,
  ]);
  const handleSelectBuilderArtifactPath = useCallback((path: string | null) => {
    const normalizedPath = normalizeBuilderArtifactPath(path);
    if (!normalizedPath) {
      setSelectedBuilderArtifactPath(null);
      clearSelectedBuilderCanvasState('selection_cleared');
      return null;
    }

    canvasRestoreClosedByUserRef.current = false;
    const record = registerSessionArtifactByPath(normalizedPath, { source: 'selected_stage' });
    const persistedPath = persistSelectedBuilderCanvasState(normalizedPath, 'view_in_canvas');
    const nextPath = persistedPath ?? normalizedPath;
    openSessionArtifactRecord(record?.artifactId ?? nextPath, 'view_in_canvas');
    setSelectedBuilderArtifactPath(nextPath);
    return nextPath;
  }, [
    clearSelectedBuilderCanvasState,
    openSessionArtifactRecord,
    persistSelectedBuilderCanvasState,
    registerSessionArtifactByPath,
  ]);
  const handleViewCoreviewBuilderUpdatedVersion = useCallback((
    path: string | null,
    metadata?: SessionArtifactRegisterMetadata,
  ) => {
    const normalizedPath = normalizeBuilderArtifactPath(path);
    if (!normalizedPath) {
      return;
    }
    const record = registerSessionArtifactByPath(normalizedPath, {
      ...metadata,
      source: metadata?.source ?? 'coreview_version',
    });
    handleSelectBuilderArtifactPath(record?.localPath ?? normalizedPath);
    setShowArtifacts(true);
    setUserOpenedArtifacts(true);
  }, [handleSelectBuilderArtifactPath, registerSessionArtifactByPath, setShowArtifacts, setUserOpenedArtifacts]);
  const handleOpenSessionArtifact = useCallback((artifact: ArtifactRecord) => {
    if (artifact.review?.missing) {
      recordSessionArtifactIndexTelemetry({
        sessionArtifactOpenAttempted: true,
        sessionArtifactOpenResult: 'missing',
        sessionArtifactOpenRendererKind: artifact.rendererKind,
        sessionArtifactIndexArtifactCount: sessionArtifactIndex.artifacts.length,
        sessionArtifactIndexActiveArtifactPresent: Boolean(sessionArtifactIndex.activeArtifactId),
      });
      return;
    }
    handleSelectBuilderArtifactPath(artifact.localPath);
    setShowArtifacts(true);
    setUserOpenedArtifacts(true);
  }, [
    handleSelectBuilderArtifactPath,
    recordSessionArtifactIndexTelemetry,
    sessionArtifactIndex.activeArtifactId,
    sessionArtifactIndex.artifacts.length,
    setShowArtifacts,
    setUserOpenedArtifacts,
  ]);

  useEffect(() => {
    if (!builderArtifact) {
      return;
    }
    const files = getBuilderArtifactFiles(builderArtifact);
    const completionPath = normalizeBuilderArtifactPath(builderCompletionForDisplay?.artifact_path);
    const completionSummary = builderCompletionForDisplay?.status === 'success'
      ? builderCompletionForDisplay.summary ?? builderCompletionForDisplay.user_next_action ?? null
      : null;
    for (const file of files) {
      const filePath = normalizeBuilderArtifactPath(file.path);
      const matchesSuccessfulCompletion = Boolean(
        builderCompletionForDisplay?.status === 'success'
        && completionPath
        && filePath === completionPath,
      );
      registerSessionArtifactByPath(file.path, {
        source: 'current_builder_artifact',
        title: file.isPrimary ? builderArtifact.artifactTitle : file.label,
        artifactType: builderArtifact.artifactType,
        taskId: matchesSuccessfulCompletion ? builderCompletionForDisplay?.task_id ?? null : null,
        runId: matchesSuccessfulCompletion ? builderCompletionForDisplay?.run_id ?? null : null,
        safeSummary: completionPath && filePath === completionPath
          ? completionSummary ?? builderArtifact.companionSummary ?? builderArtifact.userNextAction ?? null
          : builderArtifact.companionSummary ?? builderArtifact.userNextAction ?? null,
      });
    }
  }, [
    builderArtifact,
    builderCompletionForDisplay,
    registerSessionArtifactByPath,
  ]);

  useEffect(() => {
    for (const item of builderArtifactLibrary) {
      registerSessionArtifactByPath(item.path, {
        source: 'file_library',
        title: item.name,
        mimeType: item.mimeType ?? null,
      });
    }
  }, [builderArtifactLibrary, registerSessionArtifactByPath]);

  useEffect(() => {
    if (builderCompletionForDisplay?.status !== 'success') {
      return;
    }
    const completionPath = normalizeBuilderArtifactPath(builderCompletionForDisplay.artifact_path);
    if (!completionPath) {
      return;
    }
    registerSessionArtifactByPath(completionPath, {
      source: builderCompletionForDisplay.source === 'artifact_library_recovery'
        ? 'builder_canvas'
        : 'builder_completion',
      artifactId: builderCompletionForDisplay.artifact_id ?? null,
      logicalArtifactId: builderCompletionForDisplay.logical_artifact_id ?? null,
      versionId: builderCompletionForDisplay.current_artifact_version_id ?? null,
      title: builderCompletionForDisplay.artifact_title
        ?? builderCompletionForDisplay.artifact_filename
        ?? getBuilderArtifactFilename(completionPath),
      filename: builderCompletionForDisplay.artifact_filename ?? null,
      artifactType: builderCompletionForDisplay.artifact_type ?? null,
      mimeType: builderCompletionForDisplay.mime_type ?? null,
      taskId: builderCompletionForDisplay.task_id,
      runId: builderCompletionForDisplay.run_id ?? null,
      sourceArtifactPath: builderCompletionForDisplay.source_artifact_path ?? null,
      revisionOfArtifactPath: builderCompletionForDisplay.revision_of_artifact_path ?? null,
      safeSummary: builderCompletionForDisplay.summary ?? builderCompletionForDisplay.user_next_action ?? null,
      contentHash: builderCompletionForDisplay.content_hash ?? null,
      storageProvider: builderCompletionForDisplay.storage_provider ?? null,
      storageBucket: builderCompletionForDisplay.storage_bucket ?? null,
      storageObjectPath: builderCompletionForDisplay.storage_object_path ?? null,
      contentUrl: builderCompletionForDisplay.content_url ?? null,
      downloadUrl: builderCompletionForDisplay.download_url ?? null,
      createdAt: builderCompletionForDisplay.completed_at ?? null,
    });
  }, [builderCompletionForDisplay, registerSessionArtifactByPath]);

  useEffect(() => {
    const activeArtifact = sessionArtifactIndex.artifacts.find(
      (artifact) => artifact.artifactId === sessionArtifactIndex.activeArtifactId,
    );
    if (
      builderCompletionForDisplay?.status !== 'success'
      || !showArtifacts
      || !effectiveShowArtifactsUi
      || !exactActiveArtifactMatchesBuilderCompletion(
        activeArtifact,
        builderCompletionForDisplay,
      )
    ) return;
    const terminalEvent = [...builderCanvasEvents].reverse().find((event) => (
      event.kind === 'terminal'
      && event.task_id === builderCompletionForDisplay.task_id
      && event.run_id === builderCompletionForDisplay.run_id
    ));
    if (terminalEvent) {
      void recordSyntheticBuilderCanvasProjection(
        terminalEvent,
        'artifact_visible_current',
      );
    }
  }, [
    builderCanvasEvents,
    builderCompletionForDisplay,
    effectiveShowArtifactsUi,
    sessionArtifactIndex.activeArtifactId,
    sessionArtifactIndex.artifacts,
    showArtifacts,
  ]);

  useEffect(() => {
    if (!showArtifacts || !effectiveShowArtifactsUi) {
      setPendingBuilderArtifactReview(false);
    }
  }, [effectiveShowArtifactsUi, showArtifacts]);

  const dismissVisibleBuilderArtifact = useCallback(() => {
    if (builderPrimaryFile?.path) {
      setDismissedBuilderLibraryPath(builderPrimaryFile.path);
    }
    if (hasRecoveredBuilderArtifact) {
      clearBuilderTask();
    }
    setSelectedBuilderArtifactPath(null);
    clearSelectedBuilderCanvasState('canvas_close');
    clearBuilderArtifact();
  }, [builderPrimaryFile?.path, clearBuilderArtifact, clearBuilderTask, clearSelectedBuilderCanvasState, hasRecoveredBuilderArtifact]);
  const voiceBuilderChromeOpacity = Math.max(chromeOpacity, 0.94);
  const voiceBuilderAccessoryOpacity = Math.max(chromeOpacity, 0.62);

  const handleVoiceDownloadBuilderArtifact = useCallback(() => {
    if (!builderDownloadHref || typeof document === 'undefined') {
      return false;
    }

    const link = document.createElement('a');
    link.href = builderDownloadHref;
    link.style.display = 'none';
    link.rel = 'noopener';
    if (builderPrimaryFile?.name) {
      link.download = builderPrimaryFile.name;
    }
    document.body.appendChild(link);
    link.click();

    window.setTimeout(() => {
      link.remove();
    }, 0);

    // Auto-dismiss builder UI after download so new tasks can surface
    window.setTimeout(() => {
      clearBuilderTask();
    }, 1500);

    return true;
  }, [builderDownloadHref, builderPrimaryFile?.name, clearBuilderTask]);

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
      effectiveShowArtifactsUi,
      artifactStageVisibilityProtected,
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
    effectiveShowArtifactsUi,
    artifactStageVisibilityProtected,
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
    showEmergence,
    debriefData,
    isNavigatingToRecap,
    handleEndSession,
    handleVoiceEndSession,
    handleCancelExit,
    handleStartDebrief,
    handleSkipToRecap,
    handleEmergenceComplete,
  } = useSessionExitOrchestration({
    isReadOnly,
    isSophiaResponding,
    stopStreaming: () => {
      void stopStreaming();
    },
    stopVoiceTransport: voiceState.stopVoiceTransport,
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
    currentBuilderArtifact: builderArtifact,
    userId,
    persistedThreadId: session?.threadId,
    threadId: resolvedThreadId,
    greetingMessageId,
    persistedSessionId: session?.sessionId,
    responseMode: exitProtectionResponseMode,
    messages,
    updateMessages,
    flushSessionTranscript,
    getSessionTranscriptRevision,
    isEnding,
  });

  useSessionVoiceCommandSystem({
    onUserTranscript: appendVoiceUserMessage,
    reflectionCandidate: artifacts?.reflection_candidate,
    handleReflectionTap,
    canDownloadBuilderArtifact: Boolean(builderDownloadHref),
    handleDownloadBuilderArtifact: handleVoiceDownloadBuilderArtifact,
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
    routeArtifactReviewCommand: routeArtifactReviewVoiceCommand,
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
    showArtifactsUi: effectiveShowArtifactsUi,
    mobileDrawerOpen,
    setShowArtifacts,
    setMobileDrawerOpen,
    setUserOpenedArtifacts,
    setShowScaffold,
    triggerLightHaptic: () => haptic('light'),
    onBaseMicClick: baseHandleMicClick,
    protectArtifactStageOpen: artifactStageVisibilityProtected,
  });
  // Keep the controller and the visible composer on the same exact product
  // callback. This preserves read-only and UI-state guards and prevents a
  // private synthetic-only voice-start path from drifting into the app.
  const handleCloseArtifactsPanelAndCanvasState = useCallback(() => {
    canvasRestoreClosedByUserRef.current = true;
    clearSelectedBuilderCanvasState('canvas_close');
    handleCloseArtifactsPanel();
  }, [clearSelectedBuilderCanvasState, handleCloseArtifactsPanel]);

  const handleViewBuilderArtifactInCanvas = useCallback(() => {
    handleSelectBuilderArtifactPath(builderPrimaryFile?.path ?? null);
    handleOpenArtifactsPanel();
  }, [builderPrimaryFile?.path, handleOpenArtifactsPanel, handleSelectBuilderArtifactPath]);
  const handleBuilderCompletionPreview = useCallback((event: BuilderCompletionEventV1) => {
    handleSelectBuilderArtifactPath(event.artifact_path ?? builderPrimaryFile?.path ?? null);
    handleOpenArtifactsPanel();
  }, [builderPrimaryFile?.path, handleOpenArtifactsPanel, handleSelectBuilderArtifactPath]);

  useEffect(() => {
    const handoff = peekArtifactLibraryOpenHandoff(sessionArtifactIndexContext);
    if (!handoff) {
      return;
    }

    const normalizedPath = normalizeBuilderArtifactPath(handoff.artifactPath);
    if (!normalizedPath) {
      clearArtifactLibraryOpenHandoff();
      recordSophiaCaptureEvent({
        category: 'artifacts-runtime',
        name: 'artifact-library-open-handoff',
        payload: {
          artifactLibraryOpenHandoffResult: 'invalid_path',
          artifactLibraryOpenHandoffArtifactId: handoff.artifactId,
          rawArtifactContentExcluded: true,
          rawArtifactTextExcluded: true,
        },
      });
      showToast({
        message: 'Could not open that artifact in canvas.',
        variant: 'warning',
        durationMs: 3200,
      });
      return;
    }

    const record = registerSessionArtifactByPath(normalizedPath, {
      ...handoff.metadata,
      title: handoff.metadata.title ?? handoff.title ?? handoff.filename ?? getBuilderArtifactFilename(normalizedPath),
      rendererKind: handoff.rendererKind,
      source: handoff.metadata.source ?? 'manual',
    });
    const selectedPath = handleSelectBuilderArtifactPath(record?.localPath ?? normalizedPath);
    if (!selectedPath) {
      clearArtifactLibraryOpenHandoff();
      recordSophiaCaptureEvent({
        category: 'artifacts-runtime',
        name: 'artifact-library-open-handoff',
        payload: {
          artifactLibraryOpenHandoffResult: 'open_failed',
          artifactLibraryOpenHandoffArtifactId: handoff.artifactId,
          rawArtifactContentExcluded: true,
          rawArtifactTextExcluded: true,
        },
      });
      showToast({
        message: 'Could not open that artifact in canvas.',
        variant: 'warning',
        durationMs: 3200,
      });
      return;
    }

    handleOpenArtifactsPanel();
    clearArtifactLibraryOpenHandoff();
    recordSophiaCaptureEvent({
      category: 'artifacts-runtime',
      name: 'artifact-library-open-handoff',
      payload: {
        artifactLibraryOpenHandoffResult: 'opened',
        artifactLibraryOpenHandoffArtifactId: handoff.artifactId,
        artifactLibraryOpenHandoffRendererKind: handoff.rendererKind,
        sessionArtifactIndexEnabled: true,
        rawArtifactContentExcluded: true,
        rawArtifactTextExcluded: true,
      },
    });
  }, [
    handleOpenArtifactsPanel,
    handleSelectBuilderArtifactPath,
    registerSessionArtifactByPath,
    sessionArtifactIndexContext,
    sessionArtifactIndexContextSignature,
    showToast,
  ]);

  useEffect(() => {
    if (selectedBuilderArtifactPath || showArtifacts || canvasRestoreClosedByUserRef.current) {
      return;
    }
    if (!canvasRestoreContext.threadId || !canvasRestoreContext.sessionId) {
      return;
    }
    if (canvasRestoreAttemptedContextRef.current === canvasRestoreContextSignature) {
      return;
    }
    canvasRestoreAttemptedContextRef.current = canvasRestoreContextSignature;

    const restored = restoreArtifactCanvasOpenState(canvasRestoreContext);
    const restoredState = restored.state;
    if (restored.result !== 'restored' || !restoredState) {
      recordCanvasRestoreTelemetry({
        attempted: true,
        result: restored.result,
        source: 'page_mount',
        storageKeyHash: restored.storageKeyHash,
      });
      return;
    }

    const artifact = resolveBuilderCanvasArtifactForPath(restoredState.normalizedArtifactPath);
    if (!artifact) {
      clearArtifactCanvasOpenState(canvasRestoreContext);
      recordCanvasRestoreTelemetry({
        attempted: true,
        result: 'invalid_artifact',
        source: 'page_mount',
        artifactPath: restoredState.normalizedArtifactPath,
        artifactIdentityHash: restoredState.stableArtifactIdentityHash,
        storageKeyHash: restored.storageKeyHash,
      });
      return;
    }

    const expectedIdentityHash = hashArtifactCanvasRestoreIdentity(restoredState.stableArtifactIdentity);
    const currentArtifactIdentity = buildCoreviewArtifactStableIdentity({
      userId: canvasRestoreContext.userId,
      threadId: canvasRestoreContext.threadId,
      artifactPath: artifact.normalizedPath,
      rendererKind: artifact.rendererKind,
    }).key;
    const currentArtifactIdentityHash = hashArtifactCanvasRestoreIdentity(currentArtifactIdentity);
    if (expectedIdentityHash && currentArtifactIdentityHash && expectedIdentityHash !== currentArtifactIdentityHash) {
      clearArtifactCanvasOpenState(canvasRestoreContext);
      recordCanvasRestoreTelemetry({
        attempted: true,
        result: 'identity_mismatch',
        source: 'page_mount',
        artifactPath: artifact.normalizedPath,
        artifactIdentityHash: expectedIdentityHash,
        storageKeyHash: restored.storageKeyHash,
      });
      return;
    }

    setSelectedBuilderArtifactPath(artifact.normalizedPath);
    setShowArtifacts(true);
    setUserOpenedArtifacts(true);
    const record = registerSessionArtifactByPath(artifact.normalizedPath, { source: 'canvas_open' });
    openSessionArtifactRecord(record?.artifactId ?? artifact.normalizedPath, 'canvas_restore');
    recordCanvasRestoreTelemetry({
      attempted: true,
      result: 'restored',
      source: 'page_mount',
      artifactPath: artifact.normalizedPath,
      artifactIdentityHash: expectedIdentityHash ?? restoredState.stableArtifactIdentityHash,
      storageKeyHash: restored.storageKeyHash,
    });
  }, [
    canvasRestoreContext,
    canvasRestoreContextSignature,
    recordCanvasRestoreTelemetry,
    openSessionArtifactRecord,
    registerSessionArtifactByPath,
    resolveBuilderCanvasArtifactForPath,
    selectedBuilderArtifactPath,
    setShowArtifacts,
    setUserOpenedArtifacts,
    showArtifacts,
  ]);

  const handleStartVoiceBuilderArtifactReview = useCallback(() => {
    setPendingBuilderArtifactReview(true);
    handleOpenArtifactsPanel();

    if (focusMode !== 'voice') {
      setFocusMode('voice');
      setFocusModeManualOverride(true);
    }

    void handleMicClick();
  }, [focusMode, handleMicClick, handleOpenArtifactsPanel, setFocusMode, setFocusModeManualOverride]);

  const handlePendingBuilderArtifactReviewConsumed = useCallback(() => {
    setPendingBuilderArtifactReview(false);
  }, []);
  
  const { shouldShowLoading, navigateHome } = useSessionPageGuards({
    hasSession: !!session,
    isEnding,
    isNavigatingToRecap,
    navigateTo: (href) => {
      void router.push(href);
    },
  });

  // The synthetic controller must not race session-store hydration. Its exact
  // visible microphone callback is armed only once the ordinary session has a
  // valid backend identity and is ready for normal user interaction.
  useVoiceLabControlAdapter(
    'voice-start',
    handleMicClick,
    !shouldShowLoading && hasValidBackendSessionId && !isReadOnly,
  );

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
  
  // Scroll conversation to bottom when artifact panel opens in text mode
  // so the latest messages stay visible above the panel
  useEffect(() => {
    if (focusMode === 'text' && showArtifacts && effectiveShowArtifactsUi) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [effectiveShowArtifactsUi, focusMode, showArtifacts, messagesEndRef]);

  const showTextArtifactStage = focusMode === 'text'
    && showArtifacts
    && effectiveShowArtifactsUi
    && (Boolean(builderArtifact) || hasBuilderArtifactLibrary || hasSelectedBuilderArtifactPath);
  const showVoiceArtifactStage = focusMode !== 'text'
    && showArtifacts
    && effectiveShowArtifactsUi
    && (Boolean(builderArtifact) || hasBuilderArtifactLibrary || hasSelectedBuilderArtifactPath);
  const artifactStageActive = showTextArtifactStage || showVoiceArtifactStage;
  const showInlineTextArtifactsPanel = focusMode === 'text'
    && showArtifacts
    && effectiveShowArtifactsUi
    && !showTextArtifactStage;
  const coreviewArtifactUpdateSurfaceActive = useMemo(() => {
    const claim = coreviewArtifactUpdateSurfaceClaim;
    if (claim?.rendererKind !== 'html') {
      return false;
    }
    const claimRecent = Date.now() - claim.requestedAt <= COREVIEW_ARTIFACT_UPDATE_SURFACE_RECENT_MS;
    if (claimRecent && builderCompletionMatchesCoreviewClaim(builderCompletionForDisplay, claim)) {
      return true;
    }
    if (
      builderTask
      && (
        (claim.taskId && builderTask.taskId === claim.taskId)
        || (claim.runId && builderTask.runId === claim.runId)
      )
      && (builderTask.phase === 'running' || builderTask.phase === 'completed')
    ) {
      return true;
    }
    return normalizedBuilderPathsEqual(selectedBuilderArtifactPath, claim.artifactPath)
      && claimRecent;
  }, [
    builderCompletionForDisplay,
    builderTask,
    coreviewArtifactUpdateSurfaceClaim,
    selectedBuilderArtifactPath,
  ]);
  const builderSurface = useMemo(() => resolveBuilderSurface({
    artifactStageActive,
    coreviewArtifactUpdateActive: coreviewArtifactUpdateSurfaceActive,
    buildRunning: isBuilderActivelyRunning
      && !hasRecoveredBuilderArtifact
      && !(
        builderCompletionForDisplay?.status === 'success'
        && Boolean(builderCompletionForDisplay.artifact_path || builderCompletionForDisplay.artifact_url)
        && (!builderTask?.taskId || builderTask.taskId === builderCompletionForDisplay.task_id)
        && (!builderTask?.runId || !builderCompletionForDisplay.run_id || builderTask.runId === builderCompletionForDisplay.run_id)
      ),
    completedBuilderAvailable: Boolean(builderPrimaryFile && !builderReadyDismissed),
    secondaryFileRowsAvailable: Boolean(builderArtifact) || hasBuilderArtifactLibrary,
    legacyCompletionAvailable: Boolean(builderCompletionForDisplay),
    selectedBuilderArtifactPathExists: hasSelectedBuilderArtifactPath,
  }), [
    builderArtifact,
    builderCompletionForDisplay,
    builderTask?.runId,
    builderTask?.taskId,
    builderPrimaryFile,
    builderReadyDismissed,
    hasBuilderArtifactLibrary,
    hasSelectedBuilderArtifactPath,
    hasRecoveredBuilderArtifact,
    isBuilderActivelyRunning,
    artifactStageActive,
    coreviewArtifactUpdateSurfaceActive,
  ]);
  const canonicalCompletedBuilderEntryAvailable = Boolean(
    builderPrimaryFile
      && canonicalCompletedBuilderTask
      && builderSurface.showCanonicalCompletedBuilder
      && effectiveShowArtifactsUi,
  );
  const showCanonicalCompletedBuilderEntryInline = Boolean(
    canonicalCompletedBuilderEntryAvailable
      && focusMode === 'text'
      && !showArtifacts
      && !artifactStageActive,
  );
  const showCanonicalCompletedBuilderEntryCorner = Boolean(
    canonicalCompletedBuilderEntryAvailable
      && focusMode !== 'text'
      && !showArtifacts
      && !artifactStageActive,
  );
  const completedBuilderEntryPlacement = showCanonicalCompletedBuilderEntryCorner
    ? 'corner'
    : showCanonicalCompletedBuilderEntryInline
      ? 'inline'
      : 'hidden';
  const completedBuilderEntryHiddenForStage = artifactStageActive && canonicalCompletedBuilderEntryAvailable;
  const completedBuilderEntryOverlapsControls = false;

  useEffect(() => {
    const signature = [
      builderSurface.builderSurfaceMode ?? 'none',
      builderSurface.canonicalBuilderSurface,
      builderSurface.legacyBuilderSurfaceHidden ? 'legacy-hidden' : 'legacy-visible',
      builderSurface.builderReadyPillSuppressed ? 'ready-pill-suppressed' : 'ready-pill-clear',
      builderSurface.duplicateBuilderSurfaceSuppressed ? 'duplicate-suppressed' : 'duplicate-clear',
      builderSurface.resumedBuilderSurfaceResolved ? 'resumed-resolved' : 'resumed-not-selected',
      builderTask?.phase ?? 'no-task',
      builderTask?.builderFailureDiagnosticAvailable ? 'builder-diagnostic' : 'no-builder-diagnostic',
      builderTask?.builderFailureStage ?? 'no-builder-failure-stage',
      builderTask?.builderFailureCode ?? 'no-builder-failure-code',
      builderTask?.builderFallbackAttempted ? 'fallback-attempted' : 'fallback-not-attempted',
      builderTask?.builderFallbackResult ?? 'no-fallback-result',
      builderCompletionForDisplay?.status ?? 'no-completion',
      hasSelectedBuilderArtifactPath ? 'selected-artifact' : 'no-selected-artifact',
      artifactStageActive ? 'stage-active' : 'stage-inactive',
      coreviewArtifactUpdateSurfaceActive ? 'coreview-update-surface-active' : 'coreview-update-surface-inactive',
      completedBuilderEntryPlacement,
      completedBuilderEntryHiddenForStage ? 'completed-hidden-for-stage' : 'completed-not-hidden-for-stage',
    ].join('|');

    if (previousBuilderSurfaceTelemetrySignatureRef.current === signature) {
      return;
    }
    previousBuilderSurfaceTelemetrySignatureRef.current = signature;

    recordSophiaCaptureEvent({
      category: 'builder-ui',
      name: 'builder-surface-resolved',
      payload: {
        builderSurfaceMode: builderSurface.builderSurfaceMode,
        canonicalBuilderSurface: builderSurface.canonicalBuilderSurface,
        legacyBuilderSurfaceHidden: builderSurface.legacyBuilderSurfaceHidden,
        builderReadyPillSuppressed: builderSurface.builderReadyPillSuppressed,
        duplicateBuilderSurfaceSuppressed: builderSurface.duplicateBuilderSurfaceSuppressed,
        resumedBuilderSurfaceResolved: builderSurface.resumedBuilderSurfaceResolved,
        artifactStageActive,
        activeBuildStepsVisible: builderSurface.showActiveBuildSteps,
        canonicalCompletedBuilderVisible: showCanonicalCompletedBuilderEntryInline || showCanonicalCompletedBuilderEntryCorner,
        completedBuilderEntryPlacement,
        coreviewHtmlUpdateSuppressedCompletedBuilderSurface: coreviewArtifactUpdateSurfaceActive && !builderSurface.showCanonicalCompletedBuilder,
        completedBuilderEntryOverlapsControls,
        completedBuilderEntryHiddenForStage,
        legacyCompletionFallbackVisible: builderSurface.showLegacyCompletionFallback,
        selectedBuilderArtifactPathPresent: hasSelectedBuilderArtifactPath,
        builderTaskPhase: builderTask?.phase ?? null,
        builderFailureDiagnosticAvailable: builderTask?.builderFailureDiagnosticAvailable ?? false,
        builderFailureStage: builderTask?.builderFailureStage ?? null,
        builderFailureCode: builderTask?.builderFailureCode ?? null,
        builderEmitAttempted: builderTask?.builderEmitAttempted ?? null,
        builderExpectedArtifactPathHash: builderTask?.builderExpectedArtifactPathHash ?? null,
        builderExpectedArtifactExists: builderTask?.builderExpectedArtifactExists ?? null,
        builderOutputsSummaryCount: builderTask?.builderOutputsSummaryCount ?? 0,
        builderSupabaseMirrorResult: builderTask?.builderSupabaseMirrorResult ?? null,
        builderCompletionReconciliationAction: builderTask?.builderCompletionReconciliationAction ?? null,
        builderPrimaryProvider: builderTask?.builderPrimaryProvider ?? null,
        builderFallbackProvider: builderTask?.builderFallbackProvider ?? null,
        builderFallbackEnabled: builderTask?.builderFallbackEnabled ?? null,
        builderFallbackAttempted: builderTask?.builderFallbackAttempted ?? null,
        builderFallbackReason: builderTask?.builderFallbackReason ?? null,
        builderFallbackResult: builderTask?.builderFallbackResult ?? null,
        builderProviderErrorClass: builderTask?.builderProviderErrorClass ?? null,
        builderCompletionStatus: builderCompletionForDisplay?.status ?? null,
      },
    });
  }, [
    builderCompletionForDisplay?.status,
    builderSurface.builderReadyPillSuppressed,
    builderSurface.builderSurfaceMode,
    builderSurface.canonicalBuilderSurface,
    builderSurface.duplicateBuilderSurfaceSuppressed,
    builderSurface.legacyBuilderSurfaceHidden,
    builderSurface.resumedBuilderSurfaceResolved,
    builderSurface.showActiveBuildSteps,
    builderSurface.showCanonicalCompletedBuilder,
    builderSurface.showLegacyCompletionFallback,
    builderTask?.builderCompletionReconciliationAction,
    builderTask?.builderEmitAttempted,
    builderTask?.builderExpectedArtifactExists,
    builderTask?.builderExpectedArtifactPathHash,
    builderTask?.builderFailureCode,
    builderTask?.builderFailureDiagnosticAvailable,
    builderTask?.builderFailureStage,
    builderTask?.builderOutputsSummaryCount,
    builderTask?.builderSupabaseMirrorResult,
    builderTask?.builderPrimaryProvider,
    builderTask?.builderFallbackProvider,
    builderTask?.builderFallbackEnabled,
    builderTask?.builderFallbackAttempted,
    builderTask?.builderFallbackReason,
    builderTask?.builderFallbackResult,
    builderTask?.builderProviderErrorClass,
    builderTask?.phase,
    artifactStageActive,
    coreviewArtifactUpdateSurfaceActive,
    completedBuilderEntryHiddenForStage,
    completedBuilderEntryOverlapsControls,
    completedBuilderEntryPlacement,
    hasSelectedBuilderArtifactPath,
    showCanonicalCompletedBuilderEntryCorner,
    showCanonicalCompletedBuilderEntryInline,
  ]);

  // Loading state — the breathing nebula IS the loading indicator (R41)
  if (shouldShowLoading) {
    return (
      <div
        className="h-screen bg-[var(--bg)]"
        data-voice-lab-route-state="session-store-loading"
      >
        <PresenceField />
      </div>
    );
  }
  
  // ============================================================================
  // RENDER
  // ============================================================================

  // Pre-compute the Composer's attach-button slot so the inline
  // conditional in JSX doesn't add a branch to SessionPageContent's
  // already-high CC (B4 of the silent-attach fix, 2026-05-28).
  const attachButtonSlot = focusMode === 'text' ? (
    <ComposerAttachButton
      onClick={handleOpenAttachPicker}
      disabled={isTyping || isReadOnly || !resolvedThreadId}
    />
  ) : undefined;

  return (
    <SessionLayout
      store={session}
      onEndSession={handleEndSession}
      isEnding={isEnding}
      isSophiaResponding={isSophiaResponding}
      isReadOnly={isReadOnly}
      presenceRef={presenceRef}
    >
      <div
        data-testid={showTextArtifactStage ? 'session-text-split-workspace' : undefined}
        className={cn(
          'relative h-full min-h-0 animate-fadeIn',
          showTextArtifactStage
            ? 'grid w-full grid-cols-1 grid-rows-[minmax(320px,0.52fr)_minmax(380px,0.48fr)] overflow-hidden lg:grid-cols-[minmax(360px,0.38fr)_minmax(0,1fr)] lg:grid-rows-1 lg:gap-6 xl:grid-cols-[minmax(420px,0.34fr)_minmax(720px,1fr)]'
            : 'flex',
        )}
      >
        {/* Main Chat Area */}
        <div
          data-testid={showTextArtifactStage ? 'session-conversation-area' : undefined}
          className={cn(
            'relative z-10 flex min-w-0 flex-col overflow-hidden',
            showTextArtifactStage ? 'min-h-0' : 'flex-1',
          )}
        >
            <VoiceMetricsPanel voiceState={voiceState} defaultExpanded={false} layout="floating" />

          {/* Reading corridor — calms the nebula behind text so messages are effortless to read.
              A radial vignette that darkens the center (where text lives) and fades to
              transparent at the edges, letting the cosmic field breathe through. */}
          {focusMode === 'text' && (
            <div
              className="cosmic-reading-corridor absolute inset-0 z-0 pointer-events-none"
            />
          )}

          {/* Conversation pane — hidden in voice mode but stays mounted to preserve scroll */}
          <div className={focusMode !== 'text' ? 'hidden' : 'flex-1 flex flex-col min-h-0 text-mode-elevated'}>
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
          
          {/* Voice Caption — ephemeral text overlay in voice mode.
              Pushed higher when the artifact panel is open to prevent overlap. */}
          <div
            className={cn(
              'transition-all duration-700 ease-out',
              focusMode !== 'text' && showArtifacts && effectiveShowArtifactsUi && 'voice-caption-raised'
            )}
          >
            <VoiceCaption
              messages={messages}
              isVoiceMode={focusMode !== 'text'}
              onVisibilityChange={setIsVoiceCaptionVisible}
            />
          </div>
          
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
          
          {/* Inline Artifact Panel — text mode companion artifacts above composer */}
          {showInlineTextArtifactsPanel && (
            <PresenceArtifactPanel
              artifacts={artifacts}
              builderArtifact={builderArtifact}
              builderArtifactLibrary={builderArtifactLibrary}
              builderTask={builderTask}
              builderCompletion={builderCompletion}
              sessionArtifactIndex={sessionArtifactIndex}
              isCancellingBuilderTask={isCancellingBuilderTask}
              selectedBuilderArtifactPath={selectedBuilderArtifactPath}
              onSelectedBuilderArtifactPathChange={handleSelectBuilderArtifactPath}
              onCoreviewBuilderUpdateRequest={handleCoreviewBuilderUpdateRequest}
              onCoreviewBuilderCancelRequest={handleCoreviewBuilderCancelRequest}
              onCoreviewBuilderViewUpdatedVersion={handleViewCoreviewBuilderUpdatedVersion}
              onSessionArtifactOpen={handleOpenSessionArtifact}
              sessionId={coReviewSessionId}
              normalSessionId={coReviewSessionId}
              voiceAgentSessionId={coReviewVoiceAgentSessionId}
              userId={userId}
              threadId={artifactPanelThreadId}
              isVisible={showArtifacts && effectiveShowArtifactsUi}
              onDismiss={handleCloseArtifactsPanelAndCanvasState}
              isVoiceMode={false}
              coReviewTransport={coReviewTransport}
              pendingBuilderArtifactReview={pendingBuilderArtifactReview}
              onStartVoiceBuilderArtifactReview={handleStartVoiceBuilderArtifactReview}
              onPendingBuilderArtifactReviewConsumed={handlePendingBuilderArtifactReviewConsumed}
              onArtifactReviewVoiceCommandRouteChange={handleArtifactReviewVoiceCommandRouteChange}
              onCoreviewActionFeedback={handleCoreviewActionFeedback}
              onAnnotationActionSucceeded={voiceState.markAnnotationActionSucceeded}
              onReflectionTap={handleReflectionTap ? (r) => handleReflectionTap(r, 'tap') : undefined}
              onMemoryApprove={handleMemoryApprove}
              onMemoryReject={handleMemoryReject}
            />
          )}

          {/*
            Builder surface arbitration: review room and active build progress
            win first; the completion card is now only a fallback when no
            artifact entry or library surface can take over.
          */}
          {focusMode === 'text' && builderSurface.showLegacyCompletionFallback && builderCompletionForDisplay && (
            <BuilderCompletionCard
              event={builderCompletionForDisplay}
              onOpen={handleBuilderCompletionPreview}
              onRetry={handleBuilderRetry}
              onDismiss={handleBuilderCompletionDismiss}
              onDownload={() => haptic('medium')}
            />
          )}
          {focusMode === 'text'
            && builderSurface.showActiveBuildSteps
            && showBuilderTaskNotice
            && builderTask && (
            <BuilderTaskNotice
              task={builderTask}
              artifactTitle={builderArtifact?.artifactTitle}
              onOpenArtifact={builderArtifact ? handleViewBuilderArtifactInCanvas : undefined}
              openHref={builderOpenHref}
              downloadHref={builderArtifact ? builderDownloadHref : undefined}
              onDownload={builderArtifact ? () => { haptic('medium'); setTimeout(clearBuilderTask, 1500); } : undefined}
              onDismiss={clearBuilderTask}
              onCancel={cancelBuilderTask}
              isCancelling={isCancellingBuilderTask}
            />
          )}

          {/* Session artifact tray — text mode: persistent entry above the composer.
              Hidden while the artifact panel is open (the panel carries its own tray)
              and renders nothing when the local session artifact index is empty. */}
          {focusMode === 'text' && !(showArtifacts && effectiveShowArtifactsUi) && (
            <div className="mb-2 flex justify-end px-3 sm:px-4">
              <SessionArtifactTrayLauncher
                sessionArtifactIndex={sessionArtifactIndex}
                threadId={artifactPanelThreadId}
                onSessionArtifactOpen={handleOpenSessionArtifact}
              />
            </div>
          )}

          {/* Canonical completed builder surface — text mode: left-column inline above composer */}
          {showCanonicalCompletedBuilderEntryInline
            && builderPrimaryFile
            && canonicalCompletedBuilderTask && (
            <div
              data-testid="canonical-completed-builder-entry"
              data-builder-entry-placement="inline"
              data-builder-entry-overlaps-controls="false"
              className="mb-2 flex justify-start px-3 sm:px-4"
            >
              <BuilderTaskNotice
                task={canonicalCompletedBuilderTask}
                artifactTitle={builderReadyTitle}
                fallbackLabel={builderCompletionFallbackLabel}
                onOpenArtifact={handleViewBuilderArtifactInCanvas}
                openHref={builderOpenHref}
                downloadHref={builderDownloadHref}
                onDownload={() => haptic('medium')}
                onDismiss={dismissVisibleBuilderArtifact}
                compact={true}
              />
            </div>
          )}

          {/* Canonical completed builder surface — voice mode: safe-left corner scene element */}
          {showCanonicalCompletedBuilderEntryCorner
            && builderPrimaryFile
            && canonicalCompletedBuilderTask && (
            <div
              data-testid="canonical-completed-builder-entry"
              data-builder-entry-placement="corner"
              data-builder-entry-overlaps-controls="false"
              className="pointer-events-none fixed bottom-[calc(7.75rem+env(safe-area-inset-bottom,0px))] left-4 z-30 flex w-[min(400px,calc(100vw-2rem))] justify-start sm:bottom-6 sm:left-6"
              style={{ opacity: voiceBuilderAccessoryOpacity, transition: 'opacity 0.6s ease' }}
            >
              <BuilderTaskNotice
                task={canonicalCompletedBuilderTask}
                artifactTitle={builderReadyTitle}
                fallbackLabel={builderCompletionFallbackLabel}
                onOpenArtifact={handleViewBuilderArtifactInCanvas}
                openHref={builderOpenHref}
                downloadHref={builderDownloadHref}
                onDownload={() => haptic('medium')}
                onDismiss={dismissVisibleBuilderArtifact}
                compact={true}
                className="pointer-events-auto max-w-full"
              />
            </div>
          )}

          {/* Session artifact tray — voice mode: safe-right corner scene element,
              mirroring the completed-builder corner entry on the left. */}
          {focusMode !== 'text' && !(showArtifacts && effectiveShowArtifactsUi) && (
            <div
              className="pointer-events-none fixed bottom-[calc(7.75rem+env(safe-area-inset-bottom,0px))] right-4 z-30 flex justify-end sm:bottom-6 sm:right-6"
              style={{ opacity: voiceBuilderAccessoryOpacity, transition: 'opacity 0.6s ease' }}
            >
              <SessionArtifactTrayLauncher
                className="pointer-events-auto"
                sessionArtifactIndex={sessionArtifactIndex}
                threadId={artifactPanelThreadId}
                onSessionArtifactOpen={handleOpenSessionArtifact}
              />
            </div>
          )}

          {/* Voice-mode completion fallback, gated by the same surface arbitration. */}
          {focusMode !== 'text' && builderSurface.showLegacyCompletionFallback && builderCompletionForDisplay && (
            <div
              className="fixed left-1/2 -translate-x-1/2 z-40"
              style={{ bottom: '180px', opacity: voiceBuilderChromeOpacity, transition: 'opacity 0.6s ease' }}
            >
              <BuilderCompletionCard
                event={builderCompletionForDisplay}
                onOpen={handleBuilderCompletionPreview}
                onRetry={handleBuilderRetry}
                onDismiss={handleBuilderCompletionDismiss}
                onDownload={() => haptic('medium')}
                compact={false}
              />
            </div>
          )}
          {focusMode !== 'text'
            && builderSurface.showActiveBuildSteps
            && showBuilderTaskNotice
            && builderTask && (
            <div
              className="fixed left-1/2 -translate-x-1/2 z-40"
              style={{ bottom: '180px', opacity: voiceBuilderChromeOpacity, transition: 'opacity 0.6s ease' }}
            >
              <BuilderTaskNotice
                task={builderTask}
                artifactTitle={builderArtifact?.artifactTitle}
                onOpenArtifact={builderArtifact ? handleViewBuilderArtifactInCanvas : undefined}
                openHref={builderOpenHref}
                downloadHref={builderArtifact ? builderDownloadHref : undefined}
                onDownload={builderArtifact ? () => { haptic('medium'); setTimeout(clearBuilderTask, 1500); } : undefined}
                compact={false}
                onDismiss={clearBuilderTask}
                onCancel={cancelBuilderTask}
                isCancelling={isCancellingBuilderTask}
              />
            </div>
          )}

          {focusMode === 'text' && (
            <div
              className="mb-3 flex flex-col items-center gap-2"
              style={{ opacity: chromeOpacity, transition: 'opacity 0.6s ease' }}
            >
              <ModeToggle
                opacity={chromeOpacity}
                isBusy={isTyping}
                showInsightIndicator={hasArtifactsContent || hasNewArtifacts}
                hasNewInsight={hasNewArtifacts}
                onInsightClick={handleOpenArtifactsPanel}
              />
            </div>
          )}
          
          {/* Attachment bar — chips + status banner. The paperclip
              button itself is rendered INSIDE VoiceFirstComposer via
              the ``slotLeftAction`` prop below so it shares a
              horizontal baseline with the Send button (B4 of the
              silent-attach fix, 2026-05-28). The bar still owns the
              hidden file input; the slot's click delegates back to it
              via ``attachmentPickerRef``. */}
          {focusMode === 'text' && resolvedThreadId && (
            <div className="mb-2 flex flex-col gap-1">
              <AttachmentBar
                threadId={resolvedThreadId}
                disabled={isTyping || isReadOnly}
                hideInternalPaperclip
                openPickerRef={attachmentPickerRef}
              />
              {hasUploadsInFlight && (
                <span
                  className="text-xs text-sophia-text2"
                  data-testid="attachment-bar-uploads-pending-hint"
                  role="status"
                  aria-live="polite"
                >
                  Waiting for upload to finish…
                </span>
              )}
            </div>
          )}

          {/* Voice-First Composer.
              ``disabled`` includes ``hasUploadsInFlight`` so the user
              can't submit while an attachment is still uploading —
              otherwise the in-flight item gets filtered out of
              ``attached_files`` and ``clearForThread`` wipes it
              post-dispatch, orphaning the upload (Codex P2 PR #132).
              In text mode AttachmentBar manages the chips above; in
              voice mode there's no attachment surface, so the gate is
              a no-op there. */}
          <VoiceComposerErrorBoundary>
            <VoiceFirstComposer
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onMicClick={handleMicClick}
              placeholder={isReadOnly ? 'Read-only session' : inputPlaceholder}
              disabled={isTyping || isReadOnly || hasUploadsInFlight}
              inputRef={inputRef}
              justSent={justSent}
              voiceStatus={voiceStatus}
              isTyping={isTyping}
              statusText={isReadOnly ? 'Read-only session' : voiceReadinessStatusText}
              isOffline={isOffline}
              isConnecting={connectivityStatus === 'checking'}
              focusRequestToken={composerFocusToken}
              textOnly={focusMode === 'text'}
              slotLeftAction={attachButtonSlot}
              slotBeforeText={focusMode !== 'text'
                ? (
                    <div
                      className="flex flex-col items-center gap-2"
                      style={{ opacity: chromeOpacity, transition: 'opacity 0.6s ease' }}
                    >
                      <ModeToggle
                        opacity={chromeOpacity}
                        isBusy={isTyping}
                        showInsightIndicator={hasArtifactsContent || hasNewArtifacts}
                        hasNewInsight={hasNewArtifacts}
                        onInsightClick={handleOpenArtifactsPanel}
                      />
                    </div>
                  )
                : undefined}
            />
          </VoiceComposerErrorBoundary>
        </div>

        {showTextArtifactStage && (
          <aside
            data-testid="session-artifact-stage-area"
            className="relative z-10 min-h-0 min-w-0 overflow-hidden px-3 pb-3 lg:pb-6 lg:pl-0 lg:pr-6 lg:pt-16"
            aria-label="Artifact stage area"
          >
            <PresenceArtifactPanel
              artifacts={artifacts}
              builderArtifact={builderArtifact}
              builderArtifactLibrary={builderArtifactLibrary}
              builderTask={builderTask}
              builderCompletion={builderCompletion}
              sessionArtifactIndex={sessionArtifactIndex}
              isCancellingBuilderTask={isCancellingBuilderTask}
              selectedBuilderArtifactPath={selectedBuilderArtifactPath}
              onSelectedBuilderArtifactPathChange={handleSelectBuilderArtifactPath}
              onCoreviewBuilderUpdateRequest={handleCoreviewBuilderUpdateRequest}
              onCoreviewBuilderCancelRequest={handleCoreviewBuilderCancelRequest}
              onCoreviewBuilderViewUpdatedVersion={handleViewCoreviewBuilderUpdatedVersion}
              onSessionArtifactOpen={handleOpenSessionArtifact}
              sessionId={coReviewSessionId}
              normalSessionId={coReviewSessionId}
              voiceAgentSessionId={coReviewVoiceAgentSessionId}
              userId={userId}
              threadId={artifactPanelThreadId}
              isVisible={showArtifacts && effectiveShowArtifactsUi}
              onDismiss={handleCloseArtifactsPanelAndCanvasState}
              isVoiceMode={false}
              coReviewTransport={coReviewTransport}
              pendingBuilderArtifactReview={pendingBuilderArtifactReview}
              onStartVoiceBuilderArtifactReview={handleStartVoiceBuilderArtifactReview}
              onPendingBuilderArtifactReviewConsumed={handlePendingBuilderArtifactReviewConsumed}
              onArtifactReviewVoiceCommandRouteChange={handleArtifactReviewVoiceCommandRouteChange}
              onCoreviewActionFeedback={handleCoreviewActionFeedback}
              onAnnotationActionSucceeded={voiceState.markAnnotationActionSucceeded}
              onReflectionTap={handleReflectionTap ? (r) => handleReflectionTap(r, 'tap') : undefined}
              onMemoryApprove={handleMemoryApprove}
              onMemoryReject={handleMemoryReject}
            />
          </aside>
        )}
        
        {/* Floating artifact panel — voice mode: fixed above mic */}
        {focusMode !== 'text' && (
          <PresenceArtifactPanel
            artifacts={artifacts}
            builderArtifact={builderArtifact}
            builderArtifactLibrary={builderArtifactLibrary}
            builderTask={builderTask}
            builderCompletion={builderCompletion}
            sessionArtifactIndex={sessionArtifactIndex}
            isCancellingBuilderTask={isCancellingBuilderTask}
            selectedBuilderArtifactPath={selectedBuilderArtifactPath}
            onSelectedBuilderArtifactPathChange={handleSelectBuilderArtifactPath}
            onCoreviewBuilderUpdateRequest={handleCoreviewBuilderUpdateRequest}
            onCoreviewBuilderCancelRequest={handleCoreviewBuilderCancelRequest}
            onCoreviewBuilderViewUpdatedVersion={handleViewCoreviewBuilderUpdatedVersion}
            onSessionArtifactOpen={handleOpenSessionArtifact}
            sessionId={coReviewSessionId}
            normalSessionId={coReviewSessionId}
            voiceAgentSessionId={coReviewVoiceAgentSessionId}
            userId={userId}
            threadId={artifactPanelThreadId}
            isVisible={showArtifacts && effectiveShowArtifactsUi}
            onDismiss={handleCloseArtifactsPanelAndCanvasState}
            isVoiceMode={true}
            coReviewTransport={coReviewTransport}
            pendingBuilderArtifactReview={pendingBuilderArtifactReview}
            onStartVoiceBuilderArtifactReview={handleStartVoiceBuilderArtifactReview}
            onPendingBuilderArtifactReviewConsumed={handlePendingBuilderArtifactReviewConsumed}
            onArtifactReviewVoiceCommandRouteChange={handleArtifactReviewVoiceCommandRouteChange}
            onCoreviewActionFeedback={handleCoreviewActionFeedback}
            onAnnotationActionSucceeded={voiceState.markAnnotationActionSucceeded}
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

      <DebriefOfferModal
        isOpen={showDebriefOffer && !!debriefData}
        debriefPrompt={debriefData?.prompt ?? 'Would you like a quick debrief before recap?'}
        durationMinutes={debriefData?.durationMinutes ?? 0}
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
