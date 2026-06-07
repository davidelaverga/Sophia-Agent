import { describe, expect, it } from "vitest"

import {
  coreviewFeedbackFromActionResult,
  coreviewFeedbackFromBuilderActionResult,
  coreviewFeedbackTelemetryPayload,
  createCoreviewActionFeedback,
  dedupeCoreviewActionFeedback,
} from "../../app/lib/coreview-action-feedback"
import type { CoreviewActionResult } from "../../app/lib/coreview-actions"
import {
  buildCoreviewCapabilitySummary,
  getCoreviewArtifactCapabilities,
} from "../../app/lib/coreview-artifact-capabilities"
import type { CoreviewBuilderActionResult } from "../../app/lib/coreview-builder-actions"

const htmlCapabilities = getCoreviewArtifactCapabilities({
  rendererKind: "html",
  artifactPath: "mnt/user-data/outputs/site.html",
})

const baseBuilderResult = {
  ok: true,
  action: "coreview_request_artifact_update",
  result: "quick_patch_applied",
  rendererKind: "html",
  context: {
    workspaceKey: "workspace:test",
    artifactPath: "mnt/user-data/outputs/site.html",
    artifactTitle: "site.html",
    artifactStableIdentity: "user:test|thread:thread-1|path:mnt/user-data/outputs/site.html|renderer:html",
    rendererKind: "html",
    capabilitySummary: buildCoreviewCapabilitySummary({
      capabilities: htmlCapabilities,
      rendererKind: "html",
      pageIndex: 0,
      pageCount: 1,
    }),
    currentPage: 1,
    pageCount: 1,
    viewSignature: "artifact:0:1:custom",
    annotationCounts: {
      annotationCount: 0,
      highlightCount: 0,
      commentCount: 0,
      underlineCount: 0,
      arrowCount: 0,
      drawPathCount: 0,
    },
    selectedAnnotationIds: [],
    userUpdateRequest: "Make the pricing card teal.",
    requestedChangeSummary: "Make the pricing card teal.",
    updateMode: "revise_version",
    sourceActor: "sophia",
    sessionId: "session-1",
    threadId: "thread-1",
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
    rawCommentTextExcluded: true,
  },
  htmlQuickPatch: {
    eligible: true,
    attempted: true,
    result: "patched",
    kind: "text_replace",
    fallbackReason: null,
    latencyMs: 12,
    revisionPathHash: "revision-hash",
    usedFullBuilder: false,
    preservedOriginal: true,
    restoreAvailable: true,
  },
  preservedMic: true,
  preservedReview: true,
  rawArtifactTextExcluded: true,
  rawFrameExcluded: true,
  rawCommentTextExcluded: true,
} satisfies CoreviewBuilderActionResult

const baseActionResult = {
  ok: true,
  action: "add_annotation",
  artifact_id: "artifact-1",
  artifact_path: "mnt/user-data/outputs/site.html",
  artifact_title: "site.html",
  renderer_kind: "html",
  page_index: 0,
  page_number: 1,
  page_count: 1,
  zoom: 1,
  fit_mode: "custom",
  view_signature: "artifact:0:1:custom",
  stale: false,
  refresh_attempted: false,
  refresh_result: "not_requested",
  blocked_reason: null,
  result_summary: "annotation_added",
  command_source: "gemini_tool",
  preserved_mic: true,
  preserved_review: true,
  view_ready_wait_ms: 0,
  view_signature_before: "artifact:0:1:custom",
  view_signature_after: "artifact:0:1:custom",
  annotation_overlay_captured: true,
  annotation_id: "annotation-1",
  annotation_kind: "comment",
  annotation_anchor_type: "text_quote",
  annotation_color: "yellow",
  annotation_page_index: 0,
  annotation_count: 1,
  highlight_count: 0,
  comment_count: 1,
  underline_count: 0,
  arrow_count: 0,
  draw_path_count: 0,
  annotation_action_source: "sophia",
  annotation_commit_attempted: true,
  annotation_commit_result: "success",
  annotation_commit_count_before: 0,
  annotation_commit_count_after: 1,
  annotation_commit_verified: true,
  annotation_created: true,
  artifact_stable_identity: "user:test|thread:thread-1|path:mnt/user-data/outputs/site.html|renderer:html",
  rebind_status: "not_needed",
  rebind_attempted: false,
  rebind_result: "not_needed",
  rebind_reason: null,
  raw_comment_text_excluded: true,
  raw_artifact_text_excluded: true,
  raw_frame_excluded: true,
} satisfies CoreviewActionResult

