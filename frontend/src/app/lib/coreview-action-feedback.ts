import type { CoreviewActionResult } from "./coreview-actions"
import type { CoreviewBuilderActionResult } from "./coreview-builder-actions"

export type CoreviewActionFeedbackKind =
  | "builder_update"
  | "quick_patch"
  | "restore_original"
  | "cancel_update"
  | "zoom"
  | "annotation"
  | "navigation"
  | "status"

export type CoreviewActionFeedbackStatus =
  | "started"
  | "applied"
  | "completed"
  | "failed"
  | "unsupported"
  | "no_op"

export interface CoreviewActionFeedback {
  actionId: string
  actionKind: CoreviewActionFeedbackKind
  status: CoreviewActionFeedbackStatus
  displayMessage: string
  spokenMessage: string | null
  shouldSpeak: boolean
  shouldShowToastOrCard: boolean
  dedupeKey: string
  createdAt: string
  rawContentExcluded: true
}

export interface CoreviewActionFeedbackDedupeResult {
  feedback: CoreviewActionFeedback | null
  suppressed: boolean
  suppressedCount: number
}

export type CoreviewActionFeedbackInput = {
  actionKind: CoreviewActionFeedbackKind
  status: CoreviewActionFeedbackStatus
  displayMessage: string
  spokenMessage?: string | null
  shouldSpeak?: boolean
  shouldShowToastOrCard?: boolean
  actionId?: string | null
  dedupeKey?: string | null
  createdAt?: string | null
}

const INTERNAL_FEEDBACK_TERMS = [
  "coreview_",
  "task id",
  "task_id",
  "run id",
  "run_id",
  "async",
  "system prompt",
  "tracking task",
  "tracking tasks",
  "raw html",
  "raw artifact",
  "raw frame",
  "raw comment",
]

export function createCoreviewActionFeedback(input: CoreviewActionFeedbackInput): CoreviewActionFeedback {
  const displayMessage = safeFeedbackMessage(input.displayMessage, fallbackDisplayMessage(input.actionKind, input.status))
  const spokenMessage = input.spokenMessage === null
    ? null
    : safeFeedbackMessage(input.spokenMessage ?? displayMessage, displayMessage)
  const dedupeKey = normalizeFeedbackToken(input.dedupeKey)
    ?? [
      input.actionKind,
      input.status,
      displayMessage,
      spokenMessage ?? "silent",
    ].join(":")
  return {
    actionId: normalizeFeedbackToken(input.actionId) ?? dedupeKey,
    actionKind: input.actionKind,
    status: input.status,
    displayMessage,
    spokenMessage,
    shouldSpeak: input.shouldSpeak === true && Boolean(spokenMessage),
    shouldShowToastOrCard: input.shouldShowToastOrCard !== false,
    dedupeKey,
    createdAt: input.createdAt ?? new Date().toISOString(),
    rawContentExcluded: true,
  }
}

export function dedupeCoreviewActionFeedback(
  feedback: CoreviewActionFeedback | null,
  seenKeys: Set<string>,
): CoreviewActionFeedbackDedupeResult {
  if (!feedback) {
    return {
      feedback: null,
      suppressed: false,
      suppressedCount: 0,
    }
  }

  const key = feedback.dedupeKey || feedback.actionId
  if (seenKeys.has(key)) {
    return {
      feedback: null,
      suppressed: true,
      suppressedCount: 1,
    }
  }
  seenKeys.add(key)
  return {
    feedback,
    suppressed: false,
    suppressedCount: 0,
  }
}

