export const COREVIEW_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED"
export const COREVIEW_STILL_FRAME_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED"
export const COREVIEW_FIXTURE_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_FIXTURE_ENABLED"
export const COREVIEW_REAL_ARTIFACT_FEATURE_FLAG = "NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED"
export const SERVER_COREVIEW_STILL_FRAME_FEATURE_FLAG = "SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED"
export const LEGACY_SCREENSHARE_COREVIEW_FEATURE_FLAG = "SOPHIA_GEMINI_SCREENSHARE_COREVIEW_ENABLED"

const TRUE_VALUES = new Set(["1", "true", "yes", "on"])

export function isCoReviewEnabled(value = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED): boolean {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase())
}

export function isCoReviewStillFrameEnabled(
  value = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED
    ?? process.env.SOPHIA_GEMINI_COREVIEW_STILL_FRAME_ENABLED,
): boolean {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase())
}

export function isCoReviewFixtureEnabled({
  coReview = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED,
  stillFrame = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED,
  fixture = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_FIXTURE_ENABLED,
}: {
  coReview?: string
  stillFrame?: string
  fixture?: string
} = {}): boolean {
  if (!isCoReviewEnabled(coReview)) return false
  if (!isCoReviewStillFrameEnabled(stillFrame)) return false
  return TRUE_VALUES.has(String(fixture).trim().toLowerCase())
}

export function isCoReviewRealArtifactEnabled({
  coReview = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED,
  stillFrame = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED,
  realArtifact = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED,
}: {
  coReview?: string
  stillFrame?: string
  realArtifact?: string
} = {}): boolean {
  if (!isCoReviewEnabled(coReview)) return false
  if (!isCoReviewStillFrameEnabled(stillFrame)) return false
  return TRUE_VALUES.has(String(realArtifact).trim().toLowerCase())
}