describe("Coreview action feedback", () => {
  it("creates generic voice feedback for successful quick HTML patches", () => {
    const feedback = coreviewFeedbackFromBuilderActionResult(baseBuilderResult, {
      voiceTriggered: true,
    })

    expect(feedback).toMatchObject({
      actionKind: "quick_patch",
      status: "applied",
      displayMessage: "Preview updated.",
      spokenMessage: "Done - I updated it.",
      shouldSpeak: true,
      rawContentExcluded: true,
    })
  })

  it("does not depend on title-specific quick patch phrasing", () => {
    const feedback = coreviewFeedbackFromBuilderActionResult({
      ...baseBuilderResult,
      requestedChangeSummary: "Make the pricing card teal.",
      htmlQuickPatch: {
        ...baseBuilderResult.htmlQuickPatch,
        kind: "style_replace",
        revisionPathHash: "card-color-hash",
      },
    }, {
      voiceTriggered: true,
    })

    expect(feedback.actionKind).toBe("quick_patch")
    expect(feedback.spokenMessage).toBe("Done - I updated it.")
    expect(feedback.dedupeKey).toContain("card-color-hash")
  })

  it("suppresses duplicate feedback with the same dedupe key", () => {
    const seen = new Set<string>()
    const feedback = createCoreviewActionFeedback({
      actionKind: "annotation",
      status: "applied",
      displayMessage: "Highlighted.",
      spokenMessage: "Highlighted.",
      shouldSpeak: true,
      dedupeKey: "voice:annotation:1",
    })

    expect(dedupeCoreviewActionFeedback(feedback, seen)).toMatchObject({
      feedback,
      suppressed: false,
      suppressedCount: 0,
    })
    expect(dedupeCoreviewActionFeedback(feedback, seen)).toMatchObject({
      feedback: null,
      suppressed: true,
      suppressedCount: 1,
    })
  })

  it("keeps feedback wording free of internal tool and task language", () => {
    const feedback = createCoreviewActionFeedback({
      actionKind: "builder_update",
      status: "started",
      displayMessage: "coreview_request_artifact_update task id abc is tracking tasks",
      spokenMessage: "raw HTML async task_id abc",
      shouldSpeak: true,
    })

    const combined = `${feedback.displayMessage} ${feedback.spokenMessage}`.toLowerCase()
    expect(combined).not.toContain("coreview_")
    expect(combined).not.toContain("task id")
    expect(combined).not.toContain("task_id")
    expect(combined).not.toContain("tracking task")
    expect(combined).not.toContain("raw html")
  })

  it("reports unavailable audio acks without raw content", () => {
    const feedback = coreviewFeedbackFromBuilderActionResult(baseBuilderResult, {
      voiceTriggered: true,
    })
    const telemetry = coreviewFeedbackTelemetryPayload(feedback, {
      spoken: false,
      audioAttempted: true,
      audioResult: "unavailable",
      voiceAudioAckUnavailable: true,
    })

    expect(telemetry).toMatchObject({
      coreviewActionFeedbackEmitted: true,
      coreviewActionFeedbackKind: "quick_patch",
      coreviewActionFeedbackStatus: "applied",
      coreviewActionFeedbackAudioAttempted: true,
      coreviewActionFeedbackAudioResult: "unavailable",
      voiceAudioAckUnavailable: true,
      coreviewActionFeedbackRawContentExcluded: true,
      rawCommentTextExcluded: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    })
  })

  it("keeps text-mode feedback UI-only", () => {
    const quickPatchFeedback = coreviewFeedbackFromBuilderActionResult(baseBuilderResult, {
      voiceTriggered: false,
    })
    const annotationFeedback = coreviewFeedbackFromActionResult(baseActionResult, {
      voiceTriggered: false,
    })

    expect(quickPatchFeedback.shouldShowToastOrCard).toBe(true)
    expect(quickPatchFeedback.shouldSpeak).toBe(false)
    expect(annotationFeedback).toMatchObject({
      actionKind: "annotation",
      status: "applied",
      displayMessage: "Comment added.",
      shouldSpeak: false,
      shouldShowToastOrCard: true,
    })
  })

  it("speaks generic HTML scroll and focus feedback when voice-triggered", () => {
    const scrollFeedback = coreviewFeedbackFromActionResult({
      ...baseActionResult,
      action: "set_view",
      annotation_id: null,
      annotation_kind: null,
      annotation_commit_verified: false,
      html_scroll_attempted: true,
      html_scroll_result: "success",
    }, {
      voiceTriggered: true,
      commandKind: "scroll_down",
    })
    const focusFeedback = coreviewFeedbackFromActionResult({
      ...baseActionResult,
      action: "focus_anchor",
      annotation_id: null,
      annotation_kind: null,
      annotation_commit_verified: false,
      focus_anchor_type: "text_quote",
      html_focus_anchor_attempted: true,
      html_focus_anchor_result: "success",
      html_focus_anchor_method: "heading",
      html_focus_anchor_scrolled: true,
    }, {
      voiceTriggered: true,
      commandKind: "focus_anchor",
    })

    expect(scrollFeedback).toMatchObject({
      actionKind: "navigation",
      displayMessage: "Scrolled.",
      spokenMessage: "Scrolled.",
      shouldSpeak: true,
    })
    expect(focusFeedback).toMatchObject({
      actionKind: "navigation",
      displayMessage: "Scrolled.",
      spokenMessage: "Scrolled.",
      shouldSpeak: true,
    })
  })

  it("gives honest feedback for missing HTML sections without saying Done", () => {
    const feedback = coreviewFeedbackFromActionResult({
      ...baseActionResult,
      ok: false,
      action: "set_view",
      blocked_reason: "section_not_found",
      result_summary: "Section not found.",
      annotation_id: null,
      annotation_kind: null,
      annotation_commit_verified: false,
      html_scroll_attempted: true,
      html_scroll_result: "section_not_found",
      html_navigation_router_used: true,
      html_navigation_result: "section_not_found",
      html_navigation_failure_reason: "section_not_found",
    }, {
      voiceTriggered: true,
      commandKind: "focus_anchor",
    })

    expect(feedback).toMatchObject({
      actionKind: "navigation",
      status: "failed",
      displayMessage: "I couldn't find that section.",
      spokenMessage: "I couldn't find that section.",
      shouldSpeak: true,
    })
    expect(feedback.spokenMessage).not.toContain("Done")
  })

  it("tells voice users when the HTML page is still loading", () => {
    const feedback = coreviewFeedbackFromActionResult({
      ...baseActionResult,
      ok: false,
      action: "set_view",
      blocked_reason: "iframe_not_ready",
      result_summary: "The page is still loading.",
      annotation_id: null,
      annotation_kind: null,
      annotation_commit_verified: false,
      html_scroll_attempted: true,
      html_scroll_result: "iframe_not_ready",
      html_navigation_router_used: true,
      html_navigation_timed_out: true,
      html_navigation_waited_for_ready: true,
    }, {
      voiceTriggered: true,
      commandKind: "scroll_down",
    })

    expect(feedback).toMatchObject({
      actionKind: "navigation",
      status: "failed",
      displayMessage: "The page is still loading.",
      spokenMessage: "The page is still loading. Try again in a moment.",
      shouldSpeak: true,
    })
    expect(`${feedback.displayMessage} ${feedback.spokenMessage}`).not.toMatch(/tool|task id|async|prompt|tracking/iu)
  })
})
