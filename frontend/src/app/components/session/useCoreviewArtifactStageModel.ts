import { useCallback, useMemo } from "react"

import { clampArtifactZoom, detectArtifactRendererKind } from "../../lib/artifact-renderers"
export {
  parseArtifactReviewVoiceCommand,
  parseArtifactReviewVoiceCommands,
  type ArtifactReviewAnnotationUtteranceKind,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
} from "../../lib/artifact-review-voice-commands"
import type {
  ArtifactReviewAnnotationUtteranceKind,
  ArtifactReviewVoiceCommand,
  ArtifactReviewVoiceCommandRefreshResult,
  ArtifactReviewVoiceCommandRouteResult,
} from "../../lib/artifact-review-voice-commands"
import {
  COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  COREVIEW_SET_VIEW_TOOL_NAME,
  wasRecentCoreviewToolActionHandled,
  type CoreviewActionResult,
  type CoreviewAddAnnotationAdapterInput,
  type CoreviewAddAnnotationAdapterResult,
  type CoreviewAddAnnotationInput,
  type CoreviewAnnotationAnchor,
  type CoreviewCurrentView,
  type CoreviewFocusAnchorInput,
  type CoreviewSetViewInput,
  type CoreviewToolBlockedReason,
  type CoreviewToolName,
  type CoreviewToolRefreshResult,
} from "../../lib/coreview-actions"
import { useCoreviewAnnotationStore } from "../../lib/coreview-annotation-store"
import {
  coreviewArtifactCapabilityTelemetry,
  getCoreviewArtifactCapabilitiesForFile,
} from "../../lib/coreview-artifact-capabilities"
import {
  buildCoreviewArtifactStableIdentity,
  buildCoreviewWorkspaceKey,
  normalizeCoreviewArtifactKey,
} from "../../lib/coreview-artifact-identity"
import {
  appendWorkspaceEvent,
  getCoreviewWorkspaceEventLogTelemetry,
  hashCoreviewWorkspaceKey,
} from "../../lib/coreview-workspace-event-log"
import {
  buildCoreviewWorkspaceActor,
  type CoreviewWorkspaceActor,
  type CoreviewWorkspaceEventType,
} from "../../lib/coreview-workspace-events"
import { buildCoreviewWorkspaceShareState } from "../../lib/coreview-workspace-share"
import { recordSophiaCaptureEvent } from "../../lib/session-capture"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"

import {
  buildCoreviewRealArtifactId,
  buildStageBuilderArtifact,
  exactTextRehydrateResult,
  getStagePrimaryFileWithMime,
  normalizeStageBuilderArtifactPath,
} from "./artifact-stage-selection"
import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"

export { exactTextRehydrateResult }

export type CoreviewArtifactWorkspaceActor = CoreviewWorkspaceActor

export type CoreviewWorkspaceEventRecorderInput = {
  type: CoreviewWorkspaceEventType
  actor: CoreviewWorkspaceActor
  payload: Record<string, unknown>
  artifactKey?: string | null
}

const COREVIEW_BLOCKED_STATUS_TEXT: Partial<Record<CoreviewToolBlockedReason, string>> = {
  no_selected_artifact: "No artifact is selected.",
  artifact_mismatch: "That artifact is not selected.",
  artifact_rebind_required: "Reconnect voice or start Review with Sophia to rebind this artifact.",
  artifact_rebind_failed: "Reopen this artifact, then start Review with Sophia again.",
  artifact_not_available_in_current_session: "This artifact is not available in the current session.",
  requested_page_out_of_bounds: "That page is not available in this PDF.",
  pages_not_supported: "This artifact does not support page navigation.",
  zoom_not_supported: "This artifact does not support zoom controls.",
  annotations_not_supported: "Annotations are not available for this artifact format.",
  layout_anchor_not_supported: "Layout anchors are not available for this artifact format.",
  ocr_not_available: "OCR is not available yet.",
  pptx_native_renderer_unavailable: "PPTX native canvas rendering is not available yet.",
  unsupported_pages: "This view cannot be controlled by Sophia.",
  unsupported_renderer: "This view cannot be controlled by Sophia.",
  review_not_active: "Visual review is not active.",
  refresh_unavailable: "Sophia's visual refresh is unavailable.",
  view_ready_timeout: "The artifact view did not become ready in time.",
  tool_unavailable: "Sophia cannot control this view right now.",
  invalid_tool_args: "Sophia asked for an invalid view change.",
  annotation_commit_failed: "Sophia could not verify that the annotation was added.",
  unsupported_annotation_kind: "That annotation type is not available yet.",
}

