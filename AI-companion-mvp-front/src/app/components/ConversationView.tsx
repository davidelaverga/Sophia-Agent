"use client"

import { useEffect, useRef, useState, useCallback, lazy, Suspense } from "react"
import { Mic, X } from "lucide-react"
import { AppShell } from "./AppShell"
import { ErrorBoundary } from "./ErrorBoundary"
import { SessionFeedbackToast } from "./SessionFeedbackToast"
import { useChatStore } from "../stores/chat-store"
import { useReflectionPrompt } from "../hooks/useReflectionPrompt"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"
import { useInterrupt } from "../hooks/useInterrupt"

// Feature flag: Set to true to enable Reflections feature
const ENABLE_REFLECTIONS = false
import { useStreamVoiceSession } from "../hooks/useStreamVoiceSession"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useSessionPersistence } from "../hooks/useSessionPersistence"
import { useSupabase } from "../providers"
import { useUsageMonitor } from "../hooks/useUsageMonitor"
import { useBackendTokenSync } from "../hooks/useBackendTokenSync"
import { useChatAiRuntime } from "../chat/useChatAiRuntime"
import { diagnoseMicrophoneAccess, isMicrophoneLikelySupported } from "../lib/microphone-debug"
import { useVoiceStore as useVoiceFallbackStore } from "../stores/voice-store"
import { useRecapStore } from "../stores/recap-store"
import { ingestChatVoiceArtifacts, mapRecapArtifactsToRitualArtifacts } from "../chat/chat-voice-artifacts"
import { useChatArtifactsPanelActions } from "../chat/useChatArtifactsPanelActions"
import { useTranslation } from "../copy"
import { errorCopy } from "../lib/error-copy"
import { ConnectionStatusBanner } from "./ConnectionStatusBanner"
import { DevDiagnosticsPanel } from "./DevDiagnosticsPanel"
import { ArtifactsPanel } from "./session"
import { ArtifactsPanelErrorBoundary } from "./error-boundaries"
import { InterruptCard } from "./session/InterruptCard"
import { RetryAction } from "./ui/RetryAction"

// Import extracted chat components
import { Transcript, Composer } from "./chat"

// Lazy load heavy components that aren't needed immediately
const VoicePanel = lazy(() => import("./VoicePanel").then(mod => ({ default: mod.VoicePanel })))
const VoiceFocusView = lazy(() => import("./VoiceFocusView").then(mod => ({ default: mod.VoiceFocusView })))
const VoiceCollapsed = lazy(() => import("./VoiceCollapsed").then(mod => ({ default: mod.VoiceCollapsed })))
const ReflectionModal = lazy(() => import("./reflection/ReflectionModal").then(mod => ({ default: mod.ReflectionModal })))

