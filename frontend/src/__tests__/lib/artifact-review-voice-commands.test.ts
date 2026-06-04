import { describe, expect, it } from "vitest"

import {
  parseArtifactReviewVoiceCommand,
  parseArtifactReviewVoiceCommands,
} from "../../app/lib/artifact-review-voice-commands"

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
    expect(parseArtifactReviewVoiceCommand("refresh your page")).toEqual({ kind: "refresh_view" })
    expect(parseArtifactReviewVoiceCommand("zoom in on the current title")).toEqual({
      kind: "focus_anchor",
      anchorType: "current_title",
      zoomDelta: 1.35,
    })
  })

  it("parses highlight and comment annotation intents", () => {
    expect(parseArtifactReviewVoiceCommand("highlight it yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
    })
    expect(parseArtifactReviewVoiceCommand("highlight the title yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      anchorType: "current_title",
      color: "yellow",
    })
    expect(parseArtifactReviewVoiceCommand("mark this yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
    })
    expect(parseArtifactReviewVoiceCommand("leave a comment: change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      commentText: "change the font",
    })
    expect(parseArtifactReviewVoiceCommand("add a note: change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      commentText: "change the font",
    })
    expect(parseArtifactReviewVoiceCommand("comment on the title: change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      anchorType: "current_title",
      commentText: "change the font",
    })
  })

  it("splits compound focus, highlight, and comment review commands in order", () => {
    expect(parseArtifactReviewVoiceCommands(
      "Sophia, zoom in on the current title. Highlight it yellow. Leave a comment: change the font.",
    )).toEqual([
      {
        kind: "focus_anchor",
        anchorType: "current_title",
        zoomDelta: 1.35,
      },
      {
        kind: "add_annotation",
        annotationKind: "highlight",
        color: "yellow",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        commentText: "change the font",
      },
    ])

    expect(parseArtifactReviewVoiceCommands("highlight the title yellow and comment change the font")).toEqual([
      {
        kind: "add_annotation",
        annotationKind: "highlight",
        anchorType: "current_title",
        color: "yellow",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: "current_title",
        commentText: "change the font",
      },
    ])

    expect(parseArtifactReviewVoiceCommands("highlight the current title yellow and comment \u2018change the font\u2019")).toEqual([
      {
        kind: "add_annotation",
        annotationKind: "highlight",
        anchorType: "current_title",
        color: "yellow",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: "current_title",
        commentText: "change the font",
      },
    ])
  })

  it("does not infer unrelated transcript text as an artifact command", () => {
    expect(parseArtifactReviewVoiceCommand("what do you notice about this section")).toBeNull()
    expect(parseArtifactReviewVoiceCommand("go back")).toBeNull()
  })
})
