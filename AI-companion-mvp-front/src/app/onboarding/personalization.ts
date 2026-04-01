import { useAuthTokenStore } from "../stores/auth-token-store"

const ONBOARDING_NAME_PLACEHOLDERS = ["{firstName}", "{name}"] as const

export function extractFirstName(rawName: string | null | undefined): string | null {
  if (!rawName) {
    return null
  }

  const normalized = rawName.trim()
  if (!normalized || normalized.includes("@")) {
    return null
  }

  const firstSegment = normalized.split(/\s+/)[0]?.trim() ?? ""
  const cleaned = firstSegment.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ'-]+$/g, "")

  return cleaned || null
}

export function getOnboardingFirstName(): string | null {
  const username = useAuthTokenStore.getState().user?.username
  return extractFirstName(username)
}

export function resolveOnboardingCopy(template: string, firstName = getOnboardingFirstName()): string {
  let resolved = template

  for (const placeholder of ONBOARDING_NAME_PLACEHOLDERS) {
    if (firstName) {
      resolved = resolved.replaceAll(placeholder, firstName)
      continue
    }

    if (resolved.startsWith(`Welcome, ${placeholder}.`)) {
      resolved = resolved.replace(`Welcome, ${placeholder}.`, "Welcome.")
    }

    resolved = resolved.replaceAll(`, ${placeholder}`, "")
    resolved = resolved.replaceAll(placeholder, "")
  }

  return resolved.replace(/\s{2,}/g, " ").replace(/\s+\./g, ".").trim()
}