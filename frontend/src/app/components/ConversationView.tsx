"use client"

import { Mic, X } from "lucide-react"
import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react"

import { useChatArtifactsPanelActions } from "../chat/useChatArtifactsPanelActions"
import type { ChatRouteExperience } from "../chat/useChatRouteExperience"
import { useTranslation } from "../copy"
import { useModeSwitch } from "../hooks/useModeSwitch"
import { useReflectionPrompt } from "../hooks/useReflectionPrompt"
import { buildThreadArtifactHref, getBuilderArtifactFiles } from "../lib/builder-artifacts"
import { diagnoseMicrophoneAccess, isMicrophoneLikelySupported } from "../lib/microphone-debug"
import { useChatStore } from "../stores/chat-store"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"
import { useVoiceStore as useVoiceFallbackStore } from "../stores/voice-store"

import { AppShell } from "./AppShell"
import { Transcript, Composer } from "./chat"
import { ConnectionStatusBanner } from "./ConnectionStatusBanner"
import { DevDiagnosticsPanel } from "./DevDiagnosticsPanel"
import { ArtifactsPanelErrorBoundary } from "./error-boundaries"
import { ErrorBoundary } from "./ErrorBoundary"
import { ModeToggle } from "./ModeToggle"
import { ArtifactsPanel } from "./session"
import { BuilderTaskNotice } from "./session/BuilderTaskNotice"
import { InterruptCard } from "./session/InterruptCard"
import { SessionFeedbackToast } from "./SessionFeedbackToast"
import { RetryAction } from "./ui/RetryAction"

// Feature flag: Set to true to enable Reflections feature
const ENABLE_REFLECTIONS = false

// Lazy load heavy components that aren't needed immediately
const VoiceFocusView = lazy(() => import("./VoiceFocusView").then(mod => ({ default: mod.VoiceFocusView })))
const ReflectionModal = lazy(() => import("./reflection/ReflectionModal").then(mod => ({ default: mod.ReflectionModal })))

type ConversationViewProps = {
  routeExperience: ChatRouteExperience
}

