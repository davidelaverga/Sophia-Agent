"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  getInitialFirstRunStepId,
  getNextFirstRunStepId,
  isFirstRunStepId,
} from "../onboarding/first-run-steps"
import {
  CONTEXTUAL_TIP_IDS,
  LEGACY_ONBOARDING_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  type ContextualTipId,
  type FirstRunStepId,
  type LegacyOnboardingStep,
  type OnboardingFirstRunState,
  type OnboardingPreferences,
  type OnboardingTipState,
} from "../onboarding/types"

type OnboardingPersistedState = {
  firstRun: OnboardingFirstRunState
  contextualTips: Partial<Record<ContextualTipId, OnboardingTipState>>
  preferences: OnboardingPreferences
  legacyStep: LegacyOnboardingStep
}

export type OnboardingStep = LegacyOnboardingStep

export type OnboardingStore = {
  firstRun: OnboardingFirstRunState
  currentStepId: FirstRunStepId | null
  hasCompletedFirstRun: boolean
  isActive: boolean
  activeContextualTipId: ContextualTipId | null
  contextualTips: Partial<Record<ContextualTipId, OnboardingTipState>>
  preferences: OnboardingPreferences
  userPreferences: OnboardingPreferences
  hasCompletedOnboarding: boolean
  currentStep: OnboardingStep
  startOnboarding: () => void
  advanceStep: () => void
  goToStep: (stepId: FirstRunStepId) => void
  skipOnboarding: () => void
  setStep: (step: OnboardingStep) => void
  completeOnboarding: () => void
  replayOnboarding: () => void
  resetOnboarding: () => void
  markTipSeen: (tipId: ContextualTipId) => void
  dismissTip: (tipId: ContextualTipId) => void
  requestContextualTip: (tipId: ContextualTipId) => boolean
  clearActiveContextualTip: (tipId?: ContextualTipId) => void
  setVoiceOverEnabled: (enabled: boolean) => void
  setReducedMotion: (enabled: boolean) => void
}

function detectReducedMotionPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false
  }

  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

function createDefaultFirstRunState(): OnboardingFirstRunState {
  return {
    status: "not_started",
    currentStepId: null,
    completedSteps: [],
    skippedAt: null,
    completedAt: null,
  }
}

function createDefaultPreferences(): OnboardingPreferences {
  return {
    voiceOverEnabled: true,
    reducedMotion: detectReducedMotionPreference(),
  }
}

function createDefaultPersistedState(): OnboardingPersistedState {
  return {
    firstRun: createDefaultFirstRunState(),
    contextualTips: {},
    preferences: createDefaultPreferences(),
    legacyStep: "welcome",
  }
}

function readLegacyCompletionFlag(): boolean {
  if (typeof window === "undefined") {
    return false
  }

  try {
    if (window.localStorage.getItem(ONBOARDING_STORAGE_KEY)) {
      return false
    }

    const storedLegacyState = window.localStorage.getItem(LEGACY_ONBOARDING_STORAGE_KEY)
    if (!storedLegacyState) {
      return false
    }

    const parsed = JSON.parse(storedLegacyState)
    const legacyState = parsed?.state ?? parsed
    const hasCompleted = legacyState?.hasCompletedOnboarding === true

    window.localStorage.removeItem(LEGACY_ONBOARDING_STORAGE_KEY)

    return hasCompleted
  } catch {
    return false
  }
}

function createInitialPersistedState(): OnboardingPersistedState {
  const initialState = createDefaultPersistedState()

  if (!readLegacyCompletionFlag()) {
    return initialState
  }

  return {
    ...initialState,
    firstRun: {
      ...initialState.firstRun,
      status: "completed",
      completedAt: new Date().toISOString(),
    },
    legacyStep: "complete",
  }
}

function buildRuntimeState(persistedState: OnboardingPersistedState) {
  const hasCompletedFirstRun = persistedState.firstRun.status === "completed"
  const hasHiddenLegacyFlow = hasCompletedFirstRun || persistedState.firstRun.status === "skipped"
  const currentStep = hasHiddenLegacyFlow ? "complete" : persistedState.legacyStep

  return {
    ...persistedState,
    currentStepId: persistedState.firstRun.currentStepId,
    hasCompletedFirstRun,
    isActive: persistedState.firstRun.status === "in_progress",
    activeContextualTipId: null,
    userPreferences: persistedState.preferences,
    hasCompletedOnboarding: hasHiddenLegacyFlow,
    currentStep,
  }
}