export function coreviewFeedbackFromBuilderActionResult(
  result: CoreviewBuilderActionResult,
  options: {
    voiceMode?: boolean
    voiceTriggered?: boolean
    dedupePrefix?: string | null
  } = {},
): CoreviewActionFeedback {
  const voiceTriggered = options.voiceTriggered === true
  const prefix = normalizeFeedbackToken(options.dedupePrefix) ?? "builder"
  const baseKey = [
    prefix,
    result.action,
    result.result,
    result.context?.artifactStableIdentity ?? result.context?.artifactPath ?? result.rendererKind ?? "artifact",
    result.htmlQuickPatch?.revisionPathHash ?? result.latestOutput?.artifactPath ?? result.taskId ?? result.runId ?? "no-output",
    result.blockedReason ?? "ok",
  ].join(":")

  if (result.action === "coreview_cancel_builder_task") {
    if (result.result === "no_active_builder_task") {
      return createCoreviewActionFeedback({
        actionKind: "cancel_update",
        status: "no_op",
        displayMessage: "No active update to cancel.",
        spokenMessage: "There is no active update to cancel.",
        shouldSpeak: voiceTriggered,
        dedupeKey: baseKey,
      })
    }
    return createCoreviewActionFeedback({
      actionKind: "cancel_update",
      status: result.ok && result.result === "cancelled" ? "completed" : "failed",
      displayMessage: result.ok && result.result === "cancelled" ? "Update cancelled." : "Could not cancel the update.",
      spokenMessage: result.ok && result.result === "cancelled" ? "Update cancelled." : "I couldn't cancel the update.",
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  if (result.action === "coreview_get_builder_status") {
    return createCoreviewActionFeedback({
      actionKind: "status",
      status: result.result === "no_active_builder_task" ? "no_op" : "completed",
      displayMessage: result.result === "no_active_builder_task" ? "No active update." : "Update status refreshed.",
      spokenMessage: result.result === "no_active_builder_task" ? "No active update." : "Update status refreshed.",
      shouldSpeak: false,
      shouldShowToastOrCard: false,
      dedupeKey: baseKey,
    })
  }

  if (result.result === "quick_patch_applied") {
    return createCoreviewActionFeedback({
      actionKind: "quick_patch",
      status: "applied",
      displayMessage: "Preview updated.",
      spokenMessage: "Done - I updated it.",
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  if (result.htmlQuickPatch?.attempted && !result.ok && result.result === "failed") {
    return createCoreviewActionFeedback({
      actionKind: "quick_patch",
      status: "failed",
      displayMessage: "Quick edit could not be applied.",
      spokenMessage: "I couldn't safely apply that quick edit.",
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  if (result.result === "unsupported") {
    return createCoreviewActionFeedback({
      actionKind: "builder_update",
      status: "unsupported",
      displayMessage: "This artifact cannot be updated from Coreview yet.",
      spokenMessage: "I can't update this artifact from Coreview yet.",
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  if (result.ok && (result.result === "task_started" || result.result === "update_requested")) {
    const usedFullBuilder = result.htmlQuickPatch?.eligible === true
      && result.htmlQuickPatch.usedFullBuilder === true
    return createCoreviewActionFeedback({
      actionKind: "builder_update",
      status: "started",
      displayMessage: usedFullBuilder ? "Builder update started." : "Artifact update started.",
      spokenMessage: usedFullBuilder
        ? "That needs a deeper update. I'm starting the builder."
        : "I'm starting the update.",
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  return createCoreviewActionFeedback({
    actionKind: "builder_update",
    status: result.ok ? "completed" : "failed",
    displayMessage: result.ok ? "Artifact update ready." : "Artifact update failed.",
    spokenMessage: result.ok ? "The update is ready." : "I couldn't update that artifact.",
    shouldSpeak: voiceTriggered,
    dedupeKey: baseKey,
  })
}

export function coreviewFeedbackFromActionResult(
  result: CoreviewActionResult,
  options: {
    voiceMode?: boolean
    voiceTriggered?: boolean
    commandKind?: string | null
    dedupePrefix?: string | null
  } = {},
): CoreviewActionFeedback {
  const voiceTriggered = options.voiceTriggered === true
  const prefix = normalizeFeedbackToken(options.dedupePrefix) ?? "action"
  const baseKey = [
    prefix,
    result.action,
    result.blocked_reason ?? "ok",
    result.artifact_stable_identity ?? result.artifact_id ?? result.artifact_path ?? "artifact",
    result.annotation_id ?? result.view_signature_after ?? result.view_signature ?? result.zoom ?? result.fit_mode ?? "view",
  ].join(":")

  if (!result.ok && result.blocked_reason) {
    return createCoreviewActionFeedback({
      actionKind: result.action === "add_annotation"
        ? "annotation"
        : result.action === "set_view"
          ? result.html_scroll_attempted === true || result.html_navigation_router_used === true
            ? "navigation"
            : "zoom"
        : "status",
      status: unsupportedFeedbackStatus(result.blocked_reason),
      displayMessage: blockedFeedbackDisplayMessage(result.blocked_reason),
      spokenMessage: blockedFeedbackSpokenMessage(result.blocked_reason),
      shouldSpeak: voiceTriggered && (
        result.action === "add_annotation"
        || result.action === "focus_anchor"
        || result.html_scroll_attempted === true
      ),
      dedupeKey: baseKey,
    })
  }

  if (result.action === "add_annotation") {
    const kind = result.annotation_kind ?? "highlight"
    const annotationCreated = result.annotation_created !== false
      && result.annotation_commit_verified !== false
    return createCoreviewActionFeedback({
      actionKind: "annotation",
      status: annotationCreated ? "applied" : "failed",
      displayMessage: annotationDisplayMessage(kind, annotationCreated),
      spokenMessage: annotationSpokenMessage(kind, annotationCreated),
      shouldSpeak: voiceTriggered,
      dedupeKey: baseKey,
    })
  }

  if (result.action === "set_view" || result.action === "focus_anchor") {
    if (result.action === "set_view" && result.html_scroll_attempted === true) {
      return createCoreviewActionFeedback({
        actionKind: "navigation",
        status: result.ok ? "applied" : "failed",
        displayMessage: result.ok ? "Scrolled." : "Could not scroll.",
        spokenMessage: result.ok ? "Scrolled." : "I couldn't scroll that view.",
        shouldSpeak: voiceTriggered,
        shouldShowToastOrCard: false,
        dedupeKey: baseKey,
      })
    }
    if (result.action === "focus_anchor") {
      const htmlFocus = result.renderer_kind === "html" || result.html_focus_anchor_attempted === true
      return createCoreviewActionFeedback({
        actionKind: "navigation",
        status: result.ok ? "applied" : "failed",
        displayMessage: result.ok ? (htmlFocus ? "Scrolled." : "Focused.") : "I couldn't find that section.",
        spokenMessage: result.ok ? (htmlFocus ? "Scrolled." : "Focused.") : "I couldn't find that section.",
        shouldSpeak: voiceTriggered,
        shouldShowToastOrCard: false,
        dedupeKey: baseKey,
      })
    }
    const commandKind = options.commandKind ?? null
    const actionKind: CoreviewActionFeedbackKind = isZoomCommand(commandKind)
      ? "zoom"
      : "navigation"
    return createCoreviewActionFeedback({
      actionKind,
      status: result.ok ? "applied" : "failed",
      displayMessage: actionKind === "zoom" ? "View zoom updated." : "View updated.",
      spokenMessage: actionKind === "zoom" ? "Zoom updated." : "View updated.",
      shouldSpeak: false,
      shouldShowToastOrCard: false,
      dedupeKey: baseKey,
    })
  }

  if (result.action === "refresh_view") {
    return createCoreviewActionFeedback({
      actionKind: "status",
      status: result.refresh_result === "success" ? "completed" : "no_op",
      displayMessage: result.refresh_result === "success" ? "View refreshed." : "Refresh requested.",
      spokenMessage: result.refresh_result === "success" ? "View refreshed." : "Refresh requested.",
      shouldSpeak: false,
      shouldShowToastOrCard: false,
      dedupeKey: baseKey,
    })
  }

  return createCoreviewActionFeedback({
    actionKind: "status",
    status: result.ok ? "completed" : "failed",
    displayMessage: result.ok ? "Coreview action completed." : "Coreview action failed.",
    spokenMessage: result.ok ? "Done." : "That action failed.",
    shouldSpeak: false,
    shouldShowToastOrCard: false,
    dedupeKey: baseKey,
  })
}

export function coreviewFeedbackTelemetryPayload(
  feedback: CoreviewActionFeedback,
  options: {
    spoken: boolean
    audioAttempted: boolean
    audioResult: "spoken" | "unavailable" | "not_attempted" | "failed"
    dedupeSuppressedCount?: number
    voiceAudioAckUnavailable?: boolean
  },
): Record<string, unknown> {
  return {
    coreviewActionFeedbackEmitted: true,
    coreviewActionFeedbackKind: feedback.actionKind,
    coreviewActionFeedbackStatus: feedback.status,
    coreviewActionFeedbackSpoken: options.spoken,
    coreviewActionFeedbackAudioAttempted: options.audioAttempted,
    coreviewActionFeedbackAudioResult: options.audioResult,
    coreviewActionFeedbackDedupeSuppressedCount: options.dedupeSuppressedCount ?? 0,
    coreviewActionFeedbackRawContentExcluded: true,
    voiceAudioAckUnavailable: options.voiceAudioAckUnavailable === true,
    rawCommentTextExcluded: true,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
  }
}

export function coreviewFeedbackSuppressedTelemetryPayload(
  feedback: CoreviewActionFeedback,
  suppressedCount = 1,
): Record<string, unknown> {
  return {
    coreviewActionFeedbackEmitted: false,
    coreviewActionFeedbackKind: feedback.actionKind,
    coreviewActionFeedbackStatus: feedback.status,
    coreviewActionFeedbackSpoken: false,
    coreviewActionFeedbackAudioAttempted: false,
    coreviewActionFeedbackAudioResult: "not_attempted",
    coreviewActionFeedbackDedupeSuppressedCount: suppressedCount,
    coreviewActionFeedbackRawContentExcluded: true,
    rawCommentTextExcluded: true,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
  }
}

function annotationDisplayMessage(kind: string, created: boolean): string {
  if (!created) {
    return "Annotation could not be added."
  }
  if (kind === "comment") return "Comment added."
  if (kind === "underline") return "Underline added."
  if (kind === "arrow") return "Arrow added."
  return "Highlight added."
}

function annotationSpokenMessage(kind: string, created: boolean): string {
  if (!created) {
    return "I couldn't add that annotation."
  }
  if (kind === "comment") return "Comment added."
  if (kind === "underline") return "Underlined."
  if (kind === "arrow") return "Arrow added."
  return "Highlighted."
}

function blockedFeedbackDisplayMessage(reason: string): string {
  if (reason === "layout_anchor_not_supported") return "Text anchor is not supported for this view."
  if (reason === "section_not_found") return "I couldn't find that section."
  if (reason === "iframe_not_ready") return "The page is still loading."
  if (reason === "document_unavailable") return "The page is unavailable."
  if (reason === "cross_origin_unavailable") return "The page cannot be inspected safely."
  if (reason === "text_anchor_not_found") return "Text anchor was not found."
  if (reason === "anchor_not_found") return "Text anchor was not found."
  if (reason === "annotations_not_supported") return "Annotations are not supported for this artifact."
  if (reason === "zoom_not_supported") return "Zoom is not supported for this artifact."
  if (reason === "requested_page_out_of_bounds") return "That page is not available."
  if (reason === "no_selected_artifact") return "No artifact is selected."
  return "Coreview action could not be completed."
}

function blockedFeedbackSpokenMessage(reason: string): string {
  if (reason === "layout_anchor_not_supported") return "I can't place that text anchor in this view yet."
  if (reason === "section_not_found") return "I couldn't find that section."
  if (reason === "iframe_not_ready") return "The page is still loading. Try again in a moment."
  if (reason === "document_unavailable") return "The page is unavailable."
  if (reason === "cross_origin_unavailable") return "I can't inspect that page safely."
  if (reason === "text_anchor_not_found") return "I couldn't find that text in the artifact."
  if (reason === "anchor_not_found") return "I couldn't find that text in the artifact."
  if (reason === "annotations_not_supported") return "Annotations are not available for this artifact."
  if (reason === "zoom_not_supported") return "Zoom is not available for this artifact."
  if (reason === "requested_page_out_of_bounds") return "That page is not available."
  if (reason === "no_selected_artifact") return "No artifact is selected."
  return "I couldn't complete that Coreview action."
}

function unsupportedFeedbackStatus(reason: string): CoreviewActionFeedbackStatus {
  return reason.includes("unsupported") || reason.endsWith("_not_supported") ? "unsupported" : "failed"
}

function isZoomCommand(commandKind: string | null): boolean {
  return commandKind === "zoom_in"
    || commandKind === "zoom_out"
    || commandKind === "fit_width"
    || commandKind === "fit_page"
    || commandKind === "reset_zoom"
}

function fallbackDisplayMessage(
  kind: CoreviewActionFeedbackKind,
  status: CoreviewActionFeedbackStatus,
): string {
  if (kind === "annotation") return status === "failed" ? "Annotation failed." : "Annotation added."
  if (kind === "quick_patch") return status === "failed" ? "Quick edit failed." : "Preview updated."
  if (kind === "cancel_update") return status === "failed" ? "Cancel failed." : "Update cancelled."
  if (kind === "zoom") return "View zoom updated."
  if (kind === "navigation") return "View updated."
  return status === "failed" ? "Action failed." : "Action completed."
}

function safeFeedbackMessage(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, 140)
    : ""
  if (!normalized) {
    return fallback
  }
  const lower = normalized.toLowerCase()
  return INTERNAL_FEEDBACK_TERMS.some((term) => lower.includes(term)) ? fallback : normalized
}

function normalizeFeedbackToken(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim().slice(0, 240) : null
}
