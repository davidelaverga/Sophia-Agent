'use client';

import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, Settings } from 'lucide-react';
import type { MemoryHighlight, RitualArtifacts } from '../../types/session';
import {
  ArtifactsPanel,
  ArtifactsRail,
  CompanionRail,
  SessionConversationPane,
  VoiceFirstComposer,
  type UIMessage,
} from '../session';
import { ThemeToggle } from '../ThemeToggle';
import { useOnboardingStore } from '../../stores/onboarding-store';

/* ---------- mock data ---------- */

const MOCK_ARTIFACTS: RitualArtifacts = {
  takeaway: 'You get clearer once you say the pressure out loud instead of carrying it silently.',
  reflection_candidate: {
    prompt: 'What changed in your body once you named the pressure directly?',
    why: 'Reflection is useful when Sophia notices there is something worth slowing down and exploring.',
  },
  memory_candidates: [
    {
      memory: 'Naming the pressure directly helps you regain clarity faster.',
      category: 'emotional_patterns',
      confidence: 0.94,
    },
    {
      memory: 'You respond well when the next step is concrete and spoken out loud.',
      category: 'regulation_tools',
      confidence: 0.88,
    },
  ],
  session_type: 'prepare',
  preset_context: 'life',
};

const MOCK_MEMORY_HIGHLIGHTS: MemoryHighlight[] = [
  {
    id: 'mh-1',
    text: 'Naming the pressure directly helps you regain clarity faster.',
    category: 'emotional',
    salience: 0.94,
    recency_label: '2 days ago',
  },
  {
    id: 'mh-2',
    text: 'You respond well when the next step is concrete and spoken out loud.',
    category: 'reflective',
    salience: 0.88,
    recency_label: '5 days ago',
  },
];

const GREETING_MESSAGE_ID = 'onboarding-greeting';

const MOCK_MESSAGES: UIMessage[] = [
  {
    id: GREETING_MESSAGE_ID,
    role: 'assistant',
    content: 'Good to see you. Before we start — I remember a couple of things that might matter right now.',
    createdAt: new Date('2026-03-08T11:59:50.000Z').toISOString(),
  },
  {
    id: 'onboarding-user-1',
    role: 'user',
    content: 'I need to get my head straight before I go back in.',
    createdAt: new Date('2026-03-08T12:00:00.000Z').toISOString(),
  },
  {
    id: 'onboarding-assistant-1',
    role: 'assistant',
    content: 'Good. Start by naming the pressure instead of solving all of it at once.',
    createdAt: new Date('2026-03-08T12:00:10.000Z').toISOString(),
  },
];

/* ---------- artifact visibility per step ---------- */

const ARTIFACT_PANEL_STEPS = new Set([
  'artifacts-takeaway',
  'artifacts-reflection',
  'artifacts-memory',
]);

const COMPANION_STEP_ID = 'session-companions';

function getArtifactStatusForStep(stepId: string | null) {
  if (stepId === 'artifacts-takeaway') {
    return { takeaway: 'ready' as const, reflection: 'waiting' as const, memories: 'waiting' as const };
  }
  if (stepId === 'artifacts-reflection') {
    return { takeaway: 'ready' as const, reflection: 'ready' as const, memories: 'waiting' as const };
  }
  if (stepId === 'artifacts-memory') {
    return { takeaway: 'ready' as const, reflection: 'ready' as const, memories: 'ready' as const };
  }
  return { takeaway: 'ready' as const, reflection: 'ready' as const, memories: 'ready' as const };
}

function getArtifactsForStep(stepId: string | null): RitualArtifacts | undefined {
  if (stepId === 'artifacts-takeaway') {
    return { ...MOCK_ARTIFACTS, reflection_candidate: undefined, memory_candidates: [] };
  }
  if (stepId === 'artifacts-reflection') {
    return { ...MOCK_ARTIFACTS, memory_candidates: [] };
  }
  return MOCK_ARTIFACTS;
}

/* ---------- component ---------- */