function getPersistedStateSlice(state: OnboardingStore): OnboardingPersistedState {
  return {
    firstRun: state.firstRun,
    contextualTips: state.contextualTips,
    preferences: state.preferences,
    legacyStep: state.currentStep,
  }
}

function withRuntimeState(partialState: OnboardingPersistedState): Partial<OnboardingStore> {
  return buildRuntimeState(partialState)
}

function upsertCompletedStep(completedSteps: FirstRunStepId[], stepId: FirstRunStepId): FirstRunStepId[] {
  if (completedSteps.includes(stepId)) {
    return completedSteps
  }

  return [...completedSteps, stepId]
}

function createDefaultTipState(): OnboardingTipState {
  return {
    seen: false,
    seenAt: null,
    dismissed: false,
  }
}

export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set, get) => ({
      ...buildRuntimeState(createInitialPersistedState()),
      startOnboarding: () => set((state) => {
        if (state.firstRun.status === "completed") {
          return state
        }

        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            ...state.firstRun,
            status: "in_progress",
            currentStepId: state.firstRun.currentStepId ?? getInitialFirstRunStepId(),
            skippedAt: null,
          },
        }

        return withRuntimeState(nextPersistedState)
      }),
      advanceStep: () => set((state) => {
        const activeStepId = state.firstRun.currentStepId ?? getInitialFirstRunStepId()
        const nextStepId = getNextFirstRunStepId(activeStepId)
        const completedSteps = upsertCompletedStep(state.firstRun.completedSteps, activeStepId)

        if (!nextStepId) {
          const completedState: OnboardingPersistedState = {
            ...getPersistedStateSlice(state),
            firstRun: {
              ...state.firstRun,
              status: "completed",
              currentStepId: null,
              completedSteps,
              completedAt: new Date().toISOString(),
              skippedAt: null,
            },
            legacyStep: "complete",
          }

          return withRuntimeState(completedState)
        }

        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            ...state.firstRun,
            status: "in_progress",
            currentStepId: nextStepId,
            completedSteps,
            skippedAt: null,
          },
        }

        return withRuntimeState(nextPersistedState)
      }),
      goToStep: (stepId) => set((state) => {
        if (!isFirstRunStepId(stepId)) {
          return state
        }

        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            ...state.firstRun,
            status: state.firstRun.status === "completed" ? "completed" : "in_progress",
            currentStepId: stepId,
            skippedAt: null,
          },
        }

        return withRuntimeState(nextPersistedState)
      }),
      skipOnboarding: () => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            ...state.firstRun,
            status: "skipped",
            currentStepId: null,
            skippedAt: new Date().toISOString(),
          },
          legacyStep: "complete",
        }

        return withRuntimeState(nextPersistedState)
      }),
      setStep: (step) => set((state) => withRuntimeState({
        ...getPersistedStateSlice(state),
        legacyStep: step,
      })),
      completeOnboarding: () => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            ...state.firstRun,
            status: "completed",
            currentStepId: null,
            completedAt: new Date().toISOString(),
            skippedAt: null,
          },
          legacyStep: "complete",
        }

        return withRuntimeState(nextPersistedState)
      }),
      replayOnboarding: () => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: {
            status: "in_progress",
            currentStepId: getInitialFirstRunStepId(),
            completedSteps: [],
            skippedAt: null,
            completedAt: null,
          },
          legacyStep: "welcome",
        }

        return withRuntimeState(nextPersistedState)
      }),
      resetOnboarding: () => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          firstRun: createDefaultFirstRunState(),
          legacyStep: "welcome",
        }

        return withRuntimeState(nextPersistedState)
      }),
      markTipSeen: (tipId) => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          contextualTips: {
            ...state.contextualTips,
            [tipId]: {
              ...(state.contextualTips[tipId] ?? createDefaultTipState()),
              seen: true,
              seenAt: new Date().toISOString(),
            },
          },
        }

        return withRuntimeState(nextPersistedState)
      }),
      dismissTip: (tipId) => set((state) => {
        const nextPersistedState: OnboardingPersistedState = {
          ...getPersistedStateSlice(state),
          contextualTips: {
            ...state.contextualTips,
            [tipId]: {
              ...(state.contextualTips[tipId] ?? createDefaultTipState()),
              seen: true,
              seenAt: new Date().toISOString(),
              dismissed: true,
            },
          },
        }

        return withRuntimeState(nextPersistedState)
      }),
      requestContextualTip: (tipId) => {
        const state = get()

        if (state.contextualTips[tipId]?.seen || state.isActive) {
          return false
        }

        if (state.activeContextualTipId && state.activeContextualTipId !== tipId) {
          return false
        }

        if (state.activeContextualTipId === tipId) {
          return true
        }

        set({ activeContextualTipId: tipId })
        return true
      },
      clearActiveContextualTip: (tipId) => set((state) => {
        if (tipId && state.activeContextualTipId !== tipId) {
          return state
        }

        if (!state.activeContextualTipId) {
          return state
        }

        return { activeContextualTipId: null }
      }),
      setVoiceOverEnabled: (enabled) => set((state) => withRuntimeState({
        ...getPersistedStateSlice(state),
        preferences: {
          ...state.preferences,
          voiceOverEnabled: enabled,
        },
      })),
      setReducedMotion: (enabled) => set((state) => withRuntimeState({
        ...getPersistedStateSlice(state),
        preferences: {
          ...state.preferences,
          reducedMotion: enabled,
        },
      })),
    }),
    {
      name: ONBOARDING_STORAGE_KEY,
      version: 2,
      partialize: (state) => ({
        firstRun: state.firstRun,
        contextualTips: state.contextualTips,
        preferences: state.preferences,
        legacyStep: state.currentStep,
      }),
      merge: (persistedState, currentState) => {
        const typedPersistedState = persistedState as Partial<OnboardingPersistedState> | undefined
        const currentPersistedState = getPersistedStateSlice(currentState)
        const mergedPersistedState: OnboardingPersistedState = {
          firstRun: typedPersistedState?.firstRun ?? currentPersistedState.firstRun,
          contextualTips: typedPersistedState?.contextualTips ?? currentPersistedState.contextualTips,
          preferences: {
            ...currentPersistedState.preferences,
            ...(typedPersistedState?.preferences ?? {}),
          },
          legacyStep: typedPersistedState?.legacyStep ?? currentPersistedState.legacyStep,
        }

        return {
          ...currentState,
          ...buildRuntimeState(mergedPersistedState),
        }
      },
    }
  )
)

