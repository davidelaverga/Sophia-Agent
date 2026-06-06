export const COREVIEW_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED"
export const COREVIEW_STILL_FRAME_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED"
export const SERVER_COREVIEW_STILL_FRAME_FEATURE_FLAG = "SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

export type CoreviewDisabledReason =
  | "frontend_coreview_flag_disabled"
  | "frontend_still_frame_flag_disabled"
  | null

export interface CoreviewFlagDiagnostics {
  frontendCoreviewFlagParsed: boolean
  frontendStillFrameFlagParsed: boolean
  coreviewDisabledReason: CoreviewDisabledReason
}

export function isCoReviewEnabled(value = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED): boolean {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase())
}

export function isCoReviewStillFrameEnabled(
  value = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED
    ?? process.env.SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED,
): boolean {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase())
}

export function isCoreviewStillFrameReviewEnabled({
  coReview = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED,
  stillFrame = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED,
}: {
  coReview?: string
  stillFrame?: string
} = {}): boolean {
  if (!isCoReviewEnabled(coReview)) return false
  return isCoReviewStillFrameEnabled(stillFrame)
}

export function coreviewFlagDiagnostics({
  coReview = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED,
  stillFrame = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED,
}: {
  coReview?: string
  stillFrame?: string
} = {}): CoreviewFlagDiagnostics {
  const frontendCoreviewFlagParsed = isCoReviewEnabled(coReview)
  const frontendStillFrameFlagParsed = isCoReviewStillFrameEnabled(stillFrame)
  const coreviewDisabledReason = !frontendCoreviewFlagParsed
    ? "frontend_coreview_flag_disabled"
    : !frontendStillFrameFlagParsed
      ? "frontend_still_frame_flag_disabled"
      : null

  return {
    frontendCoreviewFlagParsed,
    frontendStillFrameFlagParsed,
    coreviewDisabledReason,
  }
}
