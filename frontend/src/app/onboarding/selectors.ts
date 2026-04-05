import { getContextualTipById } from "./contextual-tips"
import { getFirstRunStepById } from "./first-run-steps"
import type { ContextualTipId, FirstRunStepId, OnboardingTipState } from "./types"
import type { OnboardingStore } from "../stores/onboarding-store"

export function selectHasCompletedFirstRun(state: OnboardingStore): boolean {
  return state.hasCompletedFirstRun
}

export function selectIsOnboardingActive(state: OnboardingStore): boolean {
  return state.isActive
}

export function selectCurrentFirstRunStep(state: OnboardingStore) {
  return getFirstRunStepById(state.currentStepId)
}

export function selectFirstRunStepById(stepId: FirstRunStepId | null | undefined) {
  return getFirstRunStepById(stepId)
}

export function selectContextualTipConfig(tipId: ContextualTipId | null | undefined) {
  return getContextualTipById(tipId)
}

export function selectTipState(state: OnboardingStore, tipId: ContextualTipId): OnboardingTipState {
  return state.contextualTips[tipId] ?? {
    seen: false,
    seenAt: null,
    dismissed: false,
  }
}