import { describe, expect, it } from "vitest"

import { parseArtifactReviewVoiceCommand } from "../../app/lib/artifact-review-voice-commands"

describe("artifact review voice command parser", () => {
  it("parses spoken and numeric page targets", () => {
    expect(parseArtifactReviewVoiceCommand("Go to page two in your analysis. What do you notice?")).toEqual({
      kind: "go_to_page",
      pageTarget: 2,
    })
    expect(parseArtifactReviewVoiceCommand("go to page 2")).toEqual({
      kind: "go_to_page",
      pageTarget: 2,
    })
  })

  it("parses supported navigation, zoom, fit, and refresh commands", () => {
    expect(parseArtifactReviewVoiceCommand("next page")).toEqual({ kind: "next_page" })
    expect(parseArtifactReviewVoiceCommand("previous page")).toEqual({ kind: "previous_page" })
    expect(parseArtifactReviewVoiceCommand("go back a page")).toEqual({ kind: "previous_page" })
    expect(parseArtifactReviewVoiceCommand("first page")).toEqual({ kind: "first_page" })
    expect(parseArtifactReviewVoiceCommand("last page")).toEqual({ kind: "last_page" })
    expect(parseArtifactReviewVoiceCommand("zoom in")).toEqual({ kind: "zoom_in" })
    expect(parseArtifactReviewVoiceCommand("zoom out")).toEqual({ kind: "zoom_out" })
    expect(parseArtifactReviewVoiceCommand("fit width")).toEqual({ kind: "fit_width" })
    expect(parseArtifactReviewVoiceCommand("fit page")).toEqual({ kind: "fit_page" })
    expect(parseArtifactReviewVoiceCommand("reset zoom")).toEqual({ kind: "reset_zoom" })
    expect(parseArtifactReviewVoiceCommand("refresh view")).toEqual({ kind: "refresh_view" })
  })

  it("does not infer unrelated transcript text as an artifact command", () => {
    expect(parseArtifactReviewVoiceCommand("what do you notice about this section")).toBeNull()
    expect(parseArtifactReviewVoiceCommand("go back")).toBeNull()
  })
})