type VoiceSetViewInputBuilder = (
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
) => CoreviewSetViewInput

const VOICE_SET_VIEW_INPUT_BUILDERS: Partial<Record<ArtifactReviewVoiceCommand["kind"], VoiceSetViewInputBuilder>> = {
  go_to_page: (command, current) => ({
    artifactId: current.artifactId ?? undefined,
    pageNumber: command.kind === "go_to_page" ? command.pageTarget : undefined,
    reason: "voice command fallback",
  }),
  next_page: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    pageIndex: current.pageIndex + 1,
    reason: "voice command fallback",
  }),
  previous_page: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    pageIndex: current.pageIndex - 1,
    reason: "voice command fallback",
  }),
  first_page: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    pageIndex: 0,
    reason: "voice command fallback",
  }),
  last_page: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    pageIndex: Math.max(0, current.pageCount - 1),
    reason: "voice command fallback",
  }),
  zoom_in: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    zoom: clampArtifactZoom(current.zoom * 1.2),
    fitMode: "custom",
    reason: "voice command fallback",
  }),
  zoom_out: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    zoom: clampArtifactZoom(current.zoom / 1.2),
    fitMode: "custom",
    reason: "voice command fallback",
  }),
  fit_width: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    zoom: 1,
    fitMode: "width",
    reason: "voice command fallback",
  }),
  fit_page: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    zoom: 1,
    fitMode: "page",
    reason: "voice command fallback",
  }),
  reset_zoom: (_command, current) => ({
    artifactId: current.artifactId ?? undefined,
    zoom: 1,
    fitMode: "custom",
    reason: "voice command fallback",
  }),
}

function defaultCoreviewSetViewInput(
  _command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
): CoreviewSetViewInput {
  return {
    artifactId: current.artifactId ?? undefined,
    reason: "voice command fallback",
  }
}

export function buildAppliedVoiceCommandStatus(
  command: ArtifactReviewVoiceCommand,
  pageIndex: number,
): string {
  switch (command.kind) {
    case "go_to_page":
    case "next_page":
    case "previous_page":
    case "first_page":
    case "last_page":
      return `Page ${pageIndex + 1} selected`
    case "zoom_in":
    case "zoom_out":
    case "fit_width":
    case "fit_page":
    case "reset_zoom":
      return "PDF view updated"
    case "refresh_view":
      return "Refresh requested"
    case "focus_anchor":
      return "PDF view updated"
    case "add_annotation":
      return appliedAnnotationStatusText(command.annotationKind)
    default:
      return "Artifact view updated"
  }
}

export function buildRefreshUnavailableVoiceCommandMessage(
  command: ArtifactReviewVoiceCommand,
  shouldStartVoiceReview: boolean,
  staleAfterViewChange = false,
): string {
  if (staleAfterViewChange && command.kind !== "refresh_view") {
    return isPageNavigationVoiceCommand(command)
      ? "Page changed. Sophia's view is stale."
      : "PDF view updated. Sophia's view is stale."
  }

  if (shouldStartVoiceReview) {
    return isPageNavigationVoiceCommand(command)
      ? "Page changed. Start Review with Sophia to share this view."
      : "PDF view updated. Start Review with Sophia to share this view."
  }

  if (command.kind === "refresh_view") {
    return "Visual refresh is not active."
  }

  return isPageNavigationVoiceCommand(command)
    ? "Page changed. Visual refresh is not active."
    : "PDF view updated. Visual refresh is not active."
}

