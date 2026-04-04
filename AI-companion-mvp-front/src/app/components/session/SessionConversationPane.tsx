'use client';

import type { RefObject } from 'react';
import { Lock } from 'lucide-react';
import { InterruptCardErrorBoundary } from '../error-boundaries';
import { StreamError } from '../ui';
import { RetryAction } from '../ui/RetryAction';
import type {
  ContextMode,
  InterruptPayload,
  InvokeType,
  MemoryHighlight,
  PresetType,
  ResolvedInterrupt,
} from '../../types/session';
import type { FeedbackType } from '../../types/sophia-ui-message';
import { MemoryHighlightCards } from './MemoryHighlightCard';
import { MessageBubble, type UIMessage } from './MessageBubble';
import { NudgeBanner, type NudgeSuggestion } from './NudgeBanner';
import { ReflectionPromptBubble, ReflectionResponseBubble } from './ReflectionBubble';
import { ResolvedInterruptBadge } from './ResolvedInterruptBadge';
import { SessionEmptyState } from './SessionEmptyState';
// TypingIndicator removed — replaced with whisper text (R28)
import { InterruptCard } from './InterruptCard';
import { OnboardingTipGuard } from '../onboarding';

interface SessionConversationPaneProps {
  messages: UIMessage[];
  isInitializingChat: boolean;
  sessionPresetType?: PresetType;
  sessionContextMode?: ContextMode;
  onPromptSelect: (prompt: string) => void;
  reflectionPrefix: string;
  getReflectionWhy: (prompt?: string) => string | undefined;
  feedbackByMessage: Record<string, FeedbackType | undefined>;
  onFeedback: (messageId: string, feedback: FeedbackType) => void;
  greetingAnchorId: string | null;
  memoryHighlights?: MemoryHighlight[];
  resolvedInterrupts: ResolvedInterrupt[];
  pendingInterrupt: InterruptPayload | null;
  isTyping: boolean;
  isReadOnly: boolean;
  onInterruptSelectWithRetry: (optionId: string) => Promise<void>;
  onInterruptSnooze: () => void;
  onInterruptDismiss: () => void;
  isResuming: boolean;
  resumeError: string | null;
  resumeRetryOptionId: string | null;
  onResumeRetry: () => void;
  onDismissResumeError: () => void;
  interruptQueueLength: number;
  showScaffold: boolean;
  showThinkingIndicator: boolean;
  isVoiceThinking: boolean;
  onCancelThinking: () => void;
  cancelledMessageId: string | null;
  cancelledRetryMessage: string;
  onRetryCancelled: () => void;
  onDismissCancelled: () => void;
  voiceRetryState: { message: string } | null;
  onRetryVoice: () => void;
  onDismissVoiceRetry: () => void;
  chatError: Error | undefined;
  dismissedError: boolean;
  onRetryStreamError: () => void;
  onDismissStreamError: () => void;
  messagesEndRef: RefObject<HTMLDivElement>;
  nudgeSuggestion: NudgeSuggestion | null;
  onNudgeAccept: (actionType: InvokeType) => void;
  onNudgeDismiss: () => void;
  onGoToDashboard: () => void;
}