export function selectHasCompletedFirstRun(state: OnboardingStore): boolean {
  return state.hasCompletedFirstRun
}

export function selectCurrentStepId(state: OnboardingStore): FirstRunStepId | null {
  return state.currentStepId
}

export function selectIsOnboardingActive(state: OnboardingStore): boolean {
  return state.isActive
}

export function selectShouldShowFirstRunOnboarding(state: OnboardingStore): boolean {
  return state.firstRun.status === "not_started" || state.firstRun.status === "in_progress"
}

export function selectTipSeen(state: OnboardingStore, tipId: ContextualTipId): boolean {
  return state.contextualTips[tipId]?.seen ?? false
}

export function markAllContextualTipsSeen(): void {
  const timestamp = new Date().toISOString()
  useOnboardingStore.setState((state) => {
    const contextualTips = CONTEXTUAL_TIP_IDS.reduce<Partial<Record<ContextualTipId, OnboardingTipState>>>((accumulator, tipId) => {
      accumulator[tipId] = {
        seen: true,
        seenAt: timestamp,
        dismissed: false,
      }

      return accumulator
    }, { ...state.contextualTips })

    return withRuntimeState({
      ...getPersistedStateSlice(state),
      contextualTips,
    })
  })
}

export function startFirstRunOnboarding(): void {
  get().startOnboarding()
}

function get() {
  return useOnboardingStore.getState()
}
