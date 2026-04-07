import {
  CONTEXTUAL_TIP_IDS,
  type ContextualOnboardingTipConfig,
  type ContextualTipId,
} from "./types"

export const CONTEXTUAL_ONBOARDING_TIPS: readonly ContextualOnboardingTipConfig[] = [
  {
    id: "tip-first-artifacts",
    phase: "contextual",
    route: "/session",
    target: {
      selector: "[data-onboarding='artifacts-panel']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Artifacts",
      body: "Here are your first artifacts — observations from our conversation. They'll stay here until the session ends.",
      voiceLine: null,
      position: "left",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "event",
      config: {
        name: "session:first-artifacts",
      },
    },
    delayMs: 2000,
  },
  {
    id: "tip-first-memory-candidate",
    phase: "contextual",
    route: "/recap/[sessionId]",
    target: {
      selector: "[data-onboarding='memory-card']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Memory candidate",
      body: "This is a memory candidate. Tap to approve it, or dismiss it. You're always in control.",
      voiceLine: "You decide what stays.",
      position: "top",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "store-value",
      config: {
        store: "recap",
        selector: "hasMemoryCandidates",
      },
    },
    delayMs: 1500,
  },
  {
    id: "tip-first-recap",
    phase: "contextual",
    route: "/recap",
    target: {
      selector: "[data-onboarding='recap-summary']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Recap",
      body: "This is your session recap. It captures the key moments from our conversation.",
      voiceLine: "Here's what we covered.",
      position: "top",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "element-visible",
      config: {
        once: true,
      },
    },
    delayMs: 1000,
  },
  {
    id: "tip-first-interruption",
    phase: "contextual",
    route: "/session",
    target: {
      selector: "[data-onboarding='interruption-card']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Gentle nudges",
      body: "Sometimes I'll offer a gentle nudge or suggestion. You can always continue the conversation naturally.",
      voiceLine: null,
      position: "bottom",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "event",
      config: {
        name: "session:first-interruption",
      },
    },
    delayMs: 1000,
  },
  {
    id: "tip-first-ritual-suggestion",
    phase: "contextual",
    route: "/",
    target: {
      selector: "[data-onboarding='ritual-card-suggested']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Suggested ritual",
      body: "I suggested this ritual based on your recent sessions. You can always choose a different one.",
      voiceLine: null,
      position: "top",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "element-visible",
      config: {
        once: true,
      },
    },
    delayMs: 800,
  },
  {
    id: "tip-first-bootstrap-memory",
    phase: "contextual",
    route: "/session",
    target: {
      selector: "[data-onboarding='memory-highlight']",
      shape: "rounded-rect",
      padding: 12,
    },
    content: {
      title: "Memory highlights",
      body: "These are things I remember from past sessions. They help me be more relevant.",
      voiceLine: null,
      position: "bottom",
      primaryActionLabel: "Got it",
    },
    trigger: {
      type: "event",
      config: {
        name: "session:bootstrap-memory-highlight",
      },
    },
    delayMs: 2000,
  },
] as const

export function getContextualTipById(tipId: ContextualTipId | null | undefined): ContextualOnboardingTipConfig | null {
  if (!tipId) {
    return null
  }

  return CONTEXTUAL_ONBOARDING_TIPS.find((tip) => tip.id === tipId) ?? null
}

export function isContextualTipId(value: string): value is ContextualTipId {
  return (CONTEXTUAL_TIP_IDS as readonly string[]).includes(value)
}