export function SessionConversationPane({
  messages,
  isInitializingChat,
  sessionPresetType,
  sessionContextMode,
  onPromptSelect,
  reflectionPrefix,
  getReflectionWhy,
  feedbackByMessage,
  onFeedback,
  greetingAnchorId,
  memoryHighlights,
  resolvedInterrupts,
  pendingInterrupt,
  isTyping,
  isReadOnly,
  onInterruptSelectWithRetry,
  onInterruptSnooze,
  onInterruptDismiss,
  isResuming,
  resumeError,
  resumeRetryOptionId,
  onResumeRetry,
  onDismissResumeError,
  interruptQueueLength,
  showScaffold,
  showThinkingIndicator,
  isVoiceThinking,
  onCancelThinking,
  cancelledMessageId,
  cancelledRetryMessage,
  onRetryCancelled,
  onDismissCancelled,
  voiceRetryState,
  onRetryVoice,
  onDismissVoiceRetry,
  chatError,
  dismissedError,
  onRetryStreamError,
  onDismissStreamError,
  messagesEndRef,
  nudgeSuggestion,
  onNudgeAccept,
  onNudgeDismiss,
  onGoToDashboard,
}: SessionConversationPaneProps) {
  return (
    <>
      {isReadOnly && (
        <div className="px-4 py-2 animate-fadeIn">
          <div className="max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.04] backdrop-blur-sm px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center">
                  <Lock className="w-4 h-4 text-white/40" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white/60 truncate">Read-only session</p>
                  <p className="text-xs text-white/30">This conversation has ended. Start a new session to continue.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onGoToDashboard}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium text-white/60 bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.10] transition-colors"
              >
                Go to dashboard
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scroll-pb-4 [scrollbar-color:rgba(255,255,255,0.06)_transparent] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-white/[0.06] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
        {messages.length === 0 && isInitializingChat ? (
          <div className="p-4 pb-6 max-w-3xl lg:max-w-4xl mx-auto animate-pulse">
            <div className="max-w-[70%] px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.03]">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-full bg-white/[0.06]" />
                <div className="h-3 w-12 bg-white/[0.06] rounded" />
              </div>
              <div className="space-y-2">
                <div className="h-4 bg-white/[0.06] rounded w-full" />
                <div className="h-4 bg-white/[0.06] rounded w-3/4" />
              </div>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <SessionEmptyState
            presetType={sessionPresetType!}
            contextMode={sessionContextMode!}
            onPromptSelect={onPromptSelect}
            className="h-full animate-fadeIn"
          />
        ) : (
          <div
            data-onboarding="session-conversation"
            className="p-4 pb-6 space-y-5 max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto"
            role="log"
            aria-live="polite"
            aria-label="Conversation with Sophia"
          >
            {messages.map((message, index) => {
              const isReflectionPrompt = message.role === 'user' && message.content.startsWith(reflectionPrefix);
              const prevMsg = index > 0 ? messages[index - 1] : null;
              const isReflectionResponse =
                message.role === 'assistant' &&
                prevMsg?.role === 'user' &&
                prevMsg.content.startsWith(reflectionPrefix);

              const reflectionPromptText = isReflectionPrompt
                ? message.content.slice(reflectionPrefix.length)
                : isReflectionResponse && prevMsg
                  ? prevMsg.content.slice(reflectionPrefix.length)
                  : undefined;
              const reflectionWhy = getReflectionWhy(reflectionPromptText);

              return (
                <div key={message.id}>
                  {isReflectionPrompt ? (
                    <ReflectionPromptBubble
                      message={{
                        ...message,
                        feedback: feedbackByMessage[message.id],
                      }}
                      reflectionPrompt={reflectionPromptText || message.content}
                      reflectionWhy={reflectionWhy}
                    />
                  ) : isReflectionResponse ? (
                    <ReflectionResponseBubble
                      message={{
                        ...message,
                        feedback: feedbackByMessage[message.id],
                      }}
                      isLatest={index === messages.length - 1}
                      onFeedback={onFeedback}
                    />
                  ) : (
                    <MessageBubble
                      message={{
                        ...message,
                        feedback: feedbackByMessage[message.id],
                      }}
                      isLatest={index === messages.length - 1 && message.role === 'assistant'}
                      onFeedback={onFeedback}
                    />
                  )}

                  {message.role === 'assistant' &&
                    greetingAnchorId &&
                    message.id === greetingAnchorId &&
                    memoryHighlights &&
                    memoryHighlights.length > 0 && (
                      <>
                        <MemoryHighlightCards
                          highlights={memoryHighlights}
                          maxDisplay={3}
                          className="mt-4 ml-0 sm:ml-10"
                        />
                      </>
                    )}
                </div>
              );
            })}

            {resolvedInterrupts.map((resolved, idx) => (
              <ResolvedInterruptBadge key={`resolved-${idx}-${resolved.resolvedAt}`} resolved={resolved} />
            ))}

            {pendingInterrupt && !isTyping && !isReadOnly && (
              <div className="animate-fadeIn">
                <OnboardingTipGuard tipId="tip-first-interruption" isTriggered={Boolean(pendingInterrupt)} />
                <InterruptCardErrorBoundary onDismiss={onInterruptDismiss}>
                  <InterruptCard
                    interrupt={pendingInterrupt}
                    onSelect={onInterruptSelectWithRetry}
                    onSnooze={pendingInterrupt.kind !== 'MICRO_DIALOG' && 'snooze' in pendingInterrupt && pendingInterrupt.snooze
                      ? onInterruptSnooze
                      : undefined}
                    onDismiss={onInterruptDismiss}
                    isLoading={isResuming}
                  />
                </InterruptCardErrorBoundary>

                {resumeError && resumeRetryOptionId && (
                  <div className="mt-2">
                    <RetryAction
                      message={resumeError}
                      onRetry={onResumeRetry}
                      onDismiss={onDismissResumeError}
                    />
                  </div>
                )}

                {interruptQueueLength > 0 && (
                  <p className="text-center text-[10px] text-white/20 mt-1">
                    +{interruptQueueLength} more {interruptQueueLength === 1 ? 'question' : 'questions'} queued
                  </p>
                )}
              </div>
            )}

            {showScaffold && messages.length === 1 && sessionPresetType && sessionContextMode && <></>}

            {showThinkingIndicator && (
              <div className="px-4 py-3">
                {isVoiceThinking ? (
                  /* Voice mode: nebula handles thinking visual, just show cancel */
                  <button
                    onClick={onCancelThinking}
                    className="text-[10px] tracking-[0.18em] lowercase text-white/10 hover:text-white/25 transition-colors duration-300"
                  >
                    stop
                  </button>
                ) : (
                  /* Text mode: whisper-style reflecting indicator */
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] tracking-[0.18em] lowercase text-white/10 transition-colors duration-1000">
                      sophia is reflecting...
                    </span>
                    <button
                      onClick={onCancelThinking}
                      className="text-[10px] tracking-[0.18em] lowercase text-white/10 hover:text-white/25 transition-colors duration-300"
                    >
                      cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {cancelledMessageId && !showThinkingIndicator && (
              <div className="px-4 py-3">
                <RetryAction
                  message={cancelledRetryMessage}
                  onRetry={onRetryCancelled}
                  onDismiss={onDismissCancelled}
                />
              </div>
            )}

            {voiceRetryState && !showThinkingIndicator && !cancelledMessageId && (
              <div className="px-4 py-3">
                <RetryAction
                  message={voiceRetryState.message}
                  onRetry={onRetryVoice}
                  onDismiss={onDismissVoiceRetry}
                />
              </div>
            )}

            {chatError && !dismissedError && !isTyping &&
              !(chatError.message?.includes('offline') || chatError.message?.includes('Backend unavailable')) && (
                <StreamError
                  error={chatError}
                  onRetry={onRetryStreamError}
                  onDismiss={onDismissStreamError}
                />
              )}

            <div ref={messagesEndRef} className="h-4" />
          </div>
        )}
      </div>

      {nudgeSuggestion && (
        <NudgeBanner
          suggestion={nudgeSuggestion}
          onAccept={onNudgeAccept}
          onDismiss={onNudgeDismiss}
        />
      )}
    </>
  );
}