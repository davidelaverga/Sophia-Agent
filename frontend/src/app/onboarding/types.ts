export const ONBOARDING_STORAGE_KEY = "sophia-onboarding-v2"
export const LEGACY_ONBOARDING_STORAGE_KEY = "sophia-onboarding"

export const FIRST_RUN_STEP_IDS = [
  "welcome",
  "dashboard-presets",
  "dashboard-rituals",
  "dashboard-mic",
  "session-concept",
  "session-theme-toggle",
  "session-settings",
  "session-composer",
  "session-companions",
  "artifacts-entry",
  "artifacts-takeaway",
  "artifacts-reflection",
  "artifacts-memory",
  "recap-memory-keep",
  "recap-memory-discard",
  "recap-memory-save",
  "ready",
] as const

export const CONTEXTUAL_TIP_IDS = [
  "tip-first-artifacts",
  "tip-first-memory-candidate",
  "tip-first-recap",
  "tip-first-interruption",
  "tip-first-ritual-suggestion",
  "tip-first-bootstrap-memory",
] as const

export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number]
export type ContextualTipId = (typeof CONTEXTUAL_TIP_IDS)[number]
export type OnboardingFirstRunStatus = "not_started" | "in_progress" | "skipped" | "completed"
export type OnboardingPhase = "first-run" | "contextual"
export type OnboardingTargetShape = "circle" | "rounded-rect"
export type OnboardingTooltipPosition = "top" | "bottom" | "left" | "right" | "center"
export type OnboardingAdvanceMode = "click-next" | "interact-target" | "auto-delay"
export type OnboardingTriggerType = "element-visible" | "store-value" | "event"

export type OnboardingTargetConfig = {
  selector: string | string[]
  padding?: number
  shape: OnboardingTargetShape
}

export type OnboardingTargetRect = {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export type OnboardingCopyBlock = {
  title: string
  body: string
  voiceLine: string | null
  position: OnboardingTooltipPosition
  primaryActionLabel: string
}

export type OnboardingFirstRunState = {
  status: OnboardingFirstRunStatus
  currentStepId: FirstRunStepId | null
  completedSteps: FirstRunStepId[]
  skippedAt: string | null
  completedAt: string | null
}

export type OnboardingTipState = {
  seen: boolean
  seenAt: string | null
  dismissed: boolean
}

export type OnboardingPreferences = {
  voiceOverEnabled: boolean
  reducedMotion: boolean
}

export type FirstRunOnboardingStepConfig = {
  id: FirstRunStepId
  phase: "first-run"
  route: string
  target: OnboardingTargetConfig | null
  content: OnboardingCopyBlock
  advanceOn: OnboardingAdvanceMode
  autoDelayMs?: number
  canGoBack: boolean
}

export type OnboardingTriggerConfig = {
  type: OnboardingTriggerType
  config: Record<string, unknown>
}

export type ContextualOnboardingTipConfig = {
  id: ContextualTipId
  phase: "contextual"
  route: string
  target: OnboardingTargetConfig
  content: OnboardingCopyBlock
  trigger: OnboardingTriggerConfig
  delayMs: number
}

export type LegacyOnboardingStep = "welcome" | "voice" | "text" | "privacy" | "complete"