export function ConversationView({ routeExperience }: ConversationViewProps) {
  const { t } = useTranslation()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const artifactsPanelRef = useRef<HTMLDivElement>(null)
  const applyPrompt = useChatStore((state) => state.applyQuickPrompt)
  const lastCompletedTurnId = useChatStore((state) => state.lastCompletedTurnId)
  const {
    conversationId,
    threadId,
    recapArtifacts,
    setRecapArtifacts,
    chatArtifacts,
    builderArtifact,
    builderTask,
    clearBuilderTask,
    cancelBuilderTask,
    isCancellingBuilderTask,
    voiceState,
    pendingInterrupt,
    interruptQueue,
    isResuming,
    resumeError,
    canRetryResume,
    handleInterruptSelect,
    handleInterruptSnooze,
    handleInterruptDismiss,
    handleResumeRetry,
    clearResumeError,
  } = routeExperience
  const { chunks, dismiss } = useReflectionPrompt(conversationId, lastCompletedTurnId)
  const [micSupportWarning, setMicSupportWarning] = useState<string | null>(null)
  
  // Focus mode state
  const focusMode = useFocusModeStore((state) => state.mode)
  const setMode = useFocusModeStore((state) => state.setMode)
  const setManualOverride = useFocusModeStore((state) => state.setManualOverride)
  const isManualOverride = useFocusModeStore((state) => state.isManualOverride)
  
  // Voice fallback detection
  const shouldAutoFallback = useVoiceFallbackStore((state) => state.shouldAutoFallback)
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
    
    const timer = setTimeout(() => {
      void checkSupport()
    }, 300)
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

  const builderPrimaryFile = useMemo(
    () => getBuilderArtifactFiles(builderArtifact)[0] ?? null,
    [builderArtifact],
  )
  const builderDownloadHref = useMemo(
    () => buildThreadArtifactHref(threadId, builderPrimaryFile?.path, { download: true }),
    [builderPrimaryFile?.path, threadId],
  )

  const handleOpenBuilderArtifact = useCallback(() => {
    if (focusMode === 'voice') {
      setMode('text')
      setManualOverride(true)
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        artifactsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }, [focusMode, setMode, setManualOverride])

  const showBuilderTaskNotice = Boolean(builderTask)

  // === Render ===
  
  return (
    <AppShell actionBar={focusMode !== "voice" ? <Composer textareaRef={composerRef} onFocusChange={setComposerHasFocus} /> : undefined}>
      <ConnectionStatusBanner />
      {/* Microphone support warning */}
      {micSupportWarning && focusMode === "voice" && (
        <MicrophoneWarning message={micSupportWarning} onDismiss={() => setMicSupportWarning(null)} />
      )}
      
      <div className="space-y-4 transition-all duration-500 ease-in-out">
        {/* Mode Toggle — shown in all modes */}
        <ModeToggle />

        {/* Voice Focus Mode */}
        {focusMode === "voice" && (
          <div>
            <Suspense fallback={<div className="h-48 animate-pulse rounded-2xl bg-sophia-surface" />}>
              <VoiceFocusView voiceState={voiceState} />
            </Suspense>
            {showBuilderTaskNotice && builderTask && (
              <BuilderTaskNotice
                task={builderTask}
                artifactTitle={builderArtifact?.artifactTitle}
                onOpenArtifact={builderArtifact ? handleOpenBuilderArtifact : undefined}
                downloadHref={builderArtifact ? builderDownloadHref : undefined}
                compact={true}
                onDismiss={clearBuilderTask}
                onCancel={cancelBuilderTask}
                isCancelling={isCancellingBuilderTask}
              />
            )}
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
            {/* Typing indicator replaces VoiceCollapsed in text mode */}
            {isLocked && (
              <div className="flex items-center justify-center gap-2 py-3 text-sophia-text2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-sophia-purple opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-sophia-purple" />
                </span>
                <span className="text-xs font-medium animate-pulse">Sophia is thinking...</span>
              </div>
            )}
            {pendingInterrupt && !isLocked && (
              <>
                <InterruptCard
                  interrupt={pendingInterrupt}
                  onSelect={handleInterruptSelect}
                  onSnooze={pendingInterrupt.kind !== "MICRO_DIALOG" && "snooze" in pendingInterrupt && pendingInterrupt.snooze
                    ? handleInterruptSnooze
                    : undefined}
                  onDismiss={handleInterruptDismiss}
                  isLoading={isResuming}
                />
                {resumeError && canRetryResume && (
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
            {showBuilderTaskNotice && builderTask && (
              <BuilderTaskNotice
                task={builderTask}
                artifactTitle={builderArtifact?.artifactTitle}
                onOpenArtifact={builderArtifact ? handleOpenBuilderArtifact : undefined}
                downloadHref={builderArtifact ? builderDownloadHref : undefined}
                onDismiss={clearBuilderTask}
                onCancel={cancelBuilderTask}
                isCancelling={isCancellingBuilderTask}
              />
            )}
            <Transcript onPromptSelect={handlePromptSelect} />
            {(chatArtifacts || builderArtifact) && (
              <div ref={artifactsPanelRef}>
                <ArtifactsPanelErrorBoundary>
                  <ArtifactsPanel
                    artifacts={chatArtifacts}
                    builderArtifact={builderArtifact}
                    presetType="chat"
                    sessionId={conversationId}
                    threadId={threadId}
                    className="w-full"
                    onReflectionTap={handleReflectionTap}
                    onMemoryApprove={handleMemoryApprove}
                    onMemoryReject={handleMemoryReject}
                    memoryInlineFeedback={memoryInlineFeedback}
                  />
                </ArtifactsPanelErrorBoundary>
              </div>
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

