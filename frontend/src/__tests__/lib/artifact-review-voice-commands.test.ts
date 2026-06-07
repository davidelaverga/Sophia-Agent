import { describe, expect, it } from "vitest"

import {
  isArtifactReviewAnnotationIntent,
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

  it("parses Coreview builder update and cancel intents without stealing comments", () => {
    expect(parseArtifactReviewVoiceCommand("update this file")).toEqual({
      kind: "builder_update",
      updateRequest: "update this file",
    })
    expect(parseArtifactReviewVoiceCommand("change the title")).toEqual({
      kind: "builder_update",
      updateRequest: "change the title",
    })
    expect(parseArtifactReviewVoiceCommand("change the main title to Sophia Workspace Version Two")).toEqual({
      kind: "builder_update",
      updateRequest: "change the main title to Sophia Workspace Version Two",
    })
    expect(parseArtifactReviewVoiceCommand("make the background darker")).toEqual({
      kind: "builder_update",
      updateRequest: "make the background darker",
    })
    expect(parseArtifactReviewVoiceCommand("make it darker")).toEqual({
      kind: "builder_update",
      updateRequest: "make it darker",
    })
    expect(parseArtifactReviewVoiceCommand("make those cards darker")).toEqual({
      kind: "builder_update",
      updateRequest: "make those cards darker",
    })
    expect(parseArtifactReviewVoiceCommand("make a new version")).toEqual({
      kind: "builder_update",
      updateMode: "revise_version",
      updateRequest: "make a new version",
    })
    expect(parseArtifactReviewVoiceCommand("rebuild this as HTML")).toEqual({
      kind: "builder_update",
      updateMode: "convert_format",
      updateRequest: "rebuild this as HTML",
    })
    expect(parseArtifactReviewVoiceCommand("cancel the builder task")).toEqual({
      kind: "builder_cancel",
    })
    expect(parseArtifactReviewVoiceCommand("stop the build")).toEqual({
      kind: "builder_cancel",
    })
    expect(parseArtifactReviewVoiceCommand("add a comment")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      utteranceKind: "annotation_comment",
    })
  })

  it("parses highlight, underline, arrow, and comment annotation intents", () => {
    expect(parseArtifactReviewVoiceCommand("highlight it yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("highlighted in yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("highlight this yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("highlight the title yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      anchorType: "current_title",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("mark this")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("mark this yellow")).toEqual({
      kind: "add_annotation",
      annotationKind: "highlight",
      color: "yellow",
      utteranceKind: "annotation_highlight",
    })
    expect(parseArtifactReviewVoiceCommand("underline this")).toEqual({
      kind: "add_annotation",
      annotationKind: "underline",
      color: "purple",
      utteranceKind: "annotation_underline",
    })
    expect(parseArtifactReviewVoiceCommand("underline the title")).toEqual({
      kind: "add_annotation",
      annotationKind: "underline",
      anchorType: "current_title",
      color: "purple",
      utteranceKind: "annotation_underline",
    })
    expect(parseArtifactReviewVoiceCommand("draw an arrow to this")).toEqual({
      kind: "add_annotation",
      annotationKind: "arrow",
      color: "purple",
      utteranceKind: "annotation_arrow",
    })
    expect(parseArtifactReviewVoiceCommand("add an arrow pointing to the chart")).toEqual({
      kind: "add_annotation",
      annotationKind: "arrow",
      color: "purple",
      utteranceKind: "annotation_arrow",
    })
    expect(parseArtifactReviewVoiceCommand("leave a comment: change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      commentText: "change the font",
      utteranceKind: "annotation_comment",
    })
    expect(parseArtifactReviewVoiceCommand("add a note: change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      commentText: "change the font",
      utteranceKind: "annotation_comment",
    })
    expect(parseArtifactReviewVoiceCommand("leave a note on the title")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      anchorType: "current_title",
      utteranceKind: "annotation_comment",
    })
    expect(parseArtifactReviewVoiceCommand("leave feedback")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      utteranceKind: "annotation_comment",
    })
    expect(parseArtifactReviewVoiceCommand("leave a pin")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      utteranceKind: "annotation_pin",
    })
    expect(parseArtifactReviewVoiceCommand("comment on the title saying change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      anchorType: "current_title",
      commentText: "change the font",
      utteranceKind: "annotation_comment",
    })
    expect(parseArtifactReviewVoiceCommand("change the font")).toEqual({
      kind: "add_annotation",
      annotationKind: "comment",
      commentText: "change the font",
      utteranceKind: "annotation_follow_up_comment",
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
        utteranceKind: "annotation_highlight",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        commentText: "change the font",
        utteranceKind: "annotation_comment",
      },
    ])

    expect(parseArtifactReviewVoiceCommands("highlight the title yellow and comment change the font")).toEqual([
      {
        kind: "add_annotation",
        annotationKind: "highlight",
        anchorType: "current_title",
        color: "yellow",
        utteranceKind: "annotation_highlight",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: "current_title",
        commentText: "change the font",
        utteranceKind: "annotation_comment",
      },
    ])

    expect(parseArtifactReviewVoiceCommands("highlight the current title yellow and comment \u2018change the font\u2019")).toEqual([
      {
        kind: "add_annotation",
        annotationKind: "highlight",
        anchorType: "current_title",
        color: "yellow",
        utteranceKind: "annotation_highlight",
      },
      {
        kind: "add_annotation",
        annotationKind: "comment",
        anchorType: "current_title",
        commentText: "change the font",
        utteranceKind: "annotation_comment",
      },
    ])

    expect(parseArtifactReviewVoiceCommands("underline the title then draw an arrow to this")).toEqual([
      {
        kind: "add_annotation",
        annotationKind: "underline",
        anchorType: "current_title",
        color: "purple",
        utteranceKind: "annotation_underline",
      },
      {
        kind: "add_annotation",
        annotationKind: "arrow",
        color: "purple",
        utteranceKind: "annotation_arrow",
      },
    ])
  })

  it("does not infer unrelated transcript text as an artifact command", () => {
    expect(parseArtifactReviewVoiceCommand("what do you notice about this section")).toBeNull()
    expect(parseArtifactReviewVoiceCommand("go back")).toBeNull()
  })

  it("exposes annotation intent without treating session leave phrases as annotations", () => {
    expect(isArtifactReviewAnnotationIntent("leave a comment: change the font")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("leave a note on the title")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("leave feedback")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("leave a pin")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("underline the title")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("draw an arrow to this")).toBe(true)
    expect(isArtifactReviewAnnotationIntent("leave the session")).toBe(false)
    expect(isArtifactReviewAnnotationIntent("go back")).toBe(false)
  })
})