export function buildBlockedVoiceCommandMessage(
  command: ArtifactReviewVoiceCommand,
  pageCount: number,
): string {
  if (command.kind === "go_to_page" && command.pageTarget && command.pageTarget > Math.max(1, pageCount)) {
    return "That page is not available in this PDF."
  }

  if (command.kind === "go_to_page" && command.pageTarget) {
    return `I can only review the page you have open. Please switch to page ${command.pageTarget} or use the page controls.`
  }

  return "I can only review the page you have open. Please use the page controls."
}

export function coreviewToolNameFromAction(action: CoreviewActionResult["action"]): CoreviewToolName {
  return action === "refresh_view"
    ? COREVIEW_REFRESH_VIEW_TOOL_NAME
    : action === "add_annotation"
      ? COREVIEW_ADD_ANNOTATION_TOOL_NAME
      : action === "focus_anchor"
        ? COREVIEW_FOCUS_ANCHOR_TOOL_NAME
        : COREVIEW_SET_VIEW_TOOL_NAME
}

export function coreviewToolNameFromVoiceCommand(command: ArtifactReviewVoiceCommand): CoreviewToolName {
  return command.kind === "add_annotation"
    ? COREVIEW_ADD_ANNOTATION_TOOL_NAME
    : command.kind === "focus_anchor"
      ? COREVIEW_FOCUS_ANCHOR_TOOL_NAME
      : command.kind === "refresh_view"
        ? COREVIEW_REFRESH_VIEW_TOOL_NAME
        : COREVIEW_SET_VIEW_TOOL_NAME
}

export function isAnnotationOrFocusVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return command.kind === "add_annotation" || command.kind === "focus_anchor"
}

export function coreviewBlockedStatusText(reason: CoreviewToolBlockedReason | null): string {
  return reason
    ? COREVIEW_BLOCKED_STATUS_TEXT[reason] ?? "Sophia could not update this view."
    : "Sophia could not update this view."
}

export function routeBlockedReasonFromCoreview(
  reason: CoreviewToolBlockedReason | null,
): ArtifactReviewVoiceCommandRouteResult["blockedReason"] {
  switch (reason) {
    case "no_selected_artifact":
      return "no_artifact_selected"
    case "requested_page_out_of_bounds":
      return "requested_page_out_of_bounds"
    case "pages_not_supported":
    case "zoom_not_supported":
    case "annotations_not_supported":
    case "layout_anchor_not_supported":
    case "ocr_not_available":
    case "pptx_native_renderer_unavailable":
    case "unsupported_pages":
    case "unsupported_renderer":
      return "no_multipage_artifact_selected"
    default:
      return reason ? "visual_refresh_unavailable" : null
  }
}

export function refreshResultFromCoreview(
  result: CoreviewToolRefreshResult,
): ArtifactReviewVoiceCommandRefreshResult {
  switch (result) {
    case "success":
      return "success"
    case "error":
    case "failed":
      return "error"
    case "view_ready_timeout":
      return "unavailable"
    case "not_active":
      return "not_active"
    case "unavailable":
    case "refresh_unavailable":
      return "unavailable"
    default:
      return "not_requested"
  }
}

export function coreviewAnnotationStateChanged(result: CoreviewActionResult): boolean {
  if (result.action !== "add_annotation") {
    return false
  }
  return Boolean(
    result.annotation_commit_verified === true
    && typeof result.annotation_commit_count_before === "number"
    && typeof result.annotation_commit_count_after === "number"
    && result.annotation_commit_count_after > result.annotation_commit_count_before,
  )
}

export function annotationFallbackResultFromCoreview(
  result: CoreviewActionResult,
): "success" | "partial_success" | "blocked" | "annotation_commit_failed" | null {
  if (result.action !== "add_annotation") {
    return null
  }
  if (!coreviewAnnotationStateChanged(result)) {
    return result.blocked_reason === "annotation_commit_failed"
      ? "annotation_commit_failed"
      : "blocked"
  }
  return result.annotation_partial_success ? "partial_success" : "success"
}

