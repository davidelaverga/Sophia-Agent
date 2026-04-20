import {
  FIRST_RUN_STEP_IDS,
  type FirstRunOnboardingStepConfig,
  type FirstRunStepId,
} from "./types"

export const FIRST_RUN_ONBOARDING_STEPS: readonly FirstRunOnboardingStepConfig[] = [
  {
    id: "welcome",
    phase: "first-run",
    route: "/",
    target: null,
    content: {
      title: "Welcome, {firstName}.",
      body: "I'm Sophia — your space to think, decompress, and grow. Let me show you around. It'll take a minute.",
      voiceLine: "Welcome, {firstName}. Let me show you around.",
      position: "center",
      primaryActionLabel: "Continue",
    },
    advanceOn: "click-next",
    canGoBack: false,
  },
  {
    id: "dashboard-presets",
    phase: "first-run",
    route: "/",
    target: {
      selector: [
        "[data-onboarding='preset-tab-gaming']",
        "[data-onboarding='preset-tab-work']",
        "[data-onboarding='preset-tab-life']",
      ],
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Worlds",
      body: "Gaming, Work, and Life reshape the dashboard so Sophia meets you in the right context before you even start.",
      voiceLine: "Choose the world that matches what you're walking into: gaming, work, or life.",
      position: "bottom",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "dashboard-rituals",
    phase: "first-run",
    route: "/",
    target: {
      selector: [
        "[data-onboarding='ritual-card-prepare']",
        "[data-onboarding='ritual-card-debrief']",
        "[data-onboarding='ritual-card-reset']",
        "[data-onboarding='ritual-card-vent']",
      ],
      shape: "rounded-rect",
      padding: 14,
    },
    content: {
      title: "Rituals",
      body: "Each ritual changes the tone of the session. Choose one first when you want structure, then tap the mic to start.",
      voiceLine: "These rituals set the tone. Pick one first, then tap the mic to begin.",
      position: "top",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "dashboard-mic",
    phase: "first-run",
    route: "/",
    target: {
      selector: "[data-onboarding='mic-cta']",
      shape: "circle",
      padding: 16,
    },
    content: {
      title: "The microphone",
      body: "Once you choose a ritual, tap the mic to start. If nothing is selected, the mic starts an open session.",
      voiceLine: "Tap the mic to begin. With no ritual selected, it starts open.",
      position: "bottom",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "session-concept",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='memory-highlight']",
      shape: "rounded-rect",
      padding: 16,
    },
    content: {
      title: "This is a session.",
      body: "Sophia greets you and shows memory highlights — things she remembers from before. You talk, she replies, and artifacts appear on the right.",
      voiceLine: "Sophia greets you with memory highlights and the conversation flows from there.",
      position: "right",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "session-theme-toggle",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='header-theme-toggle']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Light or dark.",
      body: "Switch the mood anytime. Sophia keeps working the same way in both themes.",
      voiceLine: "You can switch between light and dark whenever you want.",
      position: "bottom",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "session-settings",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='header-settings']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Settings",
      body: "This opens your preferences, privacy controls, and onboarding options.",
      voiceLine: "Settings gives you control over preferences, privacy, and onboarding.",
      position: "bottom",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "session-composer",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='session-composer']",
      shape: "rounded-rect",
      padding: 14,
    },
    content: {
      title: "Voice or text.",
      body: "Tap the mic to speak, or type when that fits better.",
      voiceLine: "Tap the mic to speak, or type.",
      position: "top",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "session-companions",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='companion-rail-popover']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Companions",
      body: "Quick actions live in the left rail. Open them when you want a fast question, plan, reset, or mini debrief without leaving the session.",
      voiceLine: "The left rail opens quick companion actions during the session.",
      position: "right",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "artifacts-entry",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='artifacts-rail']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Artifacts panel.",
      body: "Tap here to open the artifacts that Sophia surfaces during the session.",
      voiceLine: "Tap here to open artifacts.",
      position: "left",
      primaryActionLabel: "Open artifacts",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "artifacts-takeaway",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='artifact-takeaway']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Takeaway.",
      body: "The core insight Sophia distills from the conversation.",
      voiceLine: "This is the takeaway — one clear insight from the session.",
      position: "left",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "artifacts-reflection",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='reflection-card']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Reflection.",
      body: "A question to go deeper. Tap it and Sophia will open a reflection thread.",
      voiceLine: "Tap it to start a reflection.",
      position: "left",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "artifacts-memory",
    phase: "first-run",
    route: "/session",
    target: {
      selector: "[data-onboarding='memory-candidates']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Memory candidates.",
      body: "Things worth remembering. You approve or reject each one — Sophia only keeps what you allow.",
      voiceLine: "You control what Sophia remembers.",
      position: "left",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "recap-memory-keep",
    phase: "first-run",
    route: "/recap/onboarding-demo",
    target: {
      selector: "[data-onboarding='recap-memory-keep']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Keep what matters.",
      body: "When a memory feels useful, keep it. That marks it for saving at the end of the recap.",
      voiceLine: "Keep the memories that should stay with Sophia.",
      position: "top",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "recap-memory-discard",
    phase: "first-run",
    route: "/recap/onboarding-demo",
    target: {
      selector: "[data-onboarding='recap-memory-discard']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Let it go.",
      body: "Discard anything that should not be kept. Sophia only saves what survives your review.",
      voiceLine: "Discard anything that does not belong in memory.",
      position: "top",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "recap-memory-save",
    phase: "first-run",
    route: "/recap/onboarding-demo",
    target: {
      selector: "[data-onboarding='recap-memory-save']",
      shape: "rounded-rect",
      padding: 10,
    },
    content: {
      title: "Save approved memories.",
      body: "Once you've reviewed everything, save the approved memories and finish the recap.",
      voiceLine: "When you finish reviewing, save the approved memories here.",
      position: "top",
      primaryActionLabel: "Next",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
  {
    id: "ready",
    phase: "first-run",
    route: "/",
    target: {
      selector: "[data-onboarding='mic-cta']",
      shape: "circle",
      padding: 14,
    },
    content: {
      title: "You're ready.",
      body: "You've seen the full loop. Start a real session from here whenever you want.",
      voiceLine: "Whenever you're ready.",
      position: "top",
      primaryActionLabel: "Start",
    },
    advanceOn: "click-next",
    canGoBack: true,
  },
] as const

export function getInitialFirstRunStepId(): FirstRunStepId {
  return FIRST_RUN_STEP_IDS[0]
}

export function getFirstRunStepById(stepId: FirstRunStepId | null | undefined): FirstRunOnboardingStepConfig | null {
  if (!stepId) {
    return null
  }

  return FIRST_RUN_ONBOARDING_STEPS.find((step) => step.id === stepId) ?? null
}

export function getFirstRunStepIndex(stepId: FirstRunStepId | null | undefined): number {
  if (!stepId) {
    return -1
  }

  return FIRST_RUN_ONBOARDING_STEPS.findIndex((step) => step.id === stepId)
}

export function getNextFirstRunStepId(stepId: FirstRunStepId | null | undefined): FirstRunStepId | null {
  const currentIndex = getFirstRunStepIndex(stepId)
  if (currentIndex < 0 || currentIndex >= FIRST_RUN_ONBOARDING_STEPS.length - 1) {
    return null
  }

  return FIRST_RUN_ONBOARDING_STEPS[currentIndex + 1]?.id ?? null
}

export function getPreviousFirstRunStepId(stepId: FirstRunStepId | null | undefined): FirstRunStepId | null {
  const currentIndex = getFirstRunStepIndex(stepId)
  if (currentIndex <= 0) {
    return null
  }

  return FIRST_RUN_ONBOARDING_STEPS[currentIndex - 1]?.id ?? null
}

export function isFirstRunStepId(value: string): value is FirstRunStepId {
  return (FIRST_RUN_STEP_IDS as readonly string[]).includes(value)
}