export function OnboardingSessionExperience() {
  const currentStepId = useOnboardingStore((state) => state.currentStepId);
  const [composerValue, setComposerValue] = useState('');
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [memoryInlineFeedback, setMemoryInlineFeedback] = useState<{
    index: number;
    message: string;
    variant?: 'error' | 'info' | 'success';
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const showArtifactsPanel = ARTIFACT_PANEL_STEPS.has(currentStepId ?? '');
  const showCompanionPopover = currentStepId === COMPANION_STEP_ID;
  const artifactStatus = useMemo(() => getArtifactStatusForStep(currentStepId), [currentStepId]);
  const visibleArtifacts = useMemo(() => getArtifactsForStep(currentStepId), [currentStepId]);
  const reflectionPrompt = useMemo(() => MOCK_ARTIFACTS.reflection_candidate?.prompt ?? '', []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-transparent text-sophia-text">
      {/* ---- header: matches real SessionLayout ---- */}
      <header className="bg-sophia-surface/80 backdrop-blur-sm border-b border-sophia-surface-border px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1">
            <div className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button">
              <ArrowLeft className="w-5 h-5 text-sophia-text2" />
            </div>
            <h1 className="font-semibold flex items-center gap-2 text-sophia-text text-sm sm:text-base">
              <span className="text-base sm:text-lg" aria-hidden="true">🌟</span>
              <span>Preparation</span>
            </h1>
          </div>

          <div className="flex-1 flex justify-center">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-sophia-surface/50">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <Clock className="w-3.5 h-3.5 text-sophia-text2" />
              <span className="tabular-nums text-sm text-sophia-text2">0:42</span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-1 justify-end">
            <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-sophia-text2">
              End
            </span>
            <ThemeToggle dataOnboardingId="header-theme-toggle" />
            <button
              type="button"
              data-onboarding="header-settings"
              className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button"
            >
              <Settings className="w-5 h-5 text-sophia-text2" />
            </button>
          </div>
        </div>
      </header>

      {/* ---- main content area ---- */}
      <div className="relative flex flex-1 overflow-hidden">
        <div className="fixed left-0 top-1/2 z-30 hidden h-10 w-10 -translate-y-1/2 lg:flex">
          <CompanionRail
            contextMode="life"
            onInvoke={async () => undefined}
            disabled={false}
            forceOpen={showCompanionPopover}
            triggerOnboardingId="companion-rail-trigger"
            popoverOnboardingId="companion-rail-popover"
          />
        </div>

        <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
          <SessionConversationPane
            messages={MOCK_MESSAGES}
            isInitializingChat={false}
            sessionPresetType="prepare"
            sessionContextMode="life"
            onPromptSelect={() => undefined}
            reflectionPrefix=""
            getReflectionWhy={() => undefined}
            feedbackByMessage={{}}
            onFeedback={() => undefined}
            greetingAnchorId={GREETING_MESSAGE_ID}
            memoryHighlights={MOCK_MEMORY_HIGHLIGHTS}
            resolvedInterrupts={[]}
            pendingInterrupt={null}
            isTyping={false}
            isReadOnly={false}
            onInterruptSelectWithRetry={async () => undefined}
            onInterruptSnooze={() => undefined}
            onInterruptDismiss={() => undefined}
            isResuming={false}
            resumeError={null}
            resumeRetryOptionId={null}
            onResumeRetry={() => undefined}
            onDismissResumeError={() => undefined}
            interruptQueueLength={0}
            showScaffold={false}
            showThinkingIndicator={false}
            isVoiceThinking={false}
            onCancelThinking={() => undefined}
            cancelledMessageId={null}
            cancelledRetryMessage=""
            onRetryCancelled={() => undefined}
            onDismissCancelled={() => undefined}
            voiceRetryState={null}
            onRetryVoice={() => undefined}
            onDismissVoiceRetry={() => undefined}
            chatError={undefined}
            dismissedError={false}
            onRetryStreamError={() => undefined}
            onDismissStreamError={() => undefined}
            messagesEndRef={messagesEndRef}
            nudgeSuggestion={null}
            onNudgeAccept={() => undefined}
            onNudgeDismiss={() => undefined}
            onGoToDashboard={() => undefined}
          />

          <VoiceFirstComposer
            value={composerValue}
            onChange={setComposerValue}
            onSubmit={() => undefined}
            onMicClick={() => undefined}
            placeholder="Talk to Sophia"
            inputRef={inputRef}
            voiceStatus="ready"
            statusText="Sophia — Ready"
            focusRequestToken={focusRequestToken}
            containerOnboardingId="session-composer"
            micOnboardingId="session-mic-cta"
          />
        </div>

        {showArtifactsPanel ? (
          <div className="relative z-10 hidden w-[380px] flex-col border-l border-sophia-surface-border bg-sophia-surface/40 backdrop-blur-sm lg:flex">
            <ArtifactsPanel
              artifacts={visibleArtifacts}
              presetType="prepare"
              contextMode="life"
              className="flex-1"
              artifactStatus={artifactStatus}
              onReflectionTap={() => {
                setComposerValue(reflectionPrompt);
                setFocusRequestToken((value) => value + 1);
              }}
              onMemoryApprove={(index) => {
                setMemoryInlineFeedback({
                  index,
                  message: 'Saved for Sophia. You stay in control of every memory.',
                  variant: 'success',
                });
              }}
              onMemoryReject={(index) => {
                setMemoryInlineFeedback({
                  index,
                  message: 'Skipped. Sophia will not save it.',
                  variant: 'info',
                });
              }}
              memoryInlineFeedback={memoryInlineFeedback}
            />
          </div>
        ) : (
          <div className="fixed right-0 top-1/2 z-30 hidden h-10 w-10 -translate-y-1/2 cursor-pointer rounded-l-lg lg:flex">
            <ArtifactsRail
              artifactStatus={artifactStatus}
              onClick={() => undefined}
              dataOnboardingId="artifacts-rail"
            />
          </div>
        )}
      </div>
    </div>
  );
}