export function coreviewSetViewInputFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
): CoreviewSetViewInput {
  const buildInput = VOICE_SET_VIEW_INPUT_BUILDERS[command.kind] ?? defaultCoreviewSetViewInput
  return buildInput(command, current)
}

export function coreviewAddAnnotationInputFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
  lastFocusedAnchorType: CoreviewAnnotationAnchor["type"] | null,
): CoreviewAddAnnotationInput {
  return {
    kind: command.annotationKind ?? "highlight",
    artifactId: current.artifactId ?? undefined,
    pageIndex: current.pageIndex,
    anchor: coreviewAnchorFromVoiceCommand(command, lastFocusedAnchorType),
    color: command.color,
    text: command.commentText,
    source: "sophia",
  }
}

export function annotationFallbackUtteranceKind(
  command: ArtifactReviewVoiceCommand,
  commands: ArtifactReviewVoiceCommand[] = [command],
): ArtifactReviewAnnotationUtteranceKind | null {
  if (command.kind !== "add_annotation") {
    return null
  }
  if (commands.filter((candidate) => candidate.kind === "add_annotation").length > 1) {
    return "annotation_compound"
  }
  return command.utteranceKind
    ?? annotationUtteranceKindForKind(command.annotationKind)
}

export function coreviewFocusAnchorInputFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
  lastFocusedAnchorType: CoreviewAnnotationAnchor["type"] | null,
): CoreviewFocusAnchorInput {
  return {
    artifactId: current.artifactId ?? undefined,
    pageIndex: current.pageIndex,
    anchor: coreviewAnchorFromVoiceCommand(command, lastFocusedAnchorType),
    zoomDelta: command.zoomDelta ?? 1.35,
    reason: "voice command fallback",
  }
}

export function coreviewAnnotationCommandAlreadyHandled(
  command: ArtifactReviewVoiceCommand,
  sinceMs: number,
): boolean {
  if (command.kind !== "add_annotation") {
    return false
  }
  return wasRecentCoreviewToolActionHandled({
    toolName: COREVIEW_ADD_ANNOTATION_TOOL_NAME,
    sinceMs,
    matchResult: (result) => (
      result.ok
      && result.action === "add_annotation"
      && result.annotation_kind === (command.annotationKind ?? "highlight")
      && (
        command.color === undefined
        || result.annotation_color === command.color
        || command.annotationKind === "comment"
      )
    ),
  })
}

export function coreviewFocusCommandAlreadyHandled(sinceMs: number): boolean {
  return wasRecentCoreviewToolActionHandled({
    toolName: COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
    sinceMs,
    matchResult: (result) => result.ok && result.action === "focus_anchor",
  })
}

function appliedAnnotationStatusText(kind: ArtifactReviewVoiceCommand["annotationKind"]): string {
  switch (kind) {
    case "comment":
      return "Comment added"
    case "underline":
      return "Underline added"
    case "arrow":
      return "Arrow added"
    case "highlight":
    default:
      return "Highlight added"
  }
}

function isPageNavigationVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return (
    command.kind === "go_to_page"
    || command.kind === "next_page"
    || command.kind === "previous_page"
    || command.kind === "first_page"
    || command.kind === "last_page"
  )
}

function coreviewAnchorFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  lastFocusedAnchorType: CoreviewAnnotationAnchor["type"] | null,
): CoreviewAnnotationAnchor {
  const anchorType = command.anchorType ?? lastFocusedAnchorType ?? "current_title"
  return anchorType === "current_selection"
    ? { type: "current_selection" }
    : { type: "current_title" }
}

function annotationUtteranceKindForKind(
  kind: ArtifactReviewVoiceCommand["annotationKind"],
): ArtifactReviewAnnotationUtteranceKind {
  switch (kind) {
    case "comment":
      return "annotation_comment"
    case "underline":
      return "annotation_underline"
    case "arrow":
      return "annotation_arrow"
    case "highlight":
    default:
      return "annotation_highlight"
  }
}