export function ConversationView() {
  const { t } = useTranslation()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const applyPrompt = useChatStore((state) => state.applyQuickPrompt)
  const conversationId = useChatStore((state) => state.conversationId)
  const lastCompletedTurnId = useChatStore((state) => state.lastCompletedTurnId)
  const setRecapArtifacts = useRecapStore((state) => state.setArtifacts)
  const recapArtifacts = useRecapStore((state) => (conversationId ? state.artifacts[conversationId] : undefined))
  const chatArtifacts = mapRecapArtifactsToRitualArtifacts(recapArtifacts)
  const { chunks, dismiss } = useReflectionPrompt(conversationId, lastCompletedTurnId)
  const [micSupportWarning, setMicSupportWarning] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumeRetryOptionId, setResumeRetryOptionId] = useState<string | null>(null)
  
  // Focus mode state
  const focusMode = useFocusModeStore((state) => state.mode)
  const setMode = useFocusModeStore((state) => state.setMode)
  const setManualOverride = useFocusModeStore((state) => state.setManualOverride)
  const isManualOverride = useFocusModeStore((state) => state.isManualOverride)
  
  // Voice fallback detection
  const shouldAutoFallback = useVoiceFallbackStore((state) => state.shouldAutoFallback)
  
  // Voice state - SINGLE SOURCE OF TRUTH
  const { user } = useSupabase()
  const {
    pendingInterrupt,
    interruptQueue,
    isResuming,
    handleInterruptSelect,
    handleInterruptSnooze,
    handleInterruptDismiss,
    setInterrupt,
  } = useInterrupt({
    sessionId: conversationId || "chat_pending",
    threadId: undefined,
    presetContext: "life",
    sessionType: "chat",
    onResumeSuccess: (response) => {
      setResumeError(null)
      const responseText = (response || "").trim()
      if (!responseText) return

      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          {
            id: `interrupt-resume-${Date.now()}`,
            role: "sophia",
            content: responseText,
            createdAt: Date.now(),
            status: "complete",
            source: "text",
          },
        ],
      }))
    },
    onResumeError: (error) => {
      if (error.message === "INTERRUPT_EXPIRED") {
        setResumeRetryOptionId(null)
        setResumeError(errorCopy.offerExpired)
        return
      }
      setResumeError(errorCopy.resumeFailed)
    },
  })

  const handleStreamArtifacts = useCallback((artifacts: Record<string, unknown>) => {
    ingestChatVoiceArtifacts({
      artifacts,
      conversationId,
      setArtifacts: setRecapArtifacts,
    })
  }, [conversationId, setRecapArtifacts])

  useChatAiRuntime({
    userId: user?.id,
    onInterrupt: setInterrupt,
    onArtifacts: (artifacts) => handleStreamArtifacts(artifacts),
  })

  const handleVoiceArtifacts = useCallback((artifacts: Record<string, unknown>) => {
    handleStreamArtifacts(artifacts)
  }, [handleStreamArtifacts])

  // Stream voice session hook
  const voiceState = useStreamVoiceSession(user?.id, {
    sessionId: conversationId,
    onArtifacts: handleVoiceArtifacts,
  })
  const voiceStage = voiceState.stage
  const [dismissedVoiceRetry, setDismissedVoiceRetry] = useState(false)

  const showVoiceRetry =
    !dismissedVoiceRetry &&
    voiceStage === "error" &&
    voiceState.hasRetryableVoiceTurn()

  const handleRetryVoiceTurn = useCallback(async () => {
    const retried = await voiceState.retryLastVoiceTurn()
    if (retried) {
      setDismissedVoiceRetry(false)
    }
  }, [voiceState])

  const clearResumeError = useCallback(() => {
    setResumeError(null)
  }, [])

  const handleInterruptSelectWithRetry = useCallback(async (optionId: string) => {
    setResumeRetryOptionId(optionId)
    setResumeError(null)
    await handleInterruptSelect(optionId)
  }, [handleInterruptSelect])

  const handleResumeRetry = useCallback(async () => {
    if (!resumeRetryOptionId) return
    await handleInterruptSelectWithRetry(resumeRetryOptionId)
  }, [resumeRetryOptionId, handleInterruptSelectWithRetry])
  
  // Session persistence - must be at this level to capture all modes (text, voice, full)
  useSessionPersistence()
  
  // Monitor usage and trigger alerts
  useUsageMonitor()
  
  // Auto-sync backend token if missing (handles case where backend was down during OAuth callback)
  const { isSyncing: _isTokenSyncing, syncError: _tokenSyncError } = useBackendTokenSync()
  
  // Track composer focus and interaction
  const [composerHasFocus, setComposerHasFocus] = useState(false)
  const [userIsTyping, setUserIsTyping] = useState(false)
  const isLocked = useChatStore((state) => state.isLocked)

  // Auto-switch validation from domain logic
  const { canAutoSwitch } = useModeSwitch()

  // === Effects ===
  
  // Auto-fallback to text if voice has failed multiple times
  useEffect(() => {
    if (shouldAutoFallback() && focusMode === "voice") {
      setMode("text")
      setManualOverride(true)
    }
  }, [shouldAutoFallback, focusMode, setMode, setManualOverride])
  
  // Check microphone support ONLY when user enters voice mode
  useEffect(() => {
    if (typeof window === "undefined" || focusMode !== "voice") {
      if (focusMode !== "voice") setMicSupportWarning(null)
      return
    }
    
    const checkSupport = async () => {
      try {
        const diagnostics = await diagnoseMicrophoneAccess()
        const supportCheck = isMicrophoneLikelySupported(diagnostics)
        
        if (!supportCheck.supported && supportCheck.issues.length > 0) {
          const criticalIssues = supportCheck.issues.filter(issue => 
            !issue.includes("prompt") && !issue.includes("unknown")
          )
          
          if (criticalIssues.length > 0) {
            setMicSupportWarning(criticalIssues[0])
            const dismissTimer = setTimeout(() => setMicSupportWarning(null), 4000)
            return () => clearTimeout(dismissTimer)
          }
        }
      } catch {
        // Microphone support check failed silently
      }
    }
    
    const timer = setTimeout(checkSupport, 300)
    return () => clearTimeout(timer)
  }, [focusMode])
  
  // Reset voice state when leaving voice mode
  useEffect(() => {
    if (focusMode !== "voice") {
      if (voiceStage === "thinking" || voiceStage === "connecting" || voiceStage === "listening" || voiceStage === "speaking") {
        voiceState.resetVoiceState?.()
      }
    }
  }, [focusMode, voiceStage, voiceState])

  useEffect(() => {
    if (voiceStage === "listening" || voiceStage === "thinking" || voiceStage === "speaking") {
      setDismissedVoiceRetry(false)
    }
  }, [voiceStage])

  // Auto-switch focus mode based on user interaction
  useEffect(() => {
    if (isManualOverride) return
    if (!canAutoSwitch) return

    const isVoiceActive = voiceStage !== "idle" && voiceStage !== "error"

    if (isVoiceActive) {
      if (focusMode !== "voice") setMode("voice")
    } else if (composerHasFocus || userIsTyping) {
      if (focusMode !== "text") setMode("text")
    } else if (isLocked && focusMode === "text") {
      return
    } else {
      if (focusMode === "voice" || focusMode === "text") return
      if (focusMode === "full") return
    }
  }, [voiceStage, composerHasFocus, userIsTyping, isLocked, focusMode, setMode, isManualOverride, canAutoSwitch])

  // Track typing activity
  useEffect(() => {
    if (composerHasFocus) {
      setUserIsTyping(true)
      const timer = setTimeout(() => {
        if (!composerHasFocus) setUserIsTyping(false)
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [composerHasFocus])

  // Reset manual override after inactivity
  useEffect(() => {
    if (isManualOverride) {
      const timer = setTimeout(() => {
        if (voiceStage === "idle" && !composerHasFocus && !userIsTyping && !isLocked) {
          setManualOverride(false)
        }
      }, 30000)
      return () => clearTimeout(timer)
    }
  }, [isManualOverride, setManualOverride, voiceStage, composerHasFocus, userIsTyping, isLocked])

  // === Handlers ===
  
  const handlePromptSelect = useCallback((prompt: string) => {
    applyPrompt(prompt)
    requestAnimationFrame(() => composerRef.current?.focus())
  }, [applyPrompt])

  const {
    memoryInlineFeedback,
    handleReflectionTap,
    handleMemoryApprove,
    handleMemoryReject,
  } = useChatArtifactsPanelActions({
    focusMode,
    setMode,
    setManualOverride,
    handlePromptSelect,
    conversationId,
    recapArtifacts,
    setRecapArtifacts,
  })

  // === Render ===
  
  return (
    <AppShell actionBar={focusMode !== "voice" ? <Composer textareaRef={composerRef} onFocusChange={setComposerHasFocus} /> : undefined}>
      <ConnectionStatusBanner />
      {/* Microphone support warning */}
      {micSupportWarning && focusMode === "voice" && (
        <MicrophoneWarning message={micSupportWarning} onDismiss={() => setMicSupportWarning(null)} />
      )}
      
      <div className="space-y-4 transition-all duration-500 ease-in-out">
        {/* Voice Focus Mode */}
        {focusMode === "voice" && (
          <div>
            <Suspense fallback={<div className="h-48 animate-pulse rounded-2xl bg-sophia-surface" />}>
              <VoiceFocusView voiceState={voiceState} />
            </Suspense>
            {showVoiceRetry && (
              <div className="mt-3 px-1">
                <RetryAction
                  message={t("inputModeIndicator.singleFailure.message")}
                  onRetry={() => {
                    void handleRetryVoiceTurn()
                  }}
                  onDismiss={() => setDismissedVoiceRetry(true)}
                  retryLabel={t("inputModeIndicator.fallback.retryVoice")}
                />
              </div>
            )}
          </div>
        )}

        {/* Text Focus Mode */}
        {focusMode === "text" && (
          <div className="space-y-4">
            <Suspense fallback={<VoiceCollapsedSkeleton />}>
              <VoiceCollapsed />
            </Suspense>
            {pendingInterrupt && !isLocked && (
              <>
                <InterruptCard
                  interrupt={pendingInterrupt}
                  onSelect={handleInterruptSelectWithRetry}
                  onSnooze={pendingInterrupt.kind !== "MICRO_DIALOG" && "snooze" in pendingInterrupt && pendingInterrupt.snooze
                    ? handleInterruptSnooze
                    : undefined}
                  onDismiss={() => {
                    handleInterruptDismiss()
                    clearResumeError()
                  }}
                  isLoading={isResuming}
                />
                {resumeError && resumeRetryOptionId && (
                  <div className="mt-2">
                    <RetryAction
                      message={resumeError}
                      onRetry={() => {
                        void handleResumeRetry()
                      }}
                      onDismiss={clearResumeError}
                    />
                  </div>
                )}
              </>
            )}
            {interruptQueue.length > 0 && (
              <div className="-mt-2 text-center text-xs text-sophia-text2/70">
                +{interruptQueue.length} {interruptQueue.length === 1 ? "question queued" : "questions queued"}
              </div>
            )}
            <Transcript onPromptSelect={handlePromptSelect} />
            {chatArtifacts && (
              <ArtifactsPanelErrorBoundary>
                <ArtifactsPanel
                  artifacts={chatArtifacts}
                  presetType="chat"
                  className="w-full"
                  onReflectionTap={handleReflectionTap}
                  onMemoryApprove={handleMemoryApprove}
                  onMemoryReject={handleMemoryReject}
                  memoryInlineFeedback={memoryInlineFeedback}
                />
              </ArtifactsPanelErrorBoundary>
            )}
          </div>
        )}

        {/* Full View Mode */}
        {focusMode === "full" && (
          <div className="space-y-4">
            <Suspense fallback={<div className="h-32 animate-pulse rounded-2xl bg-sophia-surface" />}>
              <VoicePanel voiceState={voiceState} />
            </Suspense>
            {showVoiceRetry && (
              <div className="px-1">
                <RetryAction
                  message={t("inputModeIndicator.singleFailure.message")}
                  onRetry={() => {
                    void handleRetryVoiceTurn()
                  }}
                  onDismiss={() => setDismissedVoiceRetry(true)}
                  retryLabel={t("inputModeIndicator.fallback.retryVoice")}
                />
              </div>
            )}
            {pendingInterrupt && !isLocked && (
              <>
                <InterruptCard
                  interrupt={pendingInterrupt}
                  onSelect={handleInterruptSelectWithRetry}
                  onSnooze={pendingInterrupt.kind !== "MICRO_DIALOG" && "snooze" in pendingInterrupt && pendingInterrupt.snooze
                    ? handleInterruptSnooze
                    : undefined}
                  onDismiss={() => {
                    handleInterruptDismiss()
                    clearResumeError()
                  }}
                  isLoading={isResuming}
                />
                {resumeError && resumeRetryOptionId && (
                  <div className="mt-2">
                    <RetryAction
                      message={resumeError}
                      onRetry={() => {
                        void handleResumeRetry()
                      }}
                      onDismiss={clearResumeError}
                    />
                  </div>
                )}
              </>
            )}
            {interruptQueue.length > 0 && (
              <div className="-mt-2 text-center text-xs text-sophia-text2/70">
                +{interruptQueue.length} {interruptQueue.length === 1 ? "question queued" : "questions queued"}
              </div>
            )}
            <Transcript onPromptSelect={handlePromptSelect} />
            {chatArtifacts && (
              <ArtifactsPanelErrorBoundary>
                <ArtifactsPanel
                  artifacts={chatArtifacts}
                  presetType="chat"
                  className="w-full"
                  onReflectionTap={handleReflectionTap}
                  onMemoryApprove={handleMemoryApprove}
                  onMemoryReject={handleMemoryReject}
                  memoryInlineFeedback={memoryInlineFeedback}
                />
              </ArtifactsPanelErrorBoundary>
            )}
          </div>
        )}
      </div>
      
      {/* Feedback toast - only in chat mode */}
      {!chunks && focusMode !== "voice" && <SessionFeedbackToast />}
      
      {/* Reflection modal */}
      {ENABLE_REFLECTIONS && chunks && conversationId && (
        <ErrorBoundary componentName="ReflectionModal">
          <Suspense fallback={null}>
            <ReflectionModal conversationId={conversationId} chunks={chunks} onClose={dismiss} />
          </Suspense>
        </ErrorBoundary>
      )}

      <DevDiagnosticsPanel />
    </AppShell>
  )
}

// Skeleton that matches VoiceCollapsed layout for smooth transition
function VoiceCollapsedSkeleton() {
  return (
    <div className="w-full rounded-2xl bg-sophia-surface p-4 shadow-soft">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-sophia-purple/10 animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-32 rounded bg-sophia-purple/15 animate-pulse" />
          <div className="h-3 w-48 rounded bg-sophia-purple/10 animate-pulse" />
        </div>
        <div className="w-5 h-5 rounded bg-sophia-purple/10 animate-pulse" />
      </div>
    </div>
  )
}

// Small inline component for microphone warning
function MicrophoneWarning({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation()

  return (
    <div className="mx-auto max-w-2xl animate-fadeIn">
      <div className="rounded-2xl border border-sophia-surface-border bg-sophia-surface px-4 py-3 shadow-soft">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-sophia-purple/10">
            <Mic className="h-3 w-3 text-sophia-purple" />
          </div>
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium text-sophia-text">{t("conversationView.microphoneAccessTitle")}</p>
            <p className="text-xs leading-relaxed text-sophia-text2">{message}</p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="flex-shrink-0 rounded-lg p-1 text-sophia-text2/60 transition-colors hover:bg-sophia-purple/10 hover:text-sophia-purple"
            aria-label={t("conversationView.dismissAriaLabel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

