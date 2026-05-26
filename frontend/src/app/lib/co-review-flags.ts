export const COREVIEW_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

export function isCoReviewEnabled(value = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED): boolean {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase())
}