export function useCoreviewArtifactStageModel({
  builderArtifact,
  builderArtifactLibrary,
  selectedBuilderArtifactPath,
  builderVisualCaptureStatus,
  userId,
  threadId,
}: {
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[]
  selectedBuilderArtifactPath?: string | null
  builderVisualCaptureStatus: ArtifactVisualCaptureStatus
  userId?: string | null
  threadId?: string | null
}) {
  const hasBuilderLibrary = builderArtifactLibrary.length > 0
  const normalizedSelectedBuilderArtifactPath = useMemo(
    () => normalizeStageBuilderArtifactPath(selectedBuilderArtifactPath),
    [selectedBuilderArtifactPath],
  )
  const selectedBuilderLibraryItem = useMemo(
    () => builderArtifactLibrary.find((file) => file.path === normalizedSelectedBuilderArtifactPath) ?? null,
    [builderArtifactLibrary, normalizedSelectedBuilderArtifactPath],
  )
  const stageBuilderArtifact = useMemo(
    () => buildStageBuilderArtifact({
      builderArtifact,
      selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath,
      selectedLibraryItem: selectedBuilderLibraryItem,
      latestLibraryItem: builderArtifactLibrary[0] ?? null,
    }),
    [builderArtifact, builderArtifactLibrary, normalizedSelectedBuilderArtifactPath, selectedBuilderLibraryItem],
  )
  const hasBuilder = !!stageBuilderArtifact
  const builderStageActive = hasBuilder && Boolean(stageBuilderArtifact)
  const builderArtifactId = stageBuilderArtifact
    ? buildCoreviewRealArtifactId(stageBuilderArtifact)
    : null
  const stagePrimaryFile = useMemo(() => {
    return getStagePrimaryFileWithMime(stageBuilderArtifact, builderArtifactLibrary)
  }, [builderArtifactLibrary, stageBuilderArtifact])
  const stageRendererKind = detectArtifactRendererKind(stagePrimaryFile, stageBuilderArtifact)
  const stageArtifactPath = stagePrimaryFile?.path ?? stageBuilderArtifact?.artifactPath ?? null
  const stageArtifactCapabilities = useMemo(() => (
    getCoreviewArtifactCapabilitiesForFile({
      file: stagePrimaryFile,
      rendererKind: stageRendererKind,
      textExtractionStatus: builderVisualCaptureStatus.pdfTextExtractionStatus ?? null,
      exactTextAvailable: builderVisualCaptureStatus.exactTextAvailable,
      layoutAnchorsAvailable: false,
      originalDownloadAvailable: Boolean(stageArtifactPath),
      openInNewTabAvailable: Boolean(stageArtifactPath),
    })
  ), [
    builderVisualCaptureStatus.exactTextAvailable,
    builderVisualCaptureStatus.pdfTextExtractionStatus,
    stageArtifactPath,
    stagePrimaryFile,
    stageRendererKind,
  ])
  const stageArtifactCapabilityTelemetry = useMemo(() => (
    coreviewArtifactCapabilityTelemetry(stageRendererKind, stageArtifactCapabilities)
  ), [stageArtifactCapabilities, stageRendererKind])
  const builderStageVisibilitySignature = useMemo(() => (
    [
      normalizedSelectedBuilderArtifactPath ?? "",
      builderArtifactId ?? "",
      stageArtifactPath ?? "",
      stageRendererKind,
    ].join("|")
  ), [builderArtifactId, normalizedSelectedBuilderArtifactPath, stageArtifactPath, stageRendererKind])
  const artifactStableIdentity = useMemo(() => (
    builderArtifactId
      ? buildCoreviewArtifactStableIdentity({
          userId: userId ?? null,
          threadId: threadId ?? null,
          artifactPath: stageArtifactPath,
          rendererKind: stageRendererKind,
        }).key
      : null
  ), [builderArtifactId, stageArtifactPath, stageRendererKind, threadId, userId])
  const coreviewWorkspaceIdentity = useMemo(() => (
    buildCoreviewWorkspaceKey({
      userId: userId ?? null,
      threadId: threadId ?? null,
    })
  ), [threadId, userId])
  const coreviewWorkspaceKey = coreviewWorkspaceIdentity.key
  const coreviewArtifactKey = useMemo(() => (
    normalizeCoreviewArtifactKey(artifactStableIdentity)
  ), [artifactStableIdentity])
  const coreviewShareState = useMemo(() => (
    buildCoreviewWorkspaceShareState({
      workspaceKey: coreviewWorkspaceKey,
      artifactKey: coreviewArtifactKey,
      status: "unavailable",
    })
  ), [coreviewArtifactKey, coreviewWorkspaceKey])
  const userWorkspaceActor = useMemo(() => (
    buildCoreviewWorkspaceActor({
      kind: "user",
      userId: userId ?? null,
    })
  ), [userId])
  const sophiaWorkspaceActor = useMemo(() => (
    buildCoreviewWorkspaceActor({
      kind: "sophia",
      userId: userId ?? null,
      threadId: threadId ?? null,
    })
  ), [threadId, userId])
  const coreviewAnnotations = useCoreviewAnnotationStore(artifactStableIdentity)
  const {
    annotations: coreviewAnnotationList,
    counts: coreviewAnnotationCounts,
    telemetry: coreviewAnnotationTelemetry,
    addAnnotation: addAnnotationToCoreviewStore,
    updateAnnotation: updateAnnotationInCoreviewStore,
    deleteAnnotation: deleteAnnotationFromCoreviewStore,
  } = coreviewAnnotations

  const recordCoreviewWorkspaceEvent = useCallback((input: CoreviewWorkspaceEventRecorderInput) => {
    const eventArtifactKey = input.artifactKey ?? coreviewArtifactKey
    const event = appendWorkspaceEvent({
      type: input.type,
      workspaceKey: coreviewWorkspaceKey,
      artifactKey: eventArtifactKey,
      actor: input.actor,
      payload: input.payload,
    })
    const telemetry = getCoreviewWorkspaceEventLogTelemetry(
      coreviewWorkspaceKey,
      eventArtifactKey,
      coreviewShareState,
    )

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "coreview-workspace-event",
      payload: {
        artifactId: builderArtifactId ?? null,
        artifactPath: stageArtifactPath,
        artifactRendererKind: stageRendererKind,
        artifactStableIdentity,
        coreviewWorkspaceKeyHash: hashCoreviewWorkspaceKey(coreviewWorkspaceKey),
        workspaceEventType: event.type,
        workspaceEventPayloadExcluded: true,
        ...telemetry,
      },
    })
  }, [
    artifactStableIdentity,
    builderArtifactId,
    coreviewArtifactKey,
    coreviewShareState,
    coreviewWorkspaceKey,
    stageArtifactPath,
    stageRendererKind,
  ])

  const addCoreviewAnnotation = useCallback((input: CoreviewAddAnnotationAdapterInput): CoreviewAddAnnotationAdapterResult => {
    const actor = input.source === "sophia" ? sophiaWorkspaceActor : userWorkspaceActor
    const result = addAnnotationToCoreviewStore({
      kind: input.kind,
      pageIndex: input.pageIndex,
      rect: input.rect,
      point: input.point,
      line: input.line,
      color: input.color,
      text: input.text,
      source: input.source,
      actorId: actor.id,
    })
    const blockedReason = result.blockedReason === "identity_unavailable"
      ? "annotation_target_unavailable"
      : result.blockedReason === "invalid_annotation"
        ? input.kind === "highlight" || input.kind === "underline"
          ? "invalid_rect"
          : "anchor_not_found"
        : result.blockedReason === "annotation_not_found"
          ? "annotation_commit_failed"
          : null

    if (result.ok && result.annotation) {
      recordCoreviewWorkspaceEvent({
        type: "annotation.created",
        actor,
        payload: {
          annotationId: result.annotation.id,
          annotationKind: result.annotation.kind,
          annotationPageIndex: result.annotation.pageIndex,
          annotationColor: result.annotation.color ?? null,
          annotationAnchorType: input.anchor.anchorType,
          annotationSource: input.source,
          annotationCount: result.counts.annotationCount,
          highlightCount: result.counts.highlightCount,
          commentCount: result.counts.commentCount,
          underlineCount: result.counts.underlineCount,
          arrowCount: result.counts.arrowCount,
          drawPathCount: result.counts.drawPathCount,
        },
      })
    }

    return {
      ok: result.ok,
      annotationId: result.annotation?.id ?? null,
      blockedReason,
      annotationCount: result.counts.annotationCount,
      highlightCount: result.counts.highlightCount,
      commentCount: result.counts.commentCount,
      underlineCount: result.counts.underlineCount,
      arrowCount: result.counts.arrowCount,
      drawPathCount: result.counts.drawPathCount,
    }
  }, [addAnnotationToCoreviewStore, recordCoreviewWorkspaceEvent, sophiaWorkspaceActor, userWorkspaceActor])

  const updateCoreviewAnnotation = useCallback((annotationId: string, patch: { text?: string | null }) => {
    const result = updateAnnotationInCoreviewStore(annotationId, {
      ...patch,
      actorId: userWorkspaceActor.id,
    })
    if (result.ok && result.annotation) {
      recordCoreviewWorkspaceEvent({
        type: "annotation.updated",
        actor: userWorkspaceActor,
        payload: {
          annotationId: result.annotation.id,
          annotationKind: result.annotation.kind,
          annotationPageIndex: result.annotation.pageIndex,
          patchKeys: Object.keys(patch).filter((key) => key !== "text").concat(
            patch.text !== undefined ? ["text_redacted"] : [],
          ),
          annotationCount: result.counts.annotationCount,
          highlightCount: result.counts.highlightCount,
          commentCount: result.counts.commentCount,
          underlineCount: result.counts.underlineCount,
          arrowCount: result.counts.arrowCount,
          drawPathCount: result.counts.drawPathCount,
        },
      })
    }
    return result.ok
  }, [recordCoreviewWorkspaceEvent, updateAnnotationInCoreviewStore, userWorkspaceActor])

  const deleteCoreviewAnnotation = useCallback((annotationId: string) => {
    const result = deleteAnnotationFromCoreviewStore(annotationId)
    if (result.ok) {
      recordCoreviewWorkspaceEvent({
        type: "annotation.deleted",
        actor: userWorkspaceActor,
        payload: {
          annotationId,
          annotationCount: result.counts.annotationCount,
          highlightCount: result.counts.highlightCount,
          commentCount: result.counts.commentCount,
          underlineCount: result.counts.underlineCount,
          arrowCount: result.counts.arrowCount,
          drawPathCount: result.counts.drawPathCount,
        },
      })
    }
    return result.ok
  }, [deleteAnnotationFromCoreviewStore, recordCoreviewWorkspaceEvent, userWorkspaceActor])

  return {
    hasBuilderLibrary,
    normalizedSelectedBuilderArtifactPath,
    stageBuilderArtifact,
    hasBuilder,
    builderStageActive,
    builderArtifactId,
    stagePrimaryFile,
    stageRendererKind,
    stageArtifactPath,
    stageArtifactCapabilities,
    stageArtifactCapabilityTelemetry,
    builderStageVisibilitySignature,
    artifactStableIdentity,
    coreviewWorkspaceKey,
    coreviewArtifactKey,
    userWorkspaceActor,
    sophiaWorkspaceActor,
    coreviewAnnotationList,
    coreviewAnnotationCounts,
    coreviewAnnotationTelemetry,
    recordCoreviewWorkspaceEvent,
    addCoreviewAnnotation,
    updateCoreviewAnnotation,
    deleteCoreviewAnnotation,
  }
}
