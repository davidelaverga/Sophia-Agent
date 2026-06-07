"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isHtmlArtifactFile } from "../../lib/builder-artifacts"
import {
  coreviewFeedbackFromActionResult,
  coreviewFeedbackFromBuilderActionResult,
  createCoreviewActionFeedback,
  type CoreviewActionFeedback,
} from "../../lib/coreview-action-feedback"
import {
  createVersionFromBuilderOutput,
  getCurrentVersion,
  getVersionTelemetry,
  restoreOriginalVersion,
  type CoreviewArtifactVersionState,
  type CoreviewArtifactVersionTelemetry,
} from "../../lib/coreview-artifact-version-store"
import { requestCoreviewHtmlQuickPatch } from "../../lib/coreview-html-quick-edit"
import type { ArtifactToolMode } from "../../types/artifact-annotations"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { BuilderCompletionEventV1 } from "../../types/builder-completion"
import type { BuilderTaskV1 } from "../../types/builder-task"
import type { RitualArtifacts } from "../../types/session"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import {
  ArtifactReviewBuilderUpdateCard,
  type ArtifactReviewBuilderUpdateCardStatus,
} from "./ArtifactReviewBuilderUpdateCard"
import { ArtifactStage, type ArtifactReviewVoiceCommandTarget } from "./ArtifactStage"
import { buildCoreviewRealArtifactId, CoreviewRealArtifactCanvas } from "./CoreviewRealArtifactCanvas"
import {
  appendWorkspaceEvent,
  buildArtifactViewSignature,
  buildCoreviewCapabilitySummary,
  buildCoreviewArtifactStableIdentity,
  buildCoreviewWorkspaceActor,
  buildCoreviewWorkspaceKey,
  buildCoreviewWorkspaceShareState,
  clampArtifactZoom,
  cn,
  COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  COREVIEW_SET_VIEW_TOOL_NAME,
  coreviewArtifactCapabilityTelemetry,
  coreviewFlagDiagnostics,
  createCoreviewBuilderActionBus,
  createCoreviewActionBus,
  createDefaultArtifactViewState,
  detectArtifactRendererKind,
  getBuilderArtifactFiles,
  getCoreviewArtifactCapabilitiesForFile,
  getCoreviewWorkspaceEventLogTelemetry,
  haptic,
  hashCoreviewWorkspaceKey,
  isCoreviewStillFrameReviewEnabled,
  isRealReflection,
  normalizeBuilderArtifactPath,
  normalizeCoreviewArtifactKey,
  parseArtifactReviewVoiceCommand,
  parseArtifactReviewVoiceCommands,
  recordSophiaCaptureEvent,
  reconcileCoreviewBuilderTaskStateForContext,
  registerCoreviewBuilderToolBridge,
  registerCoreviewToolBridge,
  resolveCoreviewBuilderActionAvailability,
  safeArtifactViewTelemetry,
  useArtifactCoReview,
  useCoreviewAnnotationStore,
  usePresenceStore,
  wasRecentCoreviewToolActionHandled,
  type ArtifactReviewAnnotationKind,
  type ArtifactReviewAnnotationUtteranceKind,
  type ArtifactReviewVoiceCommand,
  type ArtifactReviewVoiceCommandRefreshResult,
  type ArtifactReviewVoiceCommandRouteResult,
  type ArtifactReviewVoiceCommandRouter,
  type ArtifactViewState,
  type CoReviewMediaTransport,
  type CoreviewActionBus,
  type CoreviewActionResult,
  type CoreviewArtifactUpdateContext,
  type CoreviewArtifactUpdateMode,
  type CoreviewBuilderActionBus,
  type CoreviewBuilderActionResult,
  type CoreviewBuilderCancelAdapterResult,
  type CoreviewBuilderOutputStatus,
  type CoreviewBuilderStartAdapterResult,
  type CoreviewBuilderTaskStatus,
  type CoreviewBuilderToolCallInput,
  type CoreviewBuilderWorkspaceEventInput,
  type CoreviewHtmlQuickPatchActionTelemetry,
  type CoreviewAddAnnotationAdapterInput,
  type CoreviewAddAnnotationAdapterResult,
  type CoreviewAddAnnotationInput,
  type CoreviewAnnotationAnchor,
  type CoreviewArtifactRebindInput,
  type CoreviewArtifactRebindResult,
  type CoreviewCurrentView,
  type CoreviewFocusAnchorInput,
  type CoreviewRendererAdapter,
  type CoreviewSetViewInput,
  type CoreviewToolBlockedReason,
  type CoreviewToolCallInput,
  type CoreviewToolName,
  type CoreviewToolRefreshResult,
  type CoreviewViewReadyResult,
  type CoreviewWorkspaceActor,
  type CoreviewWorkspaceEventType,
} from "./PresenceArtifactPanelDeps"
import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  PresenceArtifactSecondarySurfaces,
} from "./PresenceArtifactSecondarySurfaces"
import { VoiceArtifactStage } from "./VoiceArtifactStage"

interface PresenceArtifactPanelProps {
  artifacts: RitualArtifacts | null | undefined
  builderArtifact?: BuilderArtifactV1 | null
  builderArtifactLibrary?: BuilderArtifactLibraryItemV1[]
  builderTask?: BuilderTaskV1 | null
  builderCompletion?: BuilderCompletionEventV1 | null
  isCancellingBuilderTask?: boolean
  selectedBuilderArtifactPath?: string | null
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  onCoreviewBuilderUpdateRequest?: (input: {
    context: CoreviewArtifactUpdateContext
    prompt: string
    updateMode: CoreviewArtifactUpdateMode
  }) => Promise<CoreviewBuilderStartAdapterResult> | CoreviewBuilderStartAdapterResult
  onCoreviewBuilderCancelRequest?: (input: {
    context: CoreviewArtifactUpdateContext | null
    task: CoreviewBuilderTaskStatus
  }) => Promise<CoreviewBuilderCancelAdapterResult> | CoreviewBuilderCancelAdapterResult
  onCoreviewBuilderViewUpdatedVersion?: (path: string | null) => void
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  userId?: string | null
  threadId?: string
  isVisible: boolean
  onDismiss: () => void
  isVoiceMode: boolean
  coReviewTransport?: CoReviewMediaTransport
  pendingBuilderArtifactReview?: boolean
  onStartVoiceBuilderArtifactReview?: () => void
  onPendingBuilderArtifactReviewConsumed?: () => void
  onArtifactReviewVoiceCommandRouteChange?: (handler: ArtifactReviewVoiceCommandRouter | null) => void
  onCoreviewActionFeedback?: (feedback: CoreviewActionFeedback) => void
  onAnnotationActionSucceeded?: (counts: {
    annotationCount?: number | null
    highlightCount?: number | null
    commentCount?: number | null
    underlineCount?: number | null
    arrowCount?: number | null
    drawPathCount?: number | null
  }) => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
}

type ArtifactVoiceCommandStatus = {
  text: string
  tone: "neutral" | "pending" | "success" | "warn"
}

function getPathFilename(path: string | undefined): string {
  return path?.split('/').filter(Boolean).pop() || 'Builder deliverable'
}

function inferArtifactTypeFromMetadata(
  name: string | undefined,
  mimeTypeValue?: string,
): BuilderArtifactV1["artifactType"] {
  const mimeType = mimeTypeValue?.toLowerCase().split(';')[0]?.trim() ?? ''
  const extension = name?.split('.').pop()?.toLowerCase() ?? ''
  return ARTIFACT_TYPE_RULES.find((rule) => rule.matches(mimeType, extension))?.type ?? 'document'
}

const ARTIFACT_TYPE_RULES: Array<{
  type: BuilderArtifactV1["artifactType"]
  matches: (mimeType: string, extension: string) => boolean
}> = [
  { type: 'presentation', matches: (mimeType, extension) => mimeType.includes('presentation') || ['ppt', 'pptx'].includes(extension) },
  { type: 'webpage', matches: (mimeType, extension) => mimeType.includes('html') || ['html', 'htm'].includes(extension) },
  { type: 'data_analysis', matches: (mimeType, extension) => mimeType.includes('json') || mimeType.includes('csv') || ['csv', 'json', 'xlsx', 'xls'].includes(extension) },
  { type: 'visual_report', matches: (mimeType, extension) => mimeType.includes('image') || extension === 'svg' },
]

function inferArtifactType(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1["artifactType"] {
  return inferArtifactTypeFromMetadata(item.name, item.mimeType)
}

function buildLibraryArtifact(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1 {
  return {
    artifactPath: item.path,
    artifactTitle: item.name || getPathFilename(item.path),
    artifactType: inferArtifactType(item),
    decisionsMade: [],
    companionSummary: 'Ready to preview in the artifact canvas.',
    userNextAction: 'Review it with Sophia when you are ready.',
  }
}

function buildSelectedPathArtifact(path: string): BuilderArtifactV1 | null {
  const normalizedPath = normalizeBuilderArtifactPath(path)
  if (!normalizedPath) {
    return null
  }

  const name = getPathFilename(normalizedPath)
  return {
    artifactPath: normalizedPath,
    artifactTitle: name,
    artifactType: inferArtifactTypeFromMetadata(name),
    decisionsMade: [],
    supportingFiles: [],
    userNextAction: 'Open or download the artifact if the in-canvas preview is unavailable.',
  }
}

function unavailableCaptureStatus(
  reason: ArtifactVisualCaptureStatus["reason"],
  source: ArtifactVisualCaptureStatus["source"] = "none",
): ArtifactVisualCaptureStatus {
  return {
    ready: false,
    reason,
    source,
    exactTextAvailable: false,
  }
}

function buildAppliedVoiceCommandStatus(
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

function buildRefreshUnavailableVoiceCommandMessage(
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

function buildBlockedVoiceCommandMessage(
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

function coreviewToolNameFromAction(action: CoreviewActionResult["action"]): CoreviewToolName {
  return COREVIEW_TOOL_NAME_BY_ACTION[action] ?? COREVIEW_SET_VIEW_TOOL_NAME
}

function coreviewToolNameFromVoiceCommand(command: ArtifactReviewVoiceCommand): CoreviewToolName {
  return COREVIEW_TOOL_NAME_BY_VOICE_COMMAND[command.kind] ?? COREVIEW_SET_VIEW_TOOL_NAME
}

const COREVIEW_TOOL_NAME_BY_ACTION: Partial<Record<CoreviewActionResult["action"], CoreviewToolName>> = {
  refresh_view: COREVIEW_REFRESH_VIEW_TOOL_NAME,
  add_annotation: COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  focus_anchor: COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
}

const COREVIEW_TOOL_NAME_BY_VOICE_COMMAND: Partial<Record<ArtifactReviewVoiceCommand["kind"], CoreviewToolName>> = {
  add_annotation: COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  focus_anchor: COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
  refresh_view: COREVIEW_REFRESH_VIEW_TOOL_NAME,
}

function isAnnotationVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return command.kind === "add_annotation"
}

function isFocusVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return command.kind === "focus_anchor"
}

function isAnnotationOrFocusVoiceCommand(command: ArtifactReviewVoiceCommand): boolean {
  return isAnnotationVoiceCommand(command) || isFocusVoiceCommand(command)
}

function coreviewBlockedStatusText(reason: CoreviewToolBlockedReason | null): string {
  return reason ? COREVIEW_BLOCKED_STATUS_TEXT[reason] ?? "Sophia could not update this view." : "Sophia could not update this view."
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
  text_anchor_not_found: "Sophia could not find that text in this artifact.",
  unsupported_annotation_kind: "That annotation type is not available yet.",
}

function routeBlockedReasonFromCoreview(
  reason: CoreviewToolBlockedReason | null,
): ArtifactReviewVoiceCommandRouteResult["blockedReason"] {
  return reason ? COREVIEW_ROUTE_BLOCKED_REASON[reason] ?? "visual_refresh_unavailable" : null
}

const COREVIEW_ROUTE_BLOCKED_REASON: Partial<Record<
  CoreviewToolBlockedReason,
  NonNullable<ArtifactReviewVoiceCommandRouteResult["blockedReason"]>
>> = {
  no_selected_artifact: "no_artifact_selected",
  requested_page_out_of_bounds: "requested_page_out_of_bounds",
  pages_not_supported: "no_multipage_artifact_selected",
  zoom_not_supported: "no_multipage_artifact_selected",
  annotations_not_supported: "no_multipage_artifact_selected",
  layout_anchor_not_supported: "layout_anchor_not_supported",
  text_anchor_not_found: "text_anchor_not_found",
  ocr_not_available: "no_multipage_artifact_selected",
  pptx_native_renderer_unavailable: "no_multipage_artifact_selected",
  unsupported_pages: "no_multipage_artifact_selected",
  unsupported_renderer: "no_multipage_artifact_selected",
}

function refreshResultFromCoreview(
  result: CoreviewToolRefreshResult,
): ArtifactReviewVoiceCommandRefreshResult {
  return COREVIEW_REFRESH_RESULT[result] ?? "not_requested"
}

const COREVIEW_REFRESH_RESULT: Partial<Record<CoreviewToolRefreshResult, ArtifactReviewVoiceCommandRefreshResult>> = {
  success: "success",
  error: "error",
  failed: "error",
  view_ready_timeout: "unavailable",
  not_active: "not_active",
  unavailable: "unavailable",
  refresh_unavailable: "unavailable",
}

function coreviewAnnotationStateChanged(result: CoreviewActionResult): boolean {
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

function annotationFallbackResultFromCoreview(
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function coreviewSetViewInputFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  current: CoreviewCurrentView,
): CoreviewSetViewInput {
  return {
    artifactId: current.artifactId ?? undefined,
    reason: "voice command fallback",
    ...COREVIEW_SET_VIEW_INPUT_BY_COMMAND[command.kind]?.(command, current),
  }
}

const COREVIEW_SET_VIEW_INPUT_BY_COMMAND: Partial<Record<
  ArtifactReviewVoiceCommand["kind"],
  (command: ArtifactReviewVoiceCommand, current: CoreviewCurrentView) => Partial<CoreviewSetViewInput>
>> = {
  go_to_page: (command) => ({ pageNumber: command.pageTarget }),
  next_page: (_command, current) => ({ pageIndex: current.pageIndex + 1 }),
  previous_page: (_command, current) => ({ pageIndex: current.pageIndex - 1 }),
  first_page: () => ({ pageIndex: 0 }),
  last_page: (_command, current) => ({ pageIndex: Math.max(0, current.pageCount - 1) }),
  zoom_in: (_command, current) => ({ zoom: clampArtifactZoom(current.zoom * 1.2), fitMode: "custom" }),
  zoom_out: (_command, current) => ({ zoom: clampArtifactZoom(current.zoom / 1.2), fitMode: "custom" }),
  fit_width: () => ({ zoom: 1, fitMode: "width" }),
  fit_page: () => ({ zoom: 1, fitMode: "page" }),
  reset_zoom: () => ({ zoom: 1, fitMode: "custom" }),
}

function coreviewAnchorFromVoiceCommand(
  command: ArtifactReviewVoiceCommand,
  lastFocusedAnchorType: CoreviewAnnotationAnchor["type"] | null,
): CoreviewAnnotationAnchor {
  if (command.anchorType === "text_quote" && command.anchorText) {
    return { type: "text_quote", text: command.anchorText }
  }
  const anchorType = command.anchorType ?? lastFocusedAnchorType ?? "current_title"
  return anchorType === "current_selection"
    ? { type: "current_selection" }
    : { type: "current_title" }
}

function coreviewAddAnnotationInputFromVoiceCommand(
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

function annotationFallbackUtteranceKind(
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

function annotationUtteranceKindForKind(
  kind: ArtifactReviewVoiceCommand["annotationKind"],
): ArtifactReviewAnnotationUtteranceKind {
  return ANNOTATION_UTTERANCE_BY_KIND[kind ?? "highlight"] ?? "annotation_highlight"
}

const ANNOTATION_UTTERANCE_BY_KIND: Record<ArtifactReviewAnnotationKind, ArtifactReviewAnnotationUtteranceKind> = {
  comment: "annotation_comment",
  underline: "annotation_underline",
  arrow: "annotation_arrow",
  highlight: "annotation_highlight",
}

function coreviewFocusAnchorInputFromVoiceCommand(
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

function coreviewAnnotationCommandAlreadyHandled(
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

function coreviewFocusCommandAlreadyHandled(sinceMs: number): boolean {
  return wasRecentCoreviewToolActionHandled({
    toolName: COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
    sinceMs,
    matchResult: (result) => result.ok && result.action === "focus_anchor",
  })
}

function buildSelectedArtifactFromExisting(builderArtifact: BuilderArtifactV1, path: string): BuilderArtifactV1 | null {
  const files = getBuilderArtifactFiles(builderArtifact)
  const selectedFile = files.find((file) => file.path === path)

  if (!selectedFile) {
    return null
  }

  return {
    ...builderArtifact,
    artifactPath: selectedFile.path,
    artifactTitle: selectedFile.isPrimary ? builderArtifact.artifactTitle : selectedFile.label,
    supportingFiles: files
      .filter((file) => file.path !== selectedFile.path)
      .map((file) => file.path),
  }
}

function buildStageBuilderArtifact({
  builderArtifact,
  selectedBuilderArtifactPath,
  selectedLibraryItem,
  latestLibraryItem,
}: {
  builderArtifact?: BuilderArtifactV1 | null
  selectedBuilderArtifactPath?: string | null
  selectedLibraryItem?: BuilderArtifactLibraryItemV1 | null
  latestLibraryItem?: BuilderArtifactLibraryItemV1 | null
}): BuilderArtifactV1 | null {
  const normalizedSelectedPath = normalizeBuilderArtifactPath(selectedBuilderArtifactPath)

  if (normalizedSelectedPath) {
    const selectedExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, normalizedSelectedPath)
      : null

    if (selectedExistingArtifact) {
      return selectedExistingArtifact
    }

    if (selectedLibraryItem) {
      return buildLibraryArtifact(selectedLibraryItem)
    }

    return buildSelectedPathArtifact(normalizedSelectedPath)
  }

  if (latestLibraryItem) {
    const latestExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, latestLibraryItem.path)
      : null

    return latestExistingArtifact ?? buildLibraryArtifact(latestLibraryItem)
  }

  if (builderArtifact) {
    return builderArtifact
  }

  return null
}

function getStagePrimaryFileWithMime(
  stageBuilderArtifact: BuilderArtifactV1 | null,
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[],
) {
  const files = getBuilderArtifactFiles(stageBuilderArtifact)
  const file = files.find((candidate) => candidate.isPrimary) ?? files[0] ?? null

  if (!file) {
    return null
  }

  const libraryItem = builderArtifactLibrary.find((item) => item.path === file.path)
  return {
    ...file,
    ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
    ...(typeof libraryItem?.sizeBytes === 'number' ? { sizeBytes: libraryItem.sizeBytes } : {}),
  }
}

function exactTextRehydrateResult({
  isPdf,
  exactTextAvailable,
  pdfStatus,
}: {
  isPdf: boolean
  exactTextAvailable: boolean
  pdfStatus?: string | null
}): string {
  if (!isPdf) {
    return exactTextAvailable ? "not_pdf_exact_text_available" : "not_pdf"
  }
  if (exactTextAvailable || pdfStatus === "success") {
    return "success"
  }
  if (pdfStatus === "loading") {
    return "pending"
  }
  if (pdfStatus === "failed") {
    return "failed"
  }
  return "unavailable"
}

function coreviewBuilderStatusFromTask(task: BuilderTaskV1 | null | undefined): CoreviewBuilderTaskStatus | null {
  if (!task) {
    return null
  }
  return {
    phase: task.phase,
    taskId: task.taskId ?? null,
    runId: task.runId ?? null,
    cancellable: task.phase === "running" && Boolean(task.taskId),
    currentStep: task.activeStepTitle ?? task.detail ?? task.label ?? null,
  }
}

function coreviewOutputFromCompletion(
  completion: BuilderCompletionEventV1 | null | undefined,
): CoreviewBuilderOutputStatus | null {
  if (completion?.status !== "success") {
    return null
  }
  return {
    artifactPath: completion.artifact_path ?? null,
    artifactTitle: completion.artifact_title ?? completion.artifact_filename ?? null,
    artifactHref: completion.artifact_url ?? null,
  }
}

function builderCardStatusFromTask(
  task: BuilderTaskV1 | null | undefined,
  completion: BuilderCompletionEventV1 | null | undefined,
): ArtifactReviewBuilderUpdateCardStatus | null {
  if (completion?.status === "success") {
    return "completed"
  }
  if (completion?.status === "error" || completion?.status === "timeout") {
    return "failed"
  }
  if (completion?.status === "cancelled") {
    return "cancelled"
  }
  if (!task) {
    return null
  }
  if (task.phase === "running") {
    return "updating"
  }
  if (task.phase === "completed") {
    return "completed"
  }
  if (task.phase === "cancelled") {
    return "cancelled"
  }
  return "failed"
}

function coreviewBuilderEventSignature(
  type: CoreviewWorkspaceEventType,
  taskId: string | null | undefined,
  runId: string | null | undefined,
): string {
  return `${type}:${taskId ?? "no-task"}:${runId ?? "no-run"}`
}

function coreviewBuilderCompletionSignature(input: {
  workspaceKey: string
  artifactStableIdentity: string | null
  taskId: string | null | undefined
  runId: string | null | undefined
  outputPath: string | null | undefined
}): string {
  return [
    input.workspaceKey,
    input.artifactStableIdentity ?? "no-artifact",
    input.taskId ?? "no-task",
    input.runId ?? "no-run",
    normalizeBuilderArtifactPath(input.outputPath) ?? "no-output",
  ].join("|")
}

function isHtmlBuilderOutput(output: CoreviewBuilderOutputStatus | null | undefined): boolean {
  return isHtmlArtifactFile({
    path: output?.artifactPath ?? null,
    name: output?.artifactTitle ?? null,
  })
}

type CoreviewHtmlUpdateMatchedBy =
  | "active_coreview_task"
  | "revision_of_artifact_path"
  | "source_artifact_path"
  | "original_artifact_path"
  | "artifact_stable_identity"
  | "builder_task_id"
  | "builder_run_id"
  | "quick_patch"

type PendingCoreviewHtmlAutoApply = {
  signature: string
  context: CoreviewArtifactUpdateContext
  output: CoreviewBuilderOutputStatus
  outputPath: string
  originalPath: string | null
  taskId: string | null
  runId: string | null
  matchedBy: CoreviewHtmlUpdateMatchedBy
  versionState: CoreviewArtifactVersionState
  versionTelemetry: CoreviewArtifactVersionTelemetry
  quickPatchTelemetry?: CoreviewHtmlQuickPatchActionTelemetry | null
  attemptedAt: number
  timedOut: boolean
}

const COREVIEW_HTML_AUTO_APPLY_RENDER_TIMEOUT_MS = 2500

function matchCoreviewHtmlBuilderCompletion({
  context,
  completion,
  output,
  selectedBuilderArtifactPath,
  stageArtifactPath,
  artifactStableIdentity,
  trackedTask,
  allowContextIdentityMatch = true,
}: {
  context: CoreviewArtifactUpdateContext | null
  completion: BuilderCompletionEventV1 | null | undefined
  output: CoreviewBuilderOutputStatus | null | undefined
  selectedBuilderArtifactPath: string | null | undefined
  stageArtifactPath: string | null | undefined
  artifactStableIdentity: string | null | undefined
  trackedTask?: {
    builderTaskId?: string | null
    builderRunId?: string | null
  } | null
  allowContextIdentityMatch?: boolean
}): CoreviewHtmlUpdateMatchedBy | null {
  if (context?.rendererKind !== "html" || !isHtmlBuilderOutput(output)) {
    return null
  }

  const outputPath = normalizeBuilderArtifactPath(output?.artifactPath)
  const contextPath = normalizeBuilderArtifactPath(context.artifactPath)
  if (!outputPath || !contextPath || outputPath === contextPath) {
    return null
  }

  const knownOriginalPaths = new Set(
    [
      contextPath,
      normalizeBuilderArtifactPath(selectedBuilderArtifactPath),
      normalizeBuilderArtifactPath(stageArtifactPath),
    ].filter((path): path is string => Boolean(path)),
  )
  const revisionPath = normalizeBuilderArtifactPath(completion?.revision_of_artifact_path)
  if (revisionPath && knownOriginalPaths.has(revisionPath)) {
    return "revision_of_artifact_path"
  }
  const sourcePath = normalizeBuilderArtifactPath(completion?.source_artifact_path)
  if (sourcePath && knownOriginalPaths.has(sourcePath)) {
    return "source_artifact_path"
  }

  const completionTaskId = normalizeCoreviewToken(completion?.task_id)
  const completionRunId = normalizeCoreviewToken(completion?.run_id)
  const trackedTaskId = normalizeCoreviewToken(trackedTask?.builderTaskId)
  const trackedRunId = normalizeCoreviewToken(trackedTask?.builderRunId)
  if (allowContextIdentityMatch && completionTaskId && trackedTaskId && completionTaskId === trackedTaskId) {
    return "builder_task_id"
  }
  if (allowContextIdentityMatch && completionRunId && trackedRunId && completionRunId === trackedRunId) {
    return "builder_run_id"
  }
  if (allowContextIdentityMatch && ((trackedTaskId && !completionTaskId) || (trackedRunId && !completionRunId))) {
    return "active_coreview_task"
  }

  if (
    allowContextIdentityMatch
    && (
    context.artifactStableIdentity
    && artifactStableIdentity
    && context.artifactStableIdentity === artifactStableIdentity
    )
  ) {
    return "artifact_stable_identity"
  }
  if (allowContextIdentityMatch && knownOriginalPaths.has(contextPath)) {
    return "original_artifact_path"
  }
  return null
}

function normalizeCoreviewToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Cosmic artifact panel — part of the presence field.
 *
 * No card. No border. No solid background. The artifacts emerge from
 * the nebula like constellations becoming visible — text materialises
 * at ultra-low opacity, gains presence through gentle bloom, and the
 * nebula shows through everything.
 *
 * Voice: floats above mic, translucent veil. Text: inline above composer.
 * Dismiss via tap on the whisper-thin close zone or swipe-down.
 */
export function PresenceArtifactPanel({
  artifacts,
  builderArtifact,
  builderArtifactLibrary = [],
  builderTask = null,
  builderCompletion = null,
  isCancellingBuilderTask = false,
  selectedBuilderArtifactPath,
  onSelectedBuilderArtifactPathChange,
  onCoreviewBuilderUpdateRequest,
  onCoreviewBuilderCancelRequest,
  onCoreviewBuilderViewUpdatedVersion,
  sessionId,
  normalSessionId,
  voiceAgentSessionId,
  userId,
  threadId,
  isVisible,
  onDismiss,
  isVoiceMode,
  coReviewTransport,
  pendingBuilderArtifactReview = false,
  onStartVoiceBuilderArtifactReview,
  onPendingBuilderArtifactReviewConsumed,
  onArtifactReviewVoiceCommandRouteChange,
  onCoreviewActionFeedback,
  onAnnotationActionSucceeded,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
}: PresenceArtifactPanelProps) {
  const [phase, setPhase] = useState<"hidden" | "entering" | "visible" | "exiting">("hidden")
  const [revealStep, setRevealStep] = useState(0)
  const [reflectionTapped, setReflectionTapped] = useState(false)
  const autoCollapseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staggerRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const selectedStageCaptureSignatureRef = useRef<string | null>(null)
  const selectedStageRebindSignatureRef = useRef<string | null>(null)
  const builderStageVisibilitySignatureRef = useRef<string | null>(null)
  const [builderArtifactRoot, setBuilderArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [domArtifactRoot, setDomArtifactRoot] = useState<HTMLDivElement | null>(null)
  const [builderVisualCaptureStatus, setBuilderVisualCaptureStatus] = useState<ArtifactVisualCaptureStatus>(
    () => unavailableCaptureStatus("no_selected_artifact"),
  )
  const [reportedBuilderArtifactViewState, setReportedBuilderArtifactViewState] = useState<ArtifactViewState | null>(null)
  const [builderVoiceCommandTarget, setBuilderVoiceCommandTarget] = useState<ArtifactReviewVoiceCommandTarget | null>(null)
  const builderVoiceCommandTargetRef = useRef<ArtifactReviewVoiceCommandTarget | null>(null)
  const lastCoreviewFocusedAnchorTypeRef = useRef<CoreviewAnnotationAnchor["type"] | null>(null)
  const pendingWorkspaceViewActorRef = useRef<CoreviewWorkspaceActor | null>(null)
  const lastWorkspaceViewSignatureRef = useRef<string | null>(null)
  const [coreviewBuilderUpdateCard, setCoreviewBuilderUpdateCard] = useState<{
    artifactTitle: string
    requestedChangeSummary: string
    status: ArtifactReviewBuilderUpdateCardStatus
    currentStep: string | null
    outputTitle: string | null
    outputPath: string | null
    unsupportedReason: string | null
    autoApplied: boolean
    nonHtmlOutput: boolean
    versionLabel: string | null
    restoreAvailable: boolean
  } | null>(null)
  const [coreviewArtifactVersionState, setCoreviewArtifactVersionState] = useState<CoreviewArtifactVersionState | null>(null)
  const [pendingCoreviewHtmlAutoApply, setPendingCoreviewHtmlAutoApply] = useState<PendingCoreviewHtmlAutoApply | null>(null)
  const [restoreOriginalPending, setRestoreOriginalPending] = useState(false)
  const latestCoreviewBuilderContextRef = useRef<CoreviewArtifactUpdateContext | null>(null)
  const emittedCoreviewBuilderEventSignaturesRef = useRef(new Set<string>())
  const autoAppliedCoreviewBuilderSignaturesRef = useRef(new Set<string>())
  const lastCoreviewBuilderAvailabilitySignatureRef = useRef<string | null>(null)
  const recordCoreviewWorkspaceEventRef = useRef<((input: {
    type: CoreviewWorkspaceEventType
    actor: CoreviewWorkspaceActor
    payload: Record<string, unknown>
    artifactKey?: string | null
    builderTaskId?: string | null
    builderRunId?: string | null
    artifactStableIdentity?: string | null
    threadId?: string | null
  }) => void) | null>(null)
  const [voiceCommandStaleViewSignature, setVoiceCommandStaleViewSignature] = useState<string | null>(null)
  const [voiceCommandStatus, setVoiceCommandStatus] = useState<ArtifactVoiceCommandStatus | null>(null)
  const coreviewCurrentViewRef = useRef<CoreviewCurrentView | null>(null)
  const coreviewVisualReadyRef = useRef(false)
  const status = usePresenceStore((s) => s.status)
  const hasBuilderLibrary = builderArtifactLibrary.length > 0
  const normalizedSelectedBuilderArtifactPath = useMemo(
    () => normalizeBuilderArtifactPath(selectedBuilderArtifactPath),
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
  const takeaway = artifacts?.takeaway
  const reflection_candidate = artifacts?.reflection_candidate
  const memory_candidates = artifacts?.memory_candidates
  const hasBuilder = !!stageBuilderArtifact
  const builderStageActive = hasBuilder && Boolean(stageBuilderArtifact)
  const hasReflection = isRealReflection(reflection_candidate?.prompt)
  const hasMemories = memory_candidates && memory_candidates.length > 0
  const hasTakeaway = !!takeaway?.trim()
  const coreviewReviewEnabled = isCoreviewStillFrameReviewEnabled()
  const coreviewDiagnostics = useMemo(() => coreviewFlagDiagnostics(), [])
  const builderArtifactId = stageBuilderArtifact
    ? buildCoreviewRealArtifactId(stageBuilderArtifact)
    : null
  const builderReviewEnabled = Boolean(coreviewReviewEnabled && builderArtifactId)
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
  const defaultArtifactStableIdentity = useMemo(() => (
    builderArtifactId
      ? buildCoreviewArtifactStableIdentity({
          userId: userId ?? null,
          threadId: threadId ?? null,
          artifactPath: stageArtifactPath,
          rendererKind: stageRendererKind,
        }).key
      : null
  ), [builderArtifactId, stageArtifactPath, stageRendererKind, threadId, userId])
  const versionStateAppliesToStage = useMemo(() => (
    Boolean(
      coreviewArtifactVersionState?.versions.some((version) => (
        normalizeBuilderArtifactPath(version.artifactPath) === normalizeBuilderArtifactPath(stageArtifactPath)
      )),
    )
  ), [coreviewArtifactVersionState, stageArtifactPath])
  const artifactStableIdentity = versionStateAppliesToStage
    ? coreviewArtifactVersionState?.logicalArtifactId ?? defaultArtifactStableIdentity
    : defaultArtifactStableIdentity
  const currentCoreviewArtifactVersion = useMemo(() => (
    versionStateAppliesToStage ? getCurrentVersion(coreviewArtifactVersionState) : null
  ), [coreviewArtifactVersionState, versionStateAppliesToStage])
  const coreviewArtifactLogicalId = versionStateAppliesToStage
    ? coreviewArtifactVersionState?.logicalArtifactId ?? artifactStableIdentity
    : artifactStableIdentity
  const coreviewArtifactVersionId = currentCoreviewArtifactVersion?.versionId ?? null
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
  const recordCoreviewWorkspaceEvent = useCallback((input: {
    type: CoreviewWorkspaceEventType
    actor: CoreviewWorkspaceActor
    payload: Record<string, unknown>
    artifactKey?: string | null
    builderTaskId?: string | null
    builderRunId?: string | null
    artifactStableIdentity?: string | null
    threadId?: string | null
  }) => {
    const eventArtifactKey = input.artifactKey ?? coreviewArtifactKey
    const event = appendWorkspaceEvent({
      type: input.type,
      workspaceKey: coreviewWorkspaceKey,
      artifactKey: eventArtifactKey,
      actor: input.actor,
      payload: input.payload,
      artifactId: builderArtifactId,
      artifactStableIdentity: input.artifactStableIdentity ?? artifactStableIdentity,
      threadId: input.threadId ?? threadId ?? null,
      builderTaskId: input.builderTaskId,
      builderRunId: input.builderRunId,
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
        builderWorkspaceEventCount: telemetry.builderWorkspaceEventCount,
        builderLastWorkspaceEventType: telemetry.builderLastWorkspaceEventType,
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
    threadId,
  ])

  useEffect(() => {
    recordCoreviewWorkspaceEventRef.current = recordCoreviewWorkspaceEvent
  }, [recordCoreviewWorkspaceEvent])

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
  const stageUsesMarkdownPreview = stageArtifactCapabilities.renderMode === "markdown"
  const stageUsesHtmlPreview = stageArtifactCapabilities.renderMode === "html" && stageRendererKind === "html"
  const stageUsesPdfPreview = stageArtifactCapabilities.renderMode === "canvas" && stageRendererKind === "pdf"
  const fallbackBuilderArtifactViewState = useMemo(() => (
    createDefaultArtifactViewState({
      artifactId: builderArtifactId,
      filePath: stageArtifactPath,
      rendererKind: stageRendererKind,
    })
  ), [builderArtifactId, stageArtifactPath, stageRendererKind])
  const builderArtifactViewState = (
    reportedBuilderArtifactViewState?.artifactId === builderArtifactId
    && reportedBuilderArtifactViewState?.filePath === stageArtifactPath
  )
    ? reportedBuilderArtifactViewState
    : fallbackBuilderArtifactViewState
  const builderArtifactViewSignature = buildArtifactViewSignature(builderArtifactViewState)
  const workspaceArtifactDescriptor = useMemo(() => (
    isVisible && builderStageActive && builderArtifactId && coreviewArtifactKey
      ? {
          signature: [
            coreviewWorkspaceKey,
            coreviewArtifactKey,
            builderArtifactId,
          ].join("|"),
          artifactKey: coreviewArtifactKey,
          artifactId: builderArtifactId,
          artifactPath: stageArtifactPath,
          artifactTitle: stageBuilderArtifact?.artifactTitle ?? null,
          rendererKind: stageRendererKind,
        }
      : null
  ), [
    builderArtifactId,
    builderStageActive,
    coreviewArtifactKey,
    coreviewWorkspaceKey,
    isVisible,
    stageArtifactPath,
    stageBuilderArtifact?.artifactTitle,
    stageRendererKind,
  ])
  const handleReportedBuilderArtifactViewStateChange = useCallback((state: ArtifactViewState) => {
    setReportedBuilderArtifactViewState(state)
    const nextSignature = buildArtifactViewSignature(state)
    if (!coreviewArtifactKey || !nextSignature) {
      lastWorkspaceViewSignatureRef.current = nextSignature
      return
    }

    const previousSignature = lastWorkspaceViewSignatureRef.current
    if (!previousSignature) {
      lastWorkspaceViewSignatureRef.current = nextSignature
      return
    }
    if (previousSignature === nextSignature) {
      return
    }

    lastWorkspaceViewSignatureRef.current = nextSignature
    const actor = pendingWorkspaceViewActorRef.current ?? userWorkspaceActor
    pendingWorkspaceViewActorRef.current = null
    recordCoreviewWorkspaceEvent({
      type: "view.changed",
      actor,
      payload: {
        artifactId: state.artifactId,
        artifactPath: state.filePath,
        rendererKind: state.rendererKind,
        pageIndex: state.pageIndex,
        pageCount: state.pageCount,
        zoom: state.zoom,
        fitMode: state.fitMode,
        viewSignatureChanged: true,
      },
    })
  }, [coreviewArtifactKey, recordCoreviewWorkspaceEvent, userWorkspaceActor])

  useEffect(() => {
    lastWorkspaceViewSignatureRef.current = null
  }, [coreviewArtifactKey])

  useEffect(() => {
    if (!workspaceArtifactDescriptor) {
      return
    }

    recordCoreviewWorkspaceEventRef.current?.({
      type: "artifact.opened",
      actor: userWorkspaceActor,
      artifactKey: workspaceArtifactDescriptor.artifactKey,
      payload: {
        artifactId: workspaceArtifactDescriptor.artifactId,
        artifactPath: workspaceArtifactDescriptor.artifactPath,
        artifactTitle: workspaceArtifactDescriptor.artifactTitle,
        rendererKind: workspaceArtifactDescriptor.rendererKind,
      },
    })

    return () => {
      recordCoreviewWorkspaceEventRef.current?.({
        type: "artifact.closed",
        actor: userWorkspaceActor,
        artifactKey: workspaceArtifactDescriptor.artifactKey,
        payload: {
          artifactId: workspaceArtifactDescriptor.artifactId,
          artifactPath: workspaceArtifactDescriptor.artifactPath,
          artifactTitle: workspaceArtifactDescriptor.artifactTitle,
          rendererKind: workspaceArtifactDescriptor.rendererKind,
        },
      })
    }
  }, [userWorkspaceActor, workspaceArtifactDescriptor])
  const handleWorkspaceToolModeChange = useCallback((mode: ArtifactToolMode) => {
    recordCoreviewWorkspaceEvent({
      type: "tool.changed",
      actor: userWorkspaceActor,
      payload: {
        toolMode: mode,
        artifactId: builderArtifactId ?? null,
        artifactPath: stageArtifactPath,
        rendererKind: stageRendererKind,
      },
    })
  }, [builderArtifactId, recordCoreviewWorkspaceEvent, stageArtifactPath, stageRendererKind, userWorkspaceActor])
  const handleWorkspaceExportRequested = useCallback((input: {
    exportKind: "original" | "annotated"
    annotationCount: number
  }) => {
    recordCoreviewWorkspaceEvent({
      type: "export.requested",
      actor: userWorkspaceActor,
      payload: {
        exportKind: input.exportKind,
        annotationCount: input.annotationCount,
        artifactId: builderArtifactId ?? null,
        artifactPath: stageArtifactPath,
        rendererKind: stageRendererKind,
      },
    })
  }, [builderArtifactId, recordCoreviewWorkspaceEvent, stageArtifactPath, stageRendererKind, userWorkspaceActor])
  const effectiveBuilderVisualCaptureStatus = useMemo<ArtifactVisualCaptureStatus>(() => {
    if (!builderArtifactId) {
      return unavailableCaptureStatus("no_selected_artifact")
    }

    if (!stageUsesHtmlPreview && !stageUsesMarkdownPreview && !stageUsesPdfPreview) {
      return {
        ready: stageArtifactCapabilities.supportsStillFrame,
        reason: stageArtifactCapabilities.supportsStillFrame ? null : "exact_text_only_no_visual_source",
        source: "metadata_canvas",
        exactTextAvailable: stageArtifactCapabilities.canRender && stageArtifactCapabilities.renderMode === "metadata"
          ? true
          : stageArtifactCapabilities.supportsTextExtraction,
      }
    }

    return builderVisualCaptureStatus
  }, [
    builderArtifactId,
    builderVisualCaptureStatus,
    stageArtifactCapabilities.canRender,
    stageArtifactCapabilities.renderMode,
    stageArtifactCapabilities.supportsStillFrame,
    stageArtifactCapabilities.supportsTextExtraction,
    stageUsesHtmlPreview,
    stageUsesMarkdownPreview,
    stageUsesPdfPreview,
  ])
  const builderVisualSourceReady = Boolean(
    builderArtifactId
    && effectiveBuilderVisualCaptureStatus.ready,
  )
  const builderVisualUnavailableReason = builderArtifactId
    ? effectiveBuilderVisualCaptureStatus.reason
    : "no_selected_artifact"
  const builderExactTextAvailable = Boolean(
    builderArtifactId && effectiveBuilderVisualCaptureStatus.exactTextAvailable,
  )
  const handleBuilderVoiceCommandTargetChange = useCallback((target: ArtifactReviewVoiceCommandTarget | null) => {
    builderVoiceCommandTargetRef.current = target
    setBuilderVoiceCommandTarget((current) => (
      current === target ? current : target
    ))
  }, [])

  useEffect(() => {
    setReportedBuilderArtifactViewState(null)
  }, [builderArtifactId, stagePrimaryFile?.path, stageRendererKind])

  const showDomArtifactCoReview = Boolean(
    coreviewReviewEnabled
    && !builderArtifactId
    && (hasTakeaway || hasReflection || hasMemories),
  )
  const builderArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: builderArtifactId,
    artifactRoot: builderArtifactRoot,
    featureEnabled: builderReviewEnabled,
    exactTextAvailable: builderExactTextAvailable,
    transport: coReviewTransport,
    missingCanvasReason: builderVisualUnavailableReason ?? "capture_target_missing",
    visualSourceReady: builderVisualSourceReady,
    visualSourceUnavailableReason: builderVisualUnavailableReason,
    artifactViewState: builderArtifactViewState,
  })
  const voiceCommandReviewStale = Boolean(
    voiceCommandStaleViewSignature
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && builderArtifactCoReview.state.state === "co_review_live"
      && (builderArtifactCoReview.state.frameSentCount ?? 0) > 0,
  )
  const voiceCommandViewPending = Boolean(
    voiceCommandStaleViewSignature
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && !builderVisualSourceReady,
  )
  const builderHtmlCaptureTargetPending = Boolean(
    stageUsesHtmlPreview
      && builderArtifactId
      && !builderVisualSourceReady
      && builderExactTextAvailable
      && (
        builderVisualUnavailableReason === "preview_not_ready"
        || builderVisualUnavailableReason === "capture_target_missing"
      ),
  )
  const builderReviewViewPending = Boolean(voiceCommandViewPending || builderHtmlCaptureTargetPending)
  const builderReviewStale = Boolean(builderArtifactCoReview.reviewStale || voiceCommandReviewStale)
  const builderReviewStaleReason = builderArtifactCoReview.reviewStaleReason
    ?? (voiceCommandReviewStale ? "view_changed" : null)
  const builderReviewHasFrame = Boolean(
    builderArtifactCoReview.state.state === "co_review_live"
      && (builderArtifactCoReview.state.frameSentCount ?? 0) > 0,
  )
  const coreviewCurrentView = useMemo<CoreviewCurrentView>(() => {
    const capabilities = builderVoiceCommandTarget?.capabilities ?? stageArtifactCapabilities
    return {
      artifactId: builderArtifactId,
      artifactPath: stageArtifactPath,
      artifactTitle: stageBuilderArtifact?.artifactTitle ?? null,
      artifactStableIdentity,
      rendererKind: builderArtifactViewState.rendererKind,
      capabilities,
      supportsPagination: capabilities.supportsPages,
      supportsZoom: capabilities.supportsZoom,
      pageIndex: builderVoiceCommandTarget?.pageIndex ?? builderArtifactViewState.pageIndex,
      pageCount: Math.max(1, builderVoiceCommandTarget?.pageCount ?? builderArtifactViewState.pageCount),
      zoom: builderVoiceCommandTarget?.zoom ?? builderArtifactViewState.zoom,
      fitMode: builderVoiceCommandTarget?.fitMode ?? builderArtifactViewState.fitMode,
      viewSignature: builderArtifactViewSignature,
      stale: builderReviewStale,
      refreshInProgress: builderArtifactCoReview.state.refreshFrameInProgress,
      canRefresh: builderArtifactCoReview.canRefresh,
      reviewActive: builderArtifactCoReview.state.state === "co_review_live",
      reviewHasFrame: builderReviewHasFrame,
      exactTextAvailable: builderExactTextAvailable,
      visualFrameFresh: builderReviewHasFrame && !builderReviewStale,
      annotationOverlayCaptured: builderVoiceCommandTarget?.annotationOverlayCaptured ?? (capabilities.supportsAnnotations ? coreviewAnnotationCounts.annotationCount > 0 : null),
      annotationCount: builderVoiceCommandTarget?.annotationCounts.annotationCount ?? coreviewAnnotationCounts.annotationCount,
      highlightCount: builderVoiceCommandTarget?.annotationCounts.highlightCount ?? coreviewAnnotationCounts.highlightCount,
      commentCount: builderVoiceCommandTarget?.annotationCounts.commentCount ?? coreviewAnnotationCounts.commentCount,
      underlineCount: builderVoiceCommandTarget?.annotationCounts.underlineCount ?? coreviewAnnotationCounts.underlineCount,
      arrowCount: builderVoiceCommandTarget?.annotationCounts.arrowCount ?? coreviewAnnotationCounts.arrowCount,
      drawPathCount: builderVoiceCommandTarget?.annotationCounts.drawPathCount ?? coreviewAnnotationCounts.drawPathCount,
      rebindStatus: "not_attempted",
    }
  }, [
    artifactStableIdentity,
    builderArtifactCoReview.canRefresh,
    builderArtifactCoReview.state.refreshFrameInProgress,
    builderArtifactCoReview.state.state,
    builderArtifactId,
    builderArtifactViewSignature,
    builderArtifactViewState.fitMode,
    builderArtifactViewState.pageCount,
    builderArtifactViewState.pageIndex,
    builderArtifactViewState.rendererKind,
    builderArtifactViewState.zoom,
    builderExactTextAvailable,
    builderReviewHasFrame,
    builderReviewStale,
    builderVoiceCommandTarget,
    coreviewAnnotationCounts.annotationCount,
    coreviewAnnotationCounts.arrowCount,
    coreviewAnnotationCounts.commentCount,
    coreviewAnnotationCounts.drawPathCount,
    coreviewAnnotationCounts.highlightCount,
    coreviewAnnotationCounts.underlineCount,
    stageBuilderArtifact?.artifactTitle,
    stageArtifactPath,
    stageArtifactCapabilities,
  ])
  useEffect(() => {
    coreviewCurrentViewRef.current = coreviewCurrentView
  }, [coreviewCurrentView])
  const coreviewBuilderCapabilitySummary = useMemo(() => (
    buildCoreviewCapabilitySummary({
      capabilities: coreviewCurrentView.capabilities,
      rendererKind: coreviewCurrentView.rendererKind,
      pageIndex: coreviewCurrentView.pageIndex,
      pageCount: coreviewCurrentView.pageCount,
    })
  ), [coreviewCurrentView])
  const coreviewBuilderActionAvailability = useMemo(() => (
    resolveCoreviewBuilderActionAvailability({
      coreviewEnabled: coreviewReviewEnabled,
      artifactSelected: Boolean(builderArtifactId && stageArtifactPath),
      artifactPath: stageArtifactPath,
      rendererKind: stageRendererKind,
      capabilitySummary: coreviewBuilderCapabilitySummary,
      requestArtifactUpdateWired: Boolean(onCoreviewBuilderUpdateRequest),
      cancelBuilderTaskWired: Boolean(onCoreviewBuilderCancelRequest),
    })
  ), [
    builderArtifactId,
    coreviewBuilderCapabilitySummary,
    coreviewReviewEnabled,
    onCoreviewBuilderCancelRequest,
    onCoreviewBuilderUpdateRequest,
    stageArtifactPath,
    stageRendererKind,
  ])
  useEffect(() => {
    coreviewVisualReadyRef.current = builderVisualSourceReady
  }, [builderVisualSourceReady])
  const domArtifactCoReview = useArtifactCoReview({
    sessionId: sessionId ?? null,
    normalSessionId: normalSessionId ?? null,
    threadId: threadId ?? null,
    artifactId: showDomArtifactCoReview ? COREVIEW_COMPANION_ARTIFACT_ID : null,
    artifactRoot: domArtifactRoot,
    featureEnabled: showDomArtifactCoReview,
    exactTextAvailable: showDomArtifactCoReview,
    transport: coReviewTransport,
    missingCanvasReason: "artifact_canvas_not_found",
  })
  const builderReviewCanStart = builderArtifactCoReview.canStart
  const builderReviewStateName = builderArtifactCoReview.state.state
  const startBuilderArtifactReview = builderArtifactCoReview.startReview
  const transportNeedsVoice = Boolean(
    builderArtifactId
    && builderVisualSourceReady
    && builderArtifactCoReview.transportStatus.stillFramesSupported
    && !builderArtifactCoReview.transportStatus.visualTransportSupported
    && builderArtifactCoReview.state.state !== "co_review_error"
    && builderArtifactCoReview.state.frameSendFailureCount === 0
  )
  const visualReviewRequiresVoice = Boolean(
    transportNeedsVoice
    && !isVoiceMode
  )
  const visualReviewPreparing = Boolean(
    transportNeedsVoice
    && isVoiceMode
  )

  const recordSelectedStageArtifactTelemetry = useCallback((details: {
    rebindAttempted: boolean
    rebindSource: CoreviewArtifactRebindInput["source"]
    rebindReason?: string | null
    requestedArtifactId?: string | null
  }): boolean => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId) {
      return false
    }

    const requestedArtifactId = details.requestedArtifactId ?? null
    const rebindResult = details.rebindAttempted
      ? requestedArtifactId && requestedArtifactId !== builderArtifactId
        ? "failed"
        : "success"
      : "not_attempted"
    const rebindReason = details.rebindAttempted && rebindResult === "failed"
      ? "artifact_not_available_in_current_session"
      : details.rebindReason ?? null
    const exactRehydrateResult = exactTextRehydrateResult({
      isPdf: stageUsesPdfPreview,
      exactTextAvailable: builderExactTextAvailable,
      pdfStatus: effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus ?? null,
    })

    recordSophiaCaptureEvent({
      category: "artifacts-runtime",
      name: "select-stage-artifact",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        voiceAgentSessionId: voiceAgentSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        artifactPath: stageArtifactPath,
        artifactTitle: stageBuilderArtifact.artifactTitle,
        artifactType: stageBuilderArtifact.artifactType,
        artifactKind: "builder_file",
        artifactStableIdentity,
        selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath ?? null,
        source: normalizedSelectedBuilderArtifactPath ? "selected_builder_artifact" : "latest_builder_artifact",
        reviewFeatureEnabled: coreviewReviewEnabled,
        artifactRebindAttempted: details.rebindAttempted,
        artifactRebindResult: rebindResult,
        artifactRebindReason: rebindReason,
        artifactReboundFromRenderedState: details.rebindAttempted && isVisible,
        artifactRebindSource: details.rebindSource,
        exactTextRehydrated: details.rebindAttempted && builderExactTextAvailable,
        exactTextRehydrateResult: exactRehydrateResult,
        currentRunSelectedStageEvents: 1,
        longLivedSelectedStageState: true,
        telemetryScopeMode: details.rebindAttempted ? "current_run_rebind" : "long_lived_selected_stage",
        ...coreviewDiagnostics,
        ...stageArtifactCapabilityTelemetry,
        exactTextSource: stageUsesMarkdownPreview
          ? "builder_file"
          : stageUsesPdfPreview
            ? builderExactTextAvailable
              ? "pdf_text_extraction"
              : "unsupported"
            : "builder_metadata",
        exactTextAvailable: builderExactTextAvailable,
        pdfTextExtractionStatus: effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus ?? null,
        pdfTextExtractionPageCount: effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount ?? null,
        pdfTextExtractionCharCount: effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount ?? null,
        pdfTextExtractionSource: effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource ?? null,
        visualCaptureSource: effectiveBuilderVisualCaptureStatus.source,
        visualCaptureReady: effectiveBuilderVisualCaptureStatus.ready,
        visualCaptureReason: effectiveBuilderVisualCaptureStatus.reason,
        ...safeArtifactViewTelemetry(
          builderArtifactViewState,
          builderArtifactCoReview.lastFrameViewSignature,
          builderReviewStaleReason,
        ),
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })

    return rebindResult !== "failed"
  }, [
    artifactStableIdentity,
    builderArtifactCoReview.lastFrameViewSignature,
    builderArtifactId,
    builderArtifactViewState,
    builderExactTextAvailable,
    builderReviewStaleReason,
    coreviewDiagnostics,
    coreviewReviewEnabled,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus,
    effectiveBuilderVisualCaptureStatus.ready,
    effectiveBuilderVisualCaptureStatus.reason,
    effectiveBuilderVisualCaptureStatus.source,
    isVisible,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    sessionId,
    stageArtifactPath,
    stageArtifactCapabilityTelemetry,
    stageBuilderArtifact,
    stageUsesMarkdownPreview,
    stageUsesPdfPreview,
    threadId,
    voiceAgentSessionId,
  ])

  const recordReviewVoiceCommandTelemetry = useCallback((details: {
    command: ArtifactReviewVoiceCommand
    commands?: ArtifactReviewVoiceCommand[]
    applied: boolean
    blockedReason: ArtifactReviewVoiceCommandRouteResult["blockedReason"]
    triggeredRefresh: boolean
    refreshResult: ArtifactReviewVoiceCommandRefreshResult
    artifactCurrentPageIndex: number
    artifactCurrentPageCount: number
    staleAfterPageChange?: boolean
    waitedForViewReady?: boolean
    autoRefreshTiming?: string | null
    autoRefreshBlockedReason?: string | null
    transportStateBefore?: string | null
    transportStateAfter?: string | null
    annotationFallbackAttempted?: boolean
    annotationFallbackResult?: "success" | "partial_success" | "blocked" | "not_attempted" | "annotation_commit_failed" | null
    annotationFallbackBlockedReason?: string | null
    recentAnnotationActionSucceeded?: boolean
    annotationCommitAttempted?: boolean
    annotationCommitResult?: string | null
    annotationCommitCountBefore?: number | null
    annotationCommitCountAfter?: number | null
    annotationCommitVerified?: boolean
    annotationCommandPreventedNavigation?: boolean
    annotationCommandKeptArtifactMounted?: boolean
    annotationViewReadyTimedOut?: boolean
    annotationPartialSuccess?: boolean
    sessionLeaveGuardSuppressedForAnnotation?: boolean
  }) => {
    const annotationIntentDetected = details.command.kind === "add_annotation"
    const annotationFallbackKind = annotationFallbackUtteranceKind(details.command, details.commands)
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "artifact-review-voice-command",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        artifactId: builderArtifactId,
        coreviewArtifactId: builderArtifactId,
        reviewVoiceCommandDetected: true,
        reviewVoiceCommandKind: details.command.kind,
        reviewVoiceCommandPageTarget: details.command.pageTarget ?? null,
        annotationIntentDetected,
        annotationIntentDetectedCount: annotationIntentDetected ? 1 : 0,
        annotationIntentSource: annotationIntentDetected ? "artifact_review_voice_command" : null,
        annotationFallbackAttempted: details.annotationFallbackAttempted ?? false,
        annotationFallbackResult: details.annotationFallbackResult ?? null,
        annotationFallbackBlockedReason: details.annotationFallbackBlockedReason ?? null,
        annotationFallbackUtteranceKind: annotationFallbackKind,
        recentAnnotationActionSucceeded: details.recentAnnotationActionSucceeded ?? false,
        annotationCommitAttempted: details.annotationCommitAttempted ?? false,
        annotationCommitResult: details.annotationCommitResult ?? null,
        annotationCommitCountBefore: details.annotationCommitCountBefore ?? null,
        annotationCommitCountAfter: details.annotationCommitCountAfter ?? null,
        annotationCommitVerified: details.annotationCommitVerified ?? false,
        annotationCommandPreventedNavigation: details.annotationCommandPreventedNavigation ?? false,
        annotationCommandKeptArtifactMounted: details.annotationCommandKeptArtifactMounted ?? false,
        annotationViewReadyTimedOut: details.annotationViewReadyTimedOut ?? false,
        annotationPartialSuccess: details.annotationPartialSuccess ?? false,
        sessionLeaveGuardSuppressedForAnnotation: details.sessionLeaveGuardSuppressedForAnnotation ?? false,
        reviewVoiceCommandApplied: details.applied,
        reviewVoiceCommandBlockedReason: details.blockedReason ?? null,
        reviewVoiceCommandTriggeredRefresh: details.triggeredRefresh,
        reviewVoiceCommandRefreshResult: details.refreshResult,
        reviewVoiceCommandTransportStateBefore: details.transportStateBefore ?? builderArtifactCoReview.transportStatus.statusText,
        reviewVoiceCommandTransportStateAfter: details.transportStateAfter ?? builderArtifactCoReview.transportStatus.statusText,
        reviewVoiceCommandDidHardIntercept: false,
        reviewVoiceCommandWaitedForViewReady: details.waitedForViewReady ?? false,
        reviewVoiceCommandAutoRefreshTiming: details.autoRefreshTiming ?? null,
        reviewVoiceCommandAutoRefreshBlockedReason: details.autoRefreshBlockedReason ?? null,
        reviewCommandPreservedMic: true,
        reviewCommandPreservedReview: true,
        reviewCommandAutoRefreshAttempted: details.triggeredRefresh,
        reviewCommandAutoRefreshResult: details.refreshResult,
        reviewCommandStaleAfterPageChange: details.staleAfterPageChange ?? false,
        reviewCommandStaleAfterViewChange: details.staleAfterPageChange ?? false,
        lastReviewVoiceCommandKind: details.command.kind,
        lastReviewVoiceCommandApplied: details.applied,
        lastReviewVoiceCommandUiMode: isVoiceMode ? "voice" : "text",
        artifactCurrentPageIndex: details.artifactCurrentPageIndex,
        artifactCurrentPageCount: details.artifactCurrentPageCount,
        artifactRendererKind: builderArtifactViewState.rendererKind,
        artifactFitMode: builderArtifactViewState.fitMode,
        artifactViewSignature: builderArtifactViewSignature,
        rawTranscriptExcluded: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderArtifactCoReview.transportStatus.statusText,
    builderArtifactId,
    builderArtifactViewSignature,
    builderArtifactViewState.fitMode,
    builderArtifactViewState.rendererKind,
    isVoiceMode,
    normalSessionId,
    sessionId,
    threadId,
  ])

  const recordCoreviewToolTelemetry = useCallback((result: CoreviewActionResult) => {
    const annotationStateChanged = coreviewAnnotationStateChanged(result)
    const annotationFallbackResult = annotationFallbackResultFromCoreview(result)
    const capabilitySummary = result.capability_summary ?? null
    const annotationCommandKeptArtifactMounted = Boolean(
      result.action === "add_annotation"
      && isVisible
      && builderStageActive
      && builderVoiceCommandTargetRef.current,
    )

    if (result.action === "add_annotation" && annotationStateChanged) {
      onAnnotationActionSucceeded?.({
        annotationCount: result.annotation_count,
        highlightCount: result.highlight_count,
        commentCount: result.comment_count,
        underlineCount: result.underline_count,
        arrowCount: result.arrow_count,
        drawPathCount: result.draw_path_count,
      })
    }

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-tool-call",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewToolCallCount: 1,
        coreviewToolCompletedCount: 1,
        coreviewToolName: coreviewToolNameFromAction(result.action),
        coreviewToolResult: result.ok ? "success" : "blocked",
        coreviewToolLastResult: result.ok ? "success" : "blocked",
        coreviewToolBlockedReason: result.blocked_reason,
        coreviewToolCommandSource: result.command_source,
        coreviewToolPreservedMic: result.preserved_mic,
        coreviewToolPreservedReview: result.preserved_review,
        coreviewToolRefreshAttempted: result.refresh_attempted,
        coreviewToolRefreshResult: result.refresh_result,
        coreviewToolVisualFreshAfterResult: result.visual_fresh ?? result.visual_frame_fresh ?? false,
        coreviewToolViewReadyWaitMs: result.view_ready_wait_ms,
        coreviewToolViewSignatureBefore: result.view_signature_before,
        coreviewToolViewSignatureAfter: result.view_signature_after,
        coreviewWorkspaceContractVersion: result.coreview_workspace_contract_version ?? null,
        artifactCapabilityRendererKind: capabilitySummary?.rendererKind ?? result.renderer_kind,
        artifactCapabilityRenderMode: capabilitySummary?.renderMode ?? null,
        artifactCapabilitySupportsPages: capabilitySummary?.supportsPages ?? null,
        artifactCapabilitySupportsAnnotations: capabilitySummary?.supportsAnnotations ?? null,
        artifactCapabilitySupportsTextExtraction: capabilitySummary?.supportsTextExtraction ?? null,
        artifactCapabilitySupportsLayoutAnchors: capabilitySummary?.supportsLayoutAnchors ?? null,
        artifactCapabilitySupportsOCR: capabilitySummary?.supportsOCR ?? null,
        artifactCapabilityRequiresOCR: capabilitySummary?.requiresOCR ?? null,
        artifactCapabilitySupportsPptxNativeRender: capabilitySummary?.supportsPptxNativeRender ?? null,
        artifactCapabilitySupportsAnnotatedExport: capabilitySummary?.supportsAnnotatedExport ?? null,
        artifactCapabilityFallbackReason: capabilitySummary?.fallbackReason ?? null,
        coreviewHtmlAnnotationsEnabled: result.renderer_kind === "html"
          ? capabilitySummary?.supportsAnnotations === true
          : null,
        coreviewHtmlAnnotationKind: result.renderer_kind === "html" && result.action === "add_annotation"
          ? result.annotation_kind ?? null
          : null,
        coreviewHtmlAnnotationAnchorType: result.renderer_kind === "html" && result.action === "add_annotation"
          ? result.annotation_anchor_type ?? null
          : null,
        coreviewHtmlAnnotationResult: result.renderer_kind === "html" && result.action === "add_annotation"
          ? annotationFallbackResult
          : null,
        coreviewHtmlAnnotationPersisted: result.renderer_kind === "html" && result.action === "add_annotation"
          ? annotationStateChanged
          : null,
        coreviewAnnotationToolCount: result.action === "add_annotation" ? 1 : 0,
        coreviewAnnotationToolResult: result.action === "add_annotation" ? annotationFallbackResult : null,
        coreviewAnnotationFallbackCount: result.action === "add_annotation" && result.command_source === "frontend_fallback" ? 1 : 0,
        coreviewAnnotationCommandSource: result.action === "add_annotation" ? result.command_source : null,
        coreviewAnnotationFallbackResult: result.action === "add_annotation" && result.command_source === "frontend_fallback" ? annotationFallbackResult : null,
        coreviewAnnotationKind: result.annotation_kind ?? null,
        coreviewAnnotationAnchorType: result.annotation_anchor_type ?? null,
        coreviewAnnotationColor: result.annotation_color ?? null,
        coreviewAnnotationPageIndex: result.annotation_page_index ?? null,
        coreviewAnnotationBlockedReason: result.action === "add_annotation" ? result.blocked_reason : null,
        annotationIntentDetectedCount: result.action === "add_annotation" ? 1 : 0,
        annotationIntentSource: result.action === "add_annotation" ? "coreview_tool_result" : null,
        annotationFallbackAttempted: result.action === "add_annotation" && result.command_source === "frontend_fallback",
        annotationFallbackResult: result.action === "add_annotation" && result.command_source === "frontend_fallback"
          ? annotationFallbackResult
          : null,
        annotationFallbackBlockedReason: result.action === "add_annotation" && result.command_source === "frontend_fallback"
          ? result.blocked_reason
          : null,
        recentAnnotationActionSucceeded: annotationStateChanged,
        annotationCommitAttempted: result.annotation_commit_attempted ?? false,
        annotationCommitResult: result.annotation_commit_result ?? null,
        annotationCommitCountBefore: result.annotation_commit_count_before ?? null,
        annotationCommitCountAfter: result.annotation_commit_count_after ?? null,
        annotationCommitVerified: result.annotation_commit_verified ?? false,
        annotationCommandPreventedNavigation: result.action === "add_annotation",
        annotationCommandKeptArtifactMounted,
        annotationViewReadyTimedOut: result.annotation_view_ready_timed_out ?? false,
        annotationPartialSuccess: result.annotation_partial_success ?? false,
        sessionLeaveGuardSuppressedForAnnotation: result.action === "add_annotation",
        coreviewFocusAnchorCount: result.action === "focus_anchor" ? 1 : 0,
        coreviewFocusAnchorResult: result.action === "focus_anchor" ? (result.ok ? "success" : "blocked") : null,
        coreviewFocusAnchorType: result.focus_anchor_type ?? null,
        annotationOverlayCaptured: result.annotation_overlay_captured ?? null,
        annotationCount: result.annotation_count ?? null,
        highlightCount: result.highlight_count ?? null,
        commentCount: result.comment_count ?? null,
        underlineCount: result.underline_count ?? null,
        arrowCount: result.arrow_count ?? null,
        drawPathCount: result.draw_path_count ?? null,
        unsupportedAnnotationKind: result.unsupported_annotation_kind ?? null,
        annotationActionSource: result.annotation_action_source ?? null,
        artifactStableIdentity: result.artifact_stable_identity ?? artifactStableIdentity,
        artifactRebindAttempted: result.rebind_attempted,
        artifactRebindResult: result.rebind_result,
        artifactRebindReason: result.rebind_reason,
        artifactRebindSource: result.rebind_attempted ? "coreview_tool" : null,
        artifactReboundFromRenderedState: result.rebind_attempted && isVisible,
        coreviewSetViewPageIndex: result.action === "set_view" ? result.page_index : null,
        coreviewSetViewPageCount: result.action === "set_view" ? result.page_count : null,
        artifactId: result.artifact_id,
        artifactPath: result.artifact_path,
        artifactRendererKind: result.renderer_kind,
        artifactCurrentPageIndex: result.page_index,
        artifactCurrentPageCount: result.page_count,
        rawTranscriptExcluded: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [artifactStableIdentity, builderStageActive, isVisible, normalSessionId, onAnnotationActionSucceeded, sessionId, threadId])

  const emitCoreviewToolFeedback = useCallback((
    result: CoreviewActionResult,
    options?: {
      voiceTriggered?: boolean
      commandKind?: ArtifactReviewVoiceCommand["kind"] | null
      dedupePrefix?: string | null
    },
  ) => {
    onCoreviewActionFeedback?.(coreviewFeedbackFromActionResult(result, {
      voiceMode: isVoiceMode,
      voiceTriggered: options?.voiceTriggered ?? isVoiceMode,
      commandKind: options?.commandKind ?? null,
      dedupePrefix: options?.dedupePrefix ?? null,
    }))
  }, [isVoiceMode, onCoreviewActionFeedback])

  const applyCoreviewActionStatus = useCallback((result: CoreviewActionResult) => {
    if (!result.ok) {
      setVoiceCommandStatus({
        text: coreviewBlockedStatusText(result.blocked_reason),
        tone: "warn",
      })
      return
    }

    if (result.action === "refresh_view") {
      setVoiceCommandStatus({
        text: result.refresh_result === "success" ? "Sophia's view refreshed" : "Refresh requested",
        tone: result.refresh_result === "success" ? "success" : "neutral",
      })
      return
    }

    if (result.action === "set_view") {
      setVoiceCommandStatus({
        text: result.refresh_attempted && result.refresh_result === "success"
          ? "Sophia's view refreshed"
          : result.page_number
            ? `Page ${result.page_number} selected`
            : "Artifact view updated",
        tone: result.refresh_attempted && result.refresh_result === "success" ? "success" : "neutral",
      })
      return
    }

    if (result.action === "add_annotation") {
      if (result.annotation_partial_success && result.blocked_reason === "view_ready_timeout") {
        setVoiceCommandStatus({
          text: result.annotation_kind === "comment"
            ? "Comment added; refresh timed out"
            : "Highlight added; refresh timed out",
          tone: "warn",
        })
        return
      }
      setVoiceCommandStatus({
        text: result.annotation_kind === "comment"
          ? "Sophia added a comment"
          : "Sophia added a highlight",
        tone: "success",
      })
      return
    }

    if (result.action === "focus_anchor") {
      setVoiceCommandStatus({
        text: result.focus_anchor_type === "current_title"
          ? "Sophia focused the title"
          : "Sophia focused the anchor",
        tone: "success",
      })
      return
    }

    setVoiceCommandStatus({
      text: result.page_number && result.page_count
        ? `Page ${result.page_number} of ${result.page_count}`
        : "Current view ready",
      tone: "neutral",
    })
  }, [])

  const waitForCoreviewViewReady = useCallback(async (viewSignature: string | null): Promise<CoreviewViewReadyResult> => {
    const startedAt = Date.now()
    const timeoutMs = 2500
    const pollMs = 25

    while (Date.now() - startedAt <= timeoutMs) {
      const current = coreviewCurrentViewRef.current
      const signatureReady = !viewSignature || current?.viewSignature === viewSignature
      if (signatureReady && coreviewVisualReadyRef.current) {
        return {
          ok: true,
          waitMs: Date.now() - startedAt,
          blockedReason: null,
        }
      }
      await delay(pollMs)
    }

    return {
      ok: false,
      waitMs: Date.now() - startedAt,
      blockedReason: "view_ready_timeout",
    }
  }, [])

  const coreviewAdapter = useMemo<CoreviewRendererAdapter>(() => ({
    getCurrentViewState: () => coreviewCurrentViewRef.current ?? coreviewCurrentView,
    setView: (view) => {
      const current = coreviewCurrentViewRef.current ?? coreviewCurrentView
      const expectedViewSignature = buildArtifactViewSignature({
        artifactId: current.artifactId,
        filePath: current.artifactPath,
        rendererKind: current.rendererKind,
        pageIndex: view.pageIndex,
        pageCount: current.pageCount,
        zoom: view.zoom,
        fitMode: view.fitMode,
      })
      if (expectedViewSignature !== current.viewSignature) {
        setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      }
      builderVoiceCommandTargetRef.current?.setView(view)
    },
    refreshView: async () => {
      if (!builderArtifactCoReview.canRefresh) {
        return {
          ok: false,
          refreshResult: builderArtifactCoReview.state.state === "co_review_live" ? "refresh_unavailable" : "not_active",
          blockedReason: builderArtifactCoReview.state.state === "co_review_live" ? "refresh_unavailable" : "review_not_active",
        }
      }
      const nextState = await builderArtifactCoReview.refreshReview()
      const ok = nextState.refreshFrameResult === "success" && (nextState.frameSentCount ?? 0) > 0
      return {
        ok,
        refreshResult: ok ? "success" : "error",
        blockedReason: ok
          ? null
          : "refresh_unavailable",
      }
    },
    waitForViewReady: waitForCoreviewViewReady,
    markViewStale: (viewSignature) => {
      if (viewSignature) {
        setVoiceCommandStaleViewSignature(viewSignature)
      }
    },
    clearViewStale: (viewSignature) => {
      setVoiceCommandStaleViewSignature((current) => (
        current && (!viewSignature || current === viewSignature) ? null : current
      ))
    },
    resolveAnnotationAnchor: (input) => {
      const target = builderVoiceCommandTargetRef.current
      return target
        ? target.resolveAnchor(input)
        : { ok: false, blockedReason: "annotation_target_unavailable" }
    },
    addAnnotation: (input) => {
      const target = builderVoiceCommandTargetRef.current
      if (!target) {
        return {
          ok: false,
          annotationId: null,
          blockedReason: "annotation_target_unavailable",
          annotationCount: 0,
          highlightCount: 0,
          commentCount: 0,
          underlineCount: 0,
          arrowCount: 0,
          drawPathCount: 0,
        }
      }

      const result = target.addAnnotation(input)
      coreviewCurrentViewRef.current = {
        ...(coreviewCurrentViewRef.current ?? coreviewCurrentView),
        annotationOverlayCaptured: result.annotationCount > 0,
        annotationCount: result.annotationCount,
        highlightCount: result.highlightCount,
        commentCount: result.commentCount,
        underlineCount: result.underlineCount,
        arrowCount: result.arrowCount,
        drawPathCount: result.drawPathCount,
      }
      coreviewVisualReadyRef.current = false
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      return result
    },
    focusAnnotationAnchor: (input) => {
      const target = builderVoiceCommandTargetRef.current
      if (target) {
        setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
      }
      return target
        ? target.focusAnchor(input)
        : { ok: false, blockedReason: "annotation_target_unavailable" }
    },
    rebindVisibleArtifact: (input: CoreviewArtifactRebindInput): CoreviewArtifactRebindResult => {
      const current = coreviewCurrentViewRef.current ?? coreviewCurrentView
      if (!isVisible || !builderStageActive || !builderArtifactId) {
        return {
          ok: false,
          status: "failed",
          reason: "no_selected_artifact",
          currentView: {
            ...current,
            rebindStatus: "failed",
          },
        }
      }

      if (input.requestedArtifactId && input.requestedArtifactId !== builderArtifactId) {
        void recordSelectedStageArtifactTelemetry({
          rebindAttempted: true,
          rebindSource: input.source,
          rebindReason: "artifact_not_available_in_current_session",
          requestedArtifactId: input.requestedArtifactId,
        })
        return {
          ok: false,
          status: "failed",
          reason: "artifact_not_available_in_current_session",
          currentView: {
            ...current,
            rebindStatus: "failed",
          },
        }
      }

      const rebound = recordSelectedStageArtifactTelemetry({
        rebindAttempted: true,
        rebindSource: input.source,
        rebindReason: input.reason,
        requestedArtifactId: input.requestedArtifactId ?? null,
      })
      const nextCurrent = {
        ...(coreviewCurrentViewRef.current ?? coreviewCurrentView),
        rebindStatus: rebound ? "success" : "failed",
      } satisfies CoreviewCurrentView

      return {
        ok: rebound,
        status: rebound ? "success" : "failed",
        reason: rebound ? input.reason : "artifact_rebind_failed",
        currentView: nextCurrent,
      }
    },
  }), [
    builderArtifactCoReview,
    builderArtifactId,
    builderStageActive,
    coreviewCurrentView,
    isVisible,
    recordSelectedStageArtifactTelemetry,
    waitForCoreviewViewReady,
  ])

  const coreviewActionBus = useMemo<CoreviewActionBus>(() => (
    createCoreviewActionBus(coreviewAdapter)
  ), [coreviewAdapter])

  const runCoreviewAction = useCallback(async (
    runner: (bus: CoreviewActionBus) => Promise<CoreviewActionResult> | CoreviewActionResult,
    options?: {
      applyStatus?: boolean
      emitFeedback?: boolean
      voiceTriggered?: boolean
      commandKind?: ArtifactReviewVoiceCommand["kind"] | null
      dedupePrefix?: string | null
    },
  ): Promise<CoreviewActionResult> => {
    pendingWorkspaceViewActorRef.current = sophiaWorkspaceActor
    const result = await runner(coreviewActionBus)
    if (result.ok && result.action === "focus_anchor" && result.focus_anchor_type) {
      lastCoreviewFocusedAnchorTypeRef.current = result.focus_anchor_type
    } else if (result.ok && result.action === "add_annotation" && result.annotation_anchor_type) {
      lastCoreviewFocusedAnchorTypeRef.current = result.annotation_anchor_type
    }
    if (options?.applyStatus !== false) {
      applyCoreviewActionStatus(result)
    }
    recordCoreviewToolTelemetry(result)
    if (options?.emitFeedback !== false) {
      emitCoreviewToolFeedback(result, {
        voiceTriggered: options?.voiceTriggered,
        commandKind: options?.commandKind,
        dedupePrefix: options?.dedupePrefix,
      })
    }
    if (pendingWorkspaceViewActorRef.current === sophiaWorkspaceActor) {
      pendingWorkspaceViewActorRef.current = null
    }
    return result
  }, [applyCoreviewActionStatus, coreviewActionBus, emitCoreviewToolFeedback, recordCoreviewToolTelemetry, sophiaWorkspaceActor])

  const activeCoreviewBuilderTask = useMemo(
    () => coreviewBuilderStatusFromTask(builderTask),
    [builderTask],
  )
  const latestCoreviewBuilderOutput = useMemo(
    () => coreviewOutputFromCompletion(builderCompletion),
    [builderCompletion],
  )
  const coreviewArtifactVersionTelemetry = useMemo(
    () => getVersionTelemetry(coreviewArtifactVersionState),
    [coreviewArtifactVersionState],
  )
  const coreviewHtmlLiveUpdateEnabled = Boolean(
    stageRendererKind === "html"
      && stageArtifactCapabilities.supportsArtifactUpdate
      && stageArtifactCapabilities.supportsVersioning
      && stageArtifactCapabilities.supportsSourceRead,
  )

  const recordCoreviewBuilderTelemetry = useCallback((result: CoreviewBuilderActionResult) => {
    const telemetry = getCoreviewWorkspaceEventLogTelemetry(
      coreviewWorkspaceKey,
      coreviewArtifactKey,
      coreviewShareState,
    )
    const isUpdate = result.action === "coreview_request_artifact_update"
    const isCancel = result.action === "coreview_cancel_builder_task"
    const isStatus = result.action === "coreview_get_builder_status"
    const activeTaskState = result.status?.phase
      ?? (result.result === "task_started" ? "running" : result.result === "update_requested" ? "starting" : null)
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-builder-action",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewBuilderActionsEnabled: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderActionsBlockedReason: coreviewBuilderActionAvailability.enabled
          ? null
          : coreviewBuilderActionAvailability.blockedReason,
        coreviewBuilderToolsExposed: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderGenericToolsSuppressed: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderActiveTaskState: activeTaskState,
        coreviewBuilderUpdateIntentDetected: isUpdate,
        coreviewBuilderUpdateAttempted: isUpdate,
        coreviewBuilderUpdateResult: isUpdate ? result.result : null,
        coreviewBuilderUpdateBlockedReason: isUpdate ? result.blockedReason ?? null : null,
        coreviewBuilderUpdateMode: result.updateMode ?? null,
        coreviewBuilderUpdateArtifactContextPresent: Boolean(result.context),
        coreviewBuilderTaskStarted: result.result === "task_started" || Boolean(result.taskId || result.runId),
        coreviewBuilderTaskIdPresent: Boolean(result.taskId),
        coreviewBuilderCancelIntentDetected: isCancel,
        coreviewBuilderCancelAttempted: isCancel && result.result !== "no_active_builder_task",
        coreviewBuilderCancelResult: isCancel ? result.result : null,
        coreviewBuilderCancelBlockedReason: isCancel ? result.blockedReason ?? null : null,
        coreviewBuilderStatusResult: isStatus ? result.status?.phase ?? "idle" : null,
        coreviewBuilderStatusToolResult: isStatus ? result.result : null,
        coreviewBuilderPreservedMic: result.preservedMic,
        coreviewBuilderPreservedReview: result.preservedReview,
        coreviewHtmlLiveUpdateEnabled,
        coreviewArtifactVersioningEnabled: coreviewArtifactVersionTelemetry.coreviewArtifactVersioningEnabled
          || stageArtifactCapabilities.supportsVersioning,
        editBuilderArtifactInterceptedByCoreview: result.editBuilderArtifactInterceptedByCoreview === true,
        editBuilderArtifactDirectCallResult: result.editBuilderArtifactDirectCallResult ?? null,
        coreviewUpdateStateCreatedFromDirectEditTool: result.coreviewUpdateStateCreatedFromDirectEditTool === true,
        coreviewUpdateCardVisible: isUpdate || isCancel,
        coreviewArtifactLogicalId: coreviewArtifactVersionTelemetry.coreviewArtifactLogicalId
          ?? result.context?.artifactStableIdentity
          ?? artifactStableIdentity,
        coreviewArtifactOriginalVersionIdPresent: coreviewArtifactVersionTelemetry.coreviewArtifactOriginalVersionIdPresent,
        coreviewArtifactCurrentVersionIdPresent: coreviewArtifactVersionTelemetry.coreviewArtifactCurrentVersionIdPresent,
        coreviewArtifactVersionCount: coreviewArtifactVersionTelemetry.coreviewArtifactVersionCount,
        coreviewHtmlUpdatePreviousPathHash: coreviewArtifactVersionTelemetry.coreviewHtmlUpdatePreviousPathHash,
        coreviewHtmlUpdateCurrentPathHash: coreviewArtifactVersionTelemetry.coreviewHtmlUpdateCurrentPathHash,
        coreviewHtmlUpdateRestoreAvailable: coreviewArtifactVersionTelemetry.coreviewHtmlUpdateRestoreAvailable,
        coreviewHtmlQuickPatchEligible: result.htmlQuickPatch?.eligible ?? false,
        coreviewHtmlQuickPatchAttempted: result.htmlQuickPatch?.attempted ?? false,
        coreviewHtmlQuickPatchResult: result.htmlQuickPatch?.result ?? null,
        coreviewHtmlQuickPatchKind: result.htmlQuickPatch?.kind ?? null,
        coreviewHtmlQuickPatchFallbackReason: result.htmlQuickPatch?.fallbackReason ?? null,
        coreviewHtmlQuickPatchLatencyMs: result.htmlQuickPatch?.latencyMs ?? null,
        coreviewHtmlQuickPatchRevisionPathHash: result.htmlQuickPatch?.revisionPathHash ?? null,
        coreviewHtmlQuickPatchUsedFullBuilder: result.htmlQuickPatch?.usedFullBuilder ?? null,
        coreviewHtmlQuickPatchRenderConfirmed: result.htmlQuickPatch?.renderConfirmed ?? null,
        coreviewHtmlQuickPatchPreservedOriginal: result.htmlQuickPatch?.preservedOriginal ?? null,
        coreviewHtmlQuickPatchRestoreAvailable: result.htmlQuickPatch?.restoreAvailable ?? null,
        coreviewHtmlQuickPatchTypeErrorPrevented: result.htmlQuickPatch?.typeErrorPrevented ?? null,
        builderWorkspaceEventCount: telemetry.builderWorkspaceEventCount,
        builderLastWorkspaceEventType: telemetry.builderLastWorkspaceEventType,
        artifactStableIdentity: result.context?.artifactStableIdentity ?? artifactStableIdentity,
        artifactRendererKind: result.rendererKind ?? stageRendererKind,
        artifactCapabilitySupportsArtifactUpdate: result.context?.capabilitySummary.supportsArtifactUpdate ?? null,
        artifactCapabilityUnsupportedUpdateReason: result.context?.capabilitySummary.unsupportedUpdateReason ?? null,
        rawTranscriptExcluded: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    artifactStableIdentity,
    coreviewBuilderActionAvailability.blockedReason,
    coreviewBuilderActionAvailability.enabled,
    coreviewArtifactVersionTelemetry,
    coreviewHtmlLiveUpdateEnabled,
    coreviewArtifactKey,
    coreviewShareState,
    coreviewWorkspaceKey,
    normalSessionId,
    sessionId,
    stageArtifactCapabilities.supportsVersioning,
    stageRendererKind,
    threadId,
  ])

  const emitCoreviewBuilderFeedback = useCallback((
    result: CoreviewBuilderActionResult,
    options?: {
      voiceTriggered?: boolean
      dedupePrefix?: string | null
    },
  ) => {
    onCoreviewActionFeedback?.(coreviewFeedbackFromBuilderActionResult(result, {
      voiceMode: isVoiceMode,
      voiceTriggered: options?.voiceTriggered ?? isVoiceMode,
      dedupePrefix: options?.dedupePrefix ?? null,
    }))
  }, [isVoiceMode, onCoreviewActionFeedback])

  useEffect(() => {
    if (!isVisible || !builderStageActive) {
      return
    }

    const telemetry = getCoreviewWorkspaceEventLogTelemetry(
      coreviewWorkspaceKey,
      coreviewArtifactKey,
      coreviewShareState,
    )
    const signature = JSON.stringify({
      artifactStableIdentity,
      enabled: coreviewBuilderActionAvailability.enabled,
      blockedReason: coreviewBuilderActionAvailability.blockedReason,
      path: stageArtifactPath,
      renderer: stageRendererKind,
      supportsArtifactUpdate: coreviewBuilderActionAvailability.supportsArtifactUpdate,
      supportsVersionedRebuild: coreviewBuilderActionAvailability.supportsVersionedRebuild,
      unsupportedUpdateReason: coreviewBuilderActionAvailability.unsupportedUpdateReason,
      updateCallback: Boolean(onCoreviewBuilderUpdateRequest),
      cancelCallback: Boolean(onCoreviewBuilderCancelRequest),
      activeTaskState: activeCoreviewBuilderTask?.phase ?? null,
    })
    if (signature === lastCoreviewBuilderAvailabilitySignatureRef.current) {
      return
    }
    lastCoreviewBuilderAvailabilitySignatureRef.current = signature

    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-builder-action",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewBuilderActionsAvailabilityReported: true,
        coreviewBuilderActionsEnabled: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderActionsBlockedReason: coreviewBuilderActionAvailability.blockedReason,
        coreviewBuilderToolsExposed: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderGenericToolsSuppressed: coreviewBuilderActionAvailability.enabled,
        coreviewBuilderActiveTaskState: activeCoreviewBuilderTask?.phase ?? null,
        coreviewBuilderActionsSupportsArtifactUpdate: coreviewBuilderActionAvailability.supportsArtifactUpdate,
        coreviewBuilderActionsSupportsVersionedRebuild: coreviewBuilderActionAvailability.supportsVersionedRebuild,
        coreviewBuilderUpdateIntentDetected: false,
        coreviewBuilderUpdateAttempted: false,
        coreviewBuilderUpdateResult: null,
        coreviewBuilderUpdateBlockedReason: coreviewBuilderActionAvailability.enabled
          ? null
          : coreviewBuilderActionAvailability.blockedReason,
        coreviewBuilderUpdateMode: coreviewBuilderCapabilitySummary.preferredUpdateMode,
        coreviewBuilderUpdateArtifactContextPresent: Boolean(stageArtifactPath),
        coreviewBuilderTaskStarted: false,
        coreviewBuilderTaskIdPresent: false,
        coreviewBuilderCancelIntentDetected: false,
        coreviewBuilderCancelAttempted: false,
        coreviewBuilderCancelResult: null,
        coreviewBuilderCancelBlockedReason: coreviewBuilderActionAvailability.enabled
          ? null
          : coreviewBuilderActionAvailability.blockedReason,
        coreviewBuilderStatusResult: null,
        coreviewBuilderStatusToolResult: null,
        coreviewBuilderPreservedMic: true,
        coreviewBuilderPreservedReview: true,
        coreviewHtmlLiveUpdateEnabled,
        coreviewArtifactVersioningEnabled: coreviewArtifactVersionTelemetry.coreviewArtifactVersioningEnabled
          || stageArtifactCapabilities.supportsVersioning,
        coreviewArtifactLogicalId: coreviewArtifactVersionTelemetry.coreviewArtifactLogicalId
          ?? artifactStableIdentity,
        coreviewArtifactOriginalVersionIdPresent: coreviewArtifactVersionTelemetry.coreviewArtifactOriginalVersionIdPresent,
        coreviewArtifactCurrentVersionIdPresent: coreviewArtifactVersionTelemetry.coreviewArtifactCurrentVersionIdPresent,
        coreviewArtifactVersionCount: coreviewArtifactVersionTelemetry.coreviewArtifactVersionCount,
        coreviewHtmlUpdatePreviousPathHash: coreviewArtifactVersionTelemetry.coreviewHtmlUpdatePreviousPathHash,
        coreviewHtmlUpdateCurrentPathHash: coreviewArtifactVersionTelemetry.coreviewHtmlUpdateCurrentPathHash,
        coreviewHtmlUpdateRestoreAvailable: coreviewArtifactVersionTelemetry.coreviewHtmlUpdateRestoreAvailable,
        builderWorkspaceEventCount: telemetry.builderWorkspaceEventCount,
        builderLastWorkspaceEventType: telemetry.builderLastWorkspaceEventType,
        artifactStableIdentity,
        artifactRendererKind: stageRendererKind,
        ...stageArtifactCapabilityTelemetry,
        artifactCapabilitySupportsArtifactUpdate: coreviewBuilderActionAvailability.supportsArtifactUpdate,
        artifactCapabilityUnsupportedUpdateReason: coreviewBuilderActionAvailability.unsupportedUpdateReason,
        rawTranscriptExcluded: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    activeCoreviewBuilderTask?.phase,
    artifactStableIdentity,
    builderStageActive,
    coreviewArtifactKey,
    coreviewBuilderActionAvailability,
    coreviewBuilderCapabilitySummary.preferredUpdateMode,
    coreviewArtifactVersionTelemetry,
    coreviewHtmlLiveUpdateEnabled,
    coreviewShareState,
    coreviewWorkspaceKey,
    isVisible,
    normalSessionId,
    onCoreviewBuilderCancelRequest,
    onCoreviewBuilderUpdateRequest,
    sessionId,
    stageArtifactCapabilityTelemetry,
    stageArtifactCapabilities.supportsVersioning,
    stageArtifactPath,
    stageRendererKind,
    threadId,
  ])

  const applyCoreviewBuilderResult = useCallback((result: CoreviewBuilderActionResult) => {
    if (result.context) {
      latestCoreviewBuilderContextRef.current = result.context
    }

    if (result.result === "quick_patch_applied" && result.context && result.latestOutput?.artifactPath) {
      const context = result.context
      const outputPath = normalizeBuilderArtifactPath(result.latestOutput.artifactPath)
      if (!outputPath || context.rendererKind !== "html") {
        setCoreviewBuilderUpdateCard((current) => current
          ? {
              ...current,
              status: "failed",
              currentStep: null,
              unsupportedReason: "Couldn’t apply the quick update. Original preserved.",
              autoApplied: false,
              restoreAvailable: false,
            }
          : current)
        onCoreviewActionFeedback?.(createCoreviewActionFeedback({
          actionKind: "quick_patch",
          status: "failed",
          displayMessage: "Quick edit could not be applied.",
          spokenMessage: "I couldn't safely apply that quick edit.",
          shouldSpeak: isVoiceMode,
          dedupeKey: `quick-patch-invalid-output:${result.htmlQuickPatch?.revisionPathHash ?? result.latestOutput?.artifactPath ?? "unknown"}`,
        }))
        recordCoreviewBuilderTelemetry(result)
        return
      }

      const output = {
        artifactPath: outputPath,
        artifactTitle: result.latestOutput.artifactTitle ?? outputPath.split("/").filter(Boolean).pop() ?? null,
      }
      const outputStableIdentity = buildCoreviewArtifactStableIdentity({
        userId: userId ?? null,
        threadId: threadId ?? context.threadId ?? null,
        artifactPath: outputPath,
        rendererKind: "html",
      }).key
      const nextVersionState = createVersionFromBuilderOutput({
        workspaceKey: context.workspaceKey,
        logicalArtifactId: context.artifactStableIdentity ?? artifactStableIdentity,
        original: {
          artifactStableIdentity: context.artifactStableIdentity,
          artifactPath: context.artifactPath,
          artifactTitle: context.artifactTitle,
          rendererKind: context.rendererKind,
        },
        output: {
          artifactStableIdentity: outputStableIdentity,
          artifactPath: outputPath,
          artifactTitle: output.artifactTitle,
          rendererKind: "html",
        },
        builderTaskId: null,
        requestedChangeSummary: context.requestedChangeSummary,
      })
      const versionTelemetry = getVersionTelemetry(nextVersionState)
      if (!nextVersionState) {
        setCoreviewBuilderUpdateCard({
          artifactTitle: context.artifactTitle ?? output.artifactTitle ?? "Selected artifact",
          requestedChangeSummary: context.requestedChangeSummary,
          status: "failed",
          currentStep: null,
          outputTitle: output.artifactTitle,
          outputPath,
          unsupportedReason: "Couldn’t save the quick update. Original preserved.",
          autoApplied: false,
          nonHtmlOutput: false,
          versionLabel: null,
          restoreAvailable: false,
        })
        setVoiceCommandStatus({
          text: "The quick update could not be saved. Original preserved.",
          tone: "warn",
        })
        onCoreviewActionFeedback?.(createCoreviewActionFeedback({
          actionKind: "quick_patch",
          status: "failed",
          displayMessage: "Quick edit could not be saved.",
          spokenMessage: "I couldn't safely save that quick edit.",
          shouldSpeak: isVoiceMode,
          dedupeKey: `quick-patch-version-state:${result.htmlQuickPatch?.revisionPathHash ?? outputPath}`,
        }))
        recordCoreviewBuilderTelemetry(result)
        return
      }

      const actor = context.sourceActor === "sophia" ? sophiaWorkspaceActor : userWorkspaceActor
      const versionEventPayload = {
        workspaceKey: context.workspaceKey,
        artifactKey: coreviewArtifactKey,
        artifactStableIdentity: context.artifactStableIdentity,
        artifactPath: context.artifactPath,
        artifactTitle: context.artifactTitle,
        rendererKind: context.rendererKind,
        builderTaskId: null,
        builderRunId: null,
        updateMode: context.updateMode,
        requestedChangeSummary: context.requestedChangeSummary,
        sourceActor: context.sourceActor,
        sessionId: context.sessionId,
        threadId: context.threadId,
        parentThreadId: context.parentThreadId ?? null,
        outputArtifactPath: outputPath,
        outputArtifactTitle: output.artifactTitle,
        quickPatchApplied: true,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      }
      recordCoreviewWorkspaceEvent({
        type: "artifact.version_created",
        actor,
        artifactKey: coreviewArtifactKey,
        artifactStableIdentity: context.artifactStableIdentity,
        threadId: context.threadId,
        payload: {
          ...versionEventPayload,
          result: "quick_patch_new_version",
        },
      })
      recordCoreviewWorkspaceEvent({
        type: "artifact.version_selected",
        actor,
        artifactKey: coreviewArtifactKey,
        artifactStableIdentity: context.artifactStableIdentity,
        threadId: context.threadId,
        payload: {
          ...versionEventPayload,
          result: "quick_patch_auto_selected",
        },
      })

      setCoreviewArtifactVersionState(nextVersionState)
      setRestoreOriginalPending(false)
      onSelectedBuilderArtifactPathChange?.(outputPath)
      setCoreviewBuilderUpdateCard({
        artifactTitle: context.artifactTitle ?? output.artifactTitle ?? "Selected artifact",
        requestedChangeSummary: context.requestedChangeSummary,
        status: "applying",
        currentStep: "Applying update...",
        outputTitle: output.artifactTitle,
        outputPath,
        unsupportedReason: null,
        autoApplied: false,
        nonHtmlOutput: false,
        versionLabel: null,
        restoreAvailable: false,
      })
      setPendingCoreviewHtmlAutoApply({
        signature: coreviewBuilderCompletionSignature({
          workspaceKey: context.workspaceKey,
          artifactStableIdentity: context.artifactStableIdentity,
          taskId: null,
          runId: null,
          outputPath,
        }),
        context,
        output,
        outputPath,
        originalPath: normalizeBuilderArtifactPath(context.artifactPath),
        taskId: null,
        runId: null,
        matchedBy: "quick_patch",
        versionState: nextVersionState,
        versionTelemetry,
        quickPatchTelemetry: result.htmlQuickPatch ?? null,
        attemptedAt: Date.now(),
        timedOut: false,
      })
      recordCoreviewBuilderTelemetry(result)
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "coreview-builder-action",
        payload: {
          sessionId: sessionId ?? null,
          normalSessionId: normalSessionId ?? null,
          threadId: threadId ?? null,
          coreviewHtmlLiveUpdateEnabled,
          coreviewArtifactVersioningEnabled: true,
          coreviewHtmlUpdateMatchedBy: "quick_patch",
          coreviewHtmlUpdateAutoApplyAttempted: true,
          coreviewHtmlUpdateAutoApplied: false,
          coreviewHtmlUpdateAutoApplyResult: "pending_render_confirmation",
          coreviewHtmlUpdateRenderConfirmed: false,
          coreviewHtmlUpdatePreviewRefreshFailed: false,
          coreviewHtmlUpdatePreviousPathHash: versionTelemetry.coreviewHtmlUpdatePreviousPathHash,
          coreviewHtmlUpdateCurrentPathHash: versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
          coreviewHtmlUpdateRestoreAvailable: versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
          coreviewHtmlUpdateNoViewClickRequired: false,
          coreviewHtmlUpdateSelectedPathChanged: normalizeBuilderArtifactPath(normalizedSelectedBuilderArtifactPath) === outputPath,
          coreviewHtmlUpdateSuccessClaimBlockedUntilRender: true,
          coreviewHtmlUpdateSuppressedCompletedBuilderSurface: true,
          coreviewHtmlQuickPatchEligible: result.htmlQuickPatch?.eligible ?? true,
          coreviewHtmlQuickPatchAttempted: result.htmlQuickPatch?.attempted ?? true,
          coreviewHtmlQuickPatchResult: result.htmlQuickPatch?.result ?? "patched",
          coreviewHtmlQuickPatchKind: result.htmlQuickPatch?.kind ?? null,
          coreviewHtmlQuickPatchFallbackReason: result.htmlQuickPatch?.fallbackReason ?? null,
          coreviewHtmlQuickPatchLatencyMs: result.htmlQuickPatch?.latencyMs ?? null,
          coreviewHtmlQuickPatchRevisionPathHash: result.htmlQuickPatch?.revisionPathHash ?? versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
          coreviewHtmlQuickPatchUsedFullBuilder: false,
          coreviewHtmlQuickPatchRenderConfirmed: false,
          coreviewHtmlQuickPatchPreservedOriginal: result.htmlQuickPatch?.preservedOriginal ?? true,
          coreviewHtmlQuickPatchRestoreAvailable: versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
          coreviewHtmlQuickPatchTypeErrorPrevented: false,
          coreviewHtmlUpdatePreservedReview: true,
          coreviewHtmlUpdatePreservedMic: true,
          rawArtifactTextExcluded: true,
          rawCommentTextExcluded: true,
          rawFrameExcluded: true,
        },
      })
      return
    }

    const artifactTitle = result.context?.artifactTitle ?? stageBuilderArtifact?.artifactTitle ?? "Selected artifact"
    const requestedChangeSummary = result.requestedChangeSummary
      ?? result.context?.requestedChangeSummary
      ?? "Update selected artifact"
    const output = result.latestOutput ?? latestCoreviewBuilderOutput
    const statusFromTask = builderCardStatusFromTask(builderTask, builderCompletion)
    const status: ArtifactReviewBuilderUpdateCardStatus = result.result === "unsupported"
      ? "unsupported"
      : result.action === "coreview_cancel_builder_task" && result.result === "cancelled"
        ? "cancelled"
        : result.action === "coreview_cancel_builder_task" && result.result === "failed"
          ? "failed"
          : statusFromTask ?? (result.ok ? "starting" : "failed")

    setCoreviewBuilderUpdateCard({
      artifactTitle,
      requestedChangeSummary,
      status,
      currentStep: result.status?.currentStep ?? activeCoreviewBuilderTask?.currentStep ?? null,
      outputTitle: output?.artifactTitle ?? null,
      outputPath: output?.artifactPath ?? null,
      unsupportedReason: result.result === "unsupported" ? result.userFacingMessage ?? null : null,
      autoApplied: false,
      nonHtmlOutput: false,
      versionLabel: null,
      restoreAvailable: false,
    })
    setVoiceCommandStatus({
      text: result.userFacingMessage
        ?? (result.ok ? "Sophia is updating this artifact." : "Sophia could not update this artifact."),
      tone: result.ok ? "success" : "warn",
    })
    recordCoreviewBuilderTelemetry(result)
    emitCoreviewBuilderFeedback(result, {
      voiceTriggered: isVoiceMode,
      dedupePrefix: "builder-result",
    })
  }, [
    activeCoreviewBuilderTask?.currentStep,
    artifactStableIdentity,
    builderCompletion,
    builderTask,
    coreviewArtifactKey,
    coreviewHtmlLiveUpdateEnabled,
    isVoiceMode,
    latestCoreviewBuilderOutput,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    onSelectedBuilderArtifactPathChange,
    onCoreviewActionFeedback,
    recordCoreviewBuilderTelemetry,
    emitCoreviewBuilderFeedback,
    recordCoreviewWorkspaceEvent,
    sessionId,
    sophiaWorkspaceActor,
    stageBuilderArtifact?.artifactTitle,
    threadId,
    userId,
    userWorkspaceActor,
  ])

  const emitCoreviewBuilderWorkspaceEvent = useCallback((input: CoreviewBuilderWorkspaceEventInput) => {
    recordCoreviewWorkspaceEvent({
      type: input.type,
      actor: input.context.sourceActor === "sophia" ? sophiaWorkspaceActor : userWorkspaceActor,
      artifactKey: coreviewArtifactKey,
      builderTaskId: input.taskId,
      builderRunId: input.runId,
      artifactStableIdentity: input.context.artifactStableIdentity,
      threadId: input.context.threadId,
      payload: {
        workspaceKey: input.context.workspaceKey,
        artifactKey: coreviewArtifactKey,
        artifactStableIdentity: input.context.artifactStableIdentity,
        artifactPath: input.context.artifactPath,
        artifactTitle: input.context.artifactTitle,
        rendererKind: input.context.rendererKind,
        builderTaskId: input.taskId ?? null,
        builderRunId: input.runId ?? null,
        updateMode: input.context.updateMode,
        requestedChangeSummary: input.context.requestedChangeSummary,
        sourceActor: input.context.sourceActor,
        sessionId: input.context.sessionId,
        threadId: input.context.threadId,
        parentThreadId: input.context.parentThreadId ?? null,
        result: input.result ?? null,
        outputArtifactPath: input.output?.artifactPath ?? null,
        outputArtifactTitle: input.output?.artifactTitle ?? null,
        rawCommentTextExcluded: true,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    coreviewArtifactKey,
    recordCoreviewWorkspaceEvent,
    sophiaWorkspaceActor,
    userWorkspaceActor,
  ])

  const coreviewBuilderActionBus = useMemo<CoreviewBuilderActionBus>(() => (
    createCoreviewBuilderActionBus({
      getCurrentView: () => coreviewCurrentViewRef.current ?? coreviewCurrentView,
      getWorkspaceKey: () => coreviewWorkspaceKey,
      getSessionIds: () => ({
        sessionId: normalSessionId ?? sessionId ?? null,
        threadId: threadId ?? null,
        parentThreadId: threadId ?? null,
      }),
      getOriginalArtifactHref: () => (
        stageArtifactPath && threadId
          ? `/api/threads/${encodeURIComponent(threadId)}/artifacts/${stageArtifactPath}`
          : null
      ),
      getSelectedAnnotationIds: () => coreviewAnnotationList.map((annotation) => annotation.id),
      getActiveBuilderTask: () => coreviewBuilderStatusFromTask(builderTask),
      getLatestOutput: () => coreviewOutputFromCompletion(builderCompletion),
      emitWorkspaceEvent: emitCoreviewBuilderWorkspaceEvent,
      startBuilderTask: async ({ context, prompt }) => {
        if (!onCoreviewBuilderUpdateRequest) {
          return {
            ok: false,
            blockedReason: "builder_action_unavailable",
            userFacingMessage: "Artifact updates are unavailable in this session.",
          }
        }
        return onCoreviewBuilderUpdateRequest({
          context,
          prompt,
          updateMode: context.updateMode,
        })
      },
      quickPatchHtmlArtifact: async ({ context, classification }) => {
        const patchThreadId = context.threadId ?? threadId ?? null
        if (!patchThreadId || !context.artifactPath || context.rendererKind !== "html" || !classification.quickEditKind) {
          return {
            ok: false,
            result: "failed",
            fallback_reason: "quick_patch_context_unavailable",
            raw_html_excluded: true,
            raw_artifact_text_excluded: true,
          }
        }
        return requestCoreviewHtmlQuickPatch(patchThreadId, {
          artifact_path: context.artifactPath,
          artifact_stable_identity: context.artifactStableIdentity,
          renderer_kind: "html",
          user_update_request: context.userUpdateRequest,
          requested_change_summary: classification.requestedChangeSummary,
          quick_edit_kind: classification.quickEditKind,
          target_fields: classification.targetFields,
          workspace_key: context.workspaceKey,
          session_id: context.sessionId,
          thread_id: context.threadId,
        })
      },
      cancelBuilderTask: async ({ context, task }) => {
        if (!onCoreviewBuilderCancelRequest) {
          return {
            ok: false,
            taskId: task.taskId,
            runId: task.runId,
            blockedReason: "builder_cancel_unavailable",
            userFacingMessage: "Builder cancellation is unavailable in this session.",
          }
        }
        return onCoreviewBuilderCancelRequest({ context, task })
      },
    })
  ), [
    builderCompletion,
    builderTask,
    coreviewAnnotationList,
    coreviewCurrentView,
    coreviewWorkspaceKey,
    emitCoreviewBuilderWorkspaceEvent,
    normalSessionId,
    onCoreviewBuilderCancelRequest,
    onCoreviewBuilderUpdateRequest,
    sessionId,
    stageArtifactPath,
    threadId,
  ])

  useEffect(() => {
    if (versionStateAppliesToStage) {
      return
    }
    latestCoreviewBuilderContextRef.current = null
    emittedCoreviewBuilderEventSignaturesRef.current.clear()
    autoAppliedCoreviewBuilderSignaturesRef.current.clear()
    setCoreviewArtifactVersionState(null)
    setPendingCoreviewHtmlAutoApply(null)
    setCoreviewBuilderUpdateCard(null)
  }, [artifactStableIdentity, stageArtifactPath, stageRendererKind, versionStateAppliesToStage])

  useEffect(() => {
    const storedContext = latestCoreviewBuilderContextRef.current
    const fallbackContext = !storedContext && builderCompletion?.status === "success"
      ? coreviewBuilderActionBus.buildUpdateContext({
          userUpdateRequest: builderCompletion.summary ?? "Update selected artifact.",
          sourceActor: "system",
        })
      : null
    const context = storedContext ?? fallbackContext
    if (!context) {
      return
    }
    const task = coreviewBuilderStatusFromTask(builderTask)
    const output = coreviewOutputFromCompletion(builderCompletion)
    const status = builderCardStatusFromTask(builderTask, builderCompletion)
    const eventTaskId = task?.taskId ?? builderCompletion?.task_id ?? null
    const eventRunId = task?.runId ?? builderCompletion?.run_id ?? null
    const trackedTaskState = reconcileCoreviewBuilderTaskStateForContext(context, task)
    if (status) {
      const outputPath = normalizeBuilderArtifactPath(output?.artifactPath)
      const nextStatus = status === "completed" && context.rendererKind === "html" && outputPath
        ? "applying"
        : status
      setCoreviewBuilderUpdateCard((current) => current
        ? (() => {
            const preserveTerminalStatus = current.autoApplied
              || current.status === "preview_not_refreshed"
              || current.status === "failed"
            return {
            ...current,
            status: preserveTerminalStatus ? current.status : nextStatus,
            currentStep: preserveTerminalStatus ? current.currentStep : task?.currentStep ?? current.currentStep,
            outputTitle: output?.artifactTitle ?? current.outputTitle,
            outputPath: output?.artifactPath ?? current.outputPath,
            nonHtmlOutput: current.nonHtmlOutput,
            autoApplied: current.autoApplied,
            versionLabel: current.versionLabel,
            restoreAvailable: current.restoreAvailable,
          }
          })()
        : current)
    }

    if (!eventTaskId && !output?.artifactPath) {
      return
    }

    const emitOnce = (
      type: CoreviewWorkspaceEventType,
      result?: string | null,
      eventOutput?: CoreviewBuilderOutputStatus | null,
    ) => {
      const signature = coreviewBuilderEventSignature(type, eventTaskId, eventRunId)
      if (emittedCoreviewBuilderEventSignaturesRef.current.has(signature)) {
        return
      }
      emittedCoreviewBuilderEventSignaturesRef.current.add(signature)
      emitCoreviewBuilderWorkspaceEvent({
        type: type as CoreviewBuilderWorkspaceEventInput["type"],
        context,
        taskId: eventTaskId,
        runId: eventRunId,
        result,
        output: eventOutput ?? null,
      })
    }

    if (task?.phase === "running") {
      emitOnce("builder.task_started")
      return
    }
    if (task?.phase === "completed" || builderCompletion?.status === "success") {
      emitOnce("builder.task_completed", "completed", output)
      const outputPath = normalizeBuilderArtifactPath(output?.artifactPath)
      const htmlOutput = isHtmlBuilderOutput(output)
      const matchedBy = matchCoreviewHtmlBuilderCompletion({
        context,
        completion: builderCompletion,
        output,
        selectedBuilderArtifactPath: normalizedSelectedBuilderArtifactPath,
        stageArtifactPath,
        artifactStableIdentity,
        trackedTask: trackedTaskState,
        allowContextIdentityMatch: Boolean(storedContext),
      })
      const shouldAutoApplyHtml = Boolean(
        matchedBy
          && context.rendererKind === "html"
          && outputPath
          && htmlOutput
          && onSelectedBuilderArtifactPathChange,
      )
      if (shouldAutoApplyHtml && outputPath) {
        const signature = coreviewBuilderCompletionSignature({
          workspaceKey: context.workspaceKey,
          artifactStableIdentity: context.artifactStableIdentity,
          taskId: eventTaskId,
          runId: eventRunId,
          outputPath,
        })
        if (!autoAppliedCoreviewBuilderSignaturesRef.current.has(signature)) {
          autoAppliedCoreviewBuilderSignaturesRef.current.add(signature)
          if (fallbackContext) {
            latestCoreviewBuilderContextRef.current = context
          }
          const outputStableIdentity = buildCoreviewArtifactStableIdentity({
            userId: userId ?? null,
            threadId: threadId ?? context.threadId ?? null,
            artifactPath: outputPath,
            rendererKind: "html",
          }).key
          const nextVersionState = createVersionFromBuilderOutput({
            workspaceKey: context.workspaceKey,
            logicalArtifactId: context.artifactStableIdentity ?? artifactStableIdentity,
            original: {
              artifactStableIdentity: context.artifactStableIdentity,
              artifactPath: context.artifactPath,
              artifactTitle: context.artifactTitle,
              rendererKind: context.rendererKind,
            },
            output: {
              artifactStableIdentity: outputStableIdentity,
              artifactPath: outputPath,
              artifactTitle: output?.artifactTitle ?? null,
              rendererKind: "html",
            },
            builderTaskId: eventTaskId,
            requestedChangeSummary: context.requestedChangeSummary,
          })
          const versionTelemetry = getVersionTelemetry(nextVersionState)
          if (nextVersionState) {
            setCoreviewArtifactVersionState(nextVersionState)
            setRestoreOriginalPending(false)
            onSelectedBuilderArtifactPathChange?.(outputPath)
            emitOnce("artifact.version_created", "new_version", output)
            emitOnce("artifact.version_selected", "auto_selected", output)
            setCoreviewBuilderUpdateCard((current) => ({
              artifactTitle: current?.artifactTitle ?? context.artifactTitle ?? output?.artifactTitle ?? "Selected artifact",
              requestedChangeSummary: current?.requestedChangeSummary ?? context.requestedChangeSummary,
              status: "applying",
              currentStep: "Applying update...",
              outputTitle: output?.artifactTitle ?? current?.outputTitle ?? null,
              outputPath,
              unsupportedReason: null,
              autoApplied: false,
              nonHtmlOutput: false,
              versionLabel: null,
              restoreAvailable: false,
            }))
            setPendingCoreviewHtmlAutoApply({
              signature,
              context,
              output,
              outputPath,
              originalPath: normalizeBuilderArtifactPath(context.artifactPath),
              taskId: eventTaskId ?? null,
              runId: eventRunId ?? null,
              matchedBy: matchedBy ?? "active_coreview_task",
              versionState: nextVersionState,
              versionTelemetry,
              attemptedAt: Date.now(),
              timedOut: false,
            })
          } else {
            setCoreviewBuilderUpdateCard((current) => current
              ? {
                  ...current,
                  status: "failed",
                  currentStep: null,
                  unsupportedReason: "Couldn’t apply the update. Original preserved.",
                  autoApplied: false,
                  restoreAvailable: false,
                }
              : current)
          }
          recordSophiaCaptureEvent({
            category: "voice-session",
            name: "coreview-builder-action",
            payload: {
              sessionId: sessionId ?? null,
              normalSessionId: normalSessionId ?? null,
              threadId: threadId ?? null,
              coreviewHtmlLiveUpdateEnabled,
              coreviewArtifactVersioningEnabled: true,
              coreviewHtmlUpdateMatchedBy: matchedBy,
              coreviewHtmlUpdateAutoApplyAttempted: true,
              coreviewArtifactLogicalId: versionTelemetry.coreviewArtifactLogicalId
                ?? context.artifactStableIdentity
                ?? artifactStableIdentity,
              coreviewArtifactOriginalVersionIdPresent: versionTelemetry.coreviewArtifactOriginalVersionIdPresent,
              coreviewArtifactCurrentVersionIdPresent: versionTelemetry.coreviewArtifactCurrentVersionIdPresent,
              coreviewArtifactVersionCount: versionTelemetry.coreviewArtifactVersionCount,
              coreviewHtmlUpdateAutoApplied: false,
              coreviewHtmlUpdateAutoApplyResult: nextVersionState ? "pending_render_confirmation" : "version_state_unavailable",
              coreviewHtmlUpdateRenderConfirmed: false,
              coreviewHtmlUpdatePreviewRefreshFailed: false,
              coreviewHtmlUpdatePreviousPathHash: versionTelemetry.coreviewHtmlUpdatePreviousPathHash,
              coreviewHtmlUpdateCurrentPathHash: versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
              coreviewHtmlUpdateRestoreAvailable: versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
              coreviewHtmlUpdateNoViewClickRequired: false,
              coreviewHtmlUpdateSelectedPathChanged: normalizeBuilderArtifactPath(normalizedSelectedBuilderArtifactPath) === outputPath,
              coreviewHtmlUpdateSuccessClaimBlockedUntilRender: true,
              coreviewHtmlUpdatePreservedReview: true,
              coreviewHtmlUpdatePreservedMic: true,
              rawArtifactTextExcluded: true,
              rawCommentTextExcluded: true,
              rawFrameExcluded: true,
            },
          })
        }
      } else if (context.rendererKind === "html" && outputPath && htmlOutput) {
        setCoreviewBuilderUpdateCard((current) => current
          ? {
              ...current,
              status: "completed",
              currentStep: null,
              outputTitle: output?.artifactTitle ?? current.outputTitle,
              outputPath,
              unsupportedReason: null,
              autoApplied: false,
              nonHtmlOutput: false,
              versionLabel: null,
              restoreAvailable: false,
            }
          : current)
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "coreview-builder-action",
          payload: {
            sessionId: sessionId ?? null,
            normalSessionId: normalSessionId ?? null,
            threadId: threadId ?? null,
            coreviewHtmlLiveUpdateEnabled,
            coreviewArtifactVersioningEnabled: stageArtifactCapabilities.supportsVersioning,
            coreviewArtifactLogicalId: context.artifactStableIdentity ?? artifactStableIdentity,
            coreviewHtmlUpdateMatchedBy: matchedBy,
            coreviewHtmlUpdateAutoApplyAttempted: false,
            coreviewHtmlUpdateAutoApplied: false,
            coreviewHtmlUpdateAutoApplyResult: "not_current_artifact_revision",
            coreviewHtmlUpdateRenderConfirmed: false,
            coreviewHtmlUpdatePreviewRefreshFailed: false,
            coreviewHtmlUpdateNoViewClickRequired: false,
            coreviewHtmlUpdatePreservedReview: true,
            coreviewHtmlUpdatePreservedMic: true,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        })
      } else if (context.rendererKind === "html" && outputPath && !htmlOutput) {
        setCoreviewBuilderUpdateCard((current) => current
          ? {
              ...current,
              status: "completed",
              currentStep: null,
              outputTitle: output?.artifactTitle ?? current.outputTitle,
              outputPath,
              unsupportedReason: null,
              autoApplied: false,
              nonHtmlOutput: true,
              versionLabel: null,
              restoreAvailable: false,
            }
          : current)
        recordSophiaCaptureEvent({
          category: "voice-session",
          name: "coreview-builder-action",
          payload: {
            sessionId: sessionId ?? null,
            normalSessionId: normalSessionId ?? null,
            threadId: threadId ?? null,
            coreviewHtmlLiveUpdateEnabled,
            coreviewArtifactVersioningEnabled: stageArtifactCapabilities.supportsVersioning,
            coreviewArtifactLogicalId: context.artifactStableIdentity ?? artifactStableIdentity,
            coreviewHtmlUpdateAutoApplied: false,
            coreviewHtmlUpdateAutoApplyResult: "non_html_output",
            coreviewHtmlUpdateNoViewClickRequired: false,
            coreviewHtmlUpdatePreservedReview: true,
            coreviewHtmlUpdatePreservedMic: true,
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        })
      }
      return
    }
    if (task?.phase === "cancelled" || builderCompletion?.status === "cancelled") {
      emitOnce("builder.task_cancelled", "cancelled")
      return
    }
    if (task?.phase === "failed" || task?.phase === "timed_out" || builderCompletion?.status === "error" || builderCompletion?.status === "timeout") {
      emitOnce("builder.task_failed", task?.phase ?? builderCompletion?.status ?? "failed")
    }
  }, [
    artifactStableIdentity,
    builderCompletion,
    builderTask,
    coreviewBuilderActionBus,
    coreviewHtmlLiveUpdateEnabled,
    emitCoreviewBuilderWorkspaceEvent,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    onSelectedBuilderArtifactPathChange,
    sessionId,
    stageArtifactPath,
    stageArtifactCapabilities.supportsVersioning,
    threadId,
    userId,
  ])

  useEffect(() => {
    if (!pendingCoreviewHtmlAutoApply || pendingCoreviewHtmlAutoApply.timedOut) {
      return
    }
    const timeout = window.setTimeout(() => {
      setPendingCoreviewHtmlAutoApply((current) => (
        current?.signature === pendingCoreviewHtmlAutoApply.signature
          ? { ...current, timedOut: true }
          : current
      ))
    }, COREVIEW_HTML_AUTO_APPLY_RENDER_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [pendingCoreviewHtmlAutoApply])

  useEffect(() => {
    const pending = pendingCoreviewHtmlAutoApply
    if (!pending) {
      return
    }

    const selectedPathChanged = normalizeBuilderArtifactPath(normalizedSelectedBuilderArtifactPath) === pending.outputPath
    const renderedPath = normalizeBuilderArtifactPath(builderVisualCaptureStatus.artifactPath)
    const renderConfirmed = Boolean(
      selectedPathChanged
        && builderVisualCaptureStatus.ready
        && builderVisualCaptureStatus.source === "html_preview_canvas"
        && renderedPath === pending.outputPath,
    )
    const previewRefreshFailed = Boolean(
      selectedPathChanged
        && builderVisualCaptureStatus.source === "html_preview_canvas"
        && renderedPath === pending.outputPath
        && builderVisualCaptureStatus.ready === false
        && builderVisualCaptureStatus.reason !== "preview_not_ready",
    )

    if (!renderConfirmed && !previewRefreshFailed && !pending.timedOut) {
      return
    }

    if (renderConfirmed) {
      setCoreviewBuilderUpdateCard((current) => ({
        artifactTitle: current?.artifactTitle ?? pending.context.artifactTitle ?? pending.output.artifactTitle ?? "Selected artifact",
        requestedChangeSummary: current?.requestedChangeSummary ?? pending.context.requestedChangeSummary,
        status: "completed",
        currentStep: null,
        outputTitle: pending.output.artifactTitle ?? current?.outputTitle ?? null,
        outputPath: pending.outputPath,
        unsupportedReason: null,
        autoApplied: true,
        nonHtmlOutput: false,
        versionLabel: `Version ${pending.versionState.versions.length} saved`,
        restoreAvailable: pending.versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
      }))
      setVoiceCommandStatus({
        text: "Preview updated.",
        tone: "success",
      })
      onCoreviewActionFeedback?.(createCoreviewActionFeedback({
        actionKind: "quick_patch",
        status: "applied",
        displayMessage: "Preview updated.",
        spokenMessage: "Done - I updated it.",
        shouldSpeak: isVoiceMode,
        dedupeKey: `quick-patch-rendered:${pending.signature}`,
      }))
      recordSophiaCaptureEvent({
        category: "voice-session",
        name: "coreview-builder-action",
        payload: {
          sessionId: sessionId ?? null,
          normalSessionId: normalSessionId ?? null,
          threadId: threadId ?? null,
          coreviewHtmlLiveUpdateEnabled,
          coreviewArtifactVersioningEnabled: true,
          coreviewHtmlUpdateMatchedBy: pending.matchedBy,
          coreviewHtmlUpdateAutoApplyAttempted: true,
          coreviewHtmlUpdateAutoApplied: true,
          coreviewHtmlUpdateAutoApplyResult: "success",
          coreviewHtmlUpdateRenderConfirmed: true,
          coreviewHtmlUpdatePreviewRefreshFailed: false,
          coreviewHtmlUpdateNoViewClickRequired: true,
          coreviewHtmlUpdateRestoreAvailable: pending.versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
          coreviewHtmlUpdateSelectedPathChanged: selectedPathChanged,
          coreviewHtmlUpdateSuccessClaimBlockedUntilRender: false,
          coreviewHtmlUpdatePreviousPathHash: pending.versionTelemetry.coreviewHtmlUpdatePreviousPathHash,
          coreviewHtmlUpdateCurrentPathHash: pending.versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
          coreviewArtifactLogicalId: pending.versionTelemetry.coreviewArtifactLogicalId
            ?? pending.context.artifactStableIdentity
            ?? artifactStableIdentity,
          coreviewHtmlQuickPatchEligible: pending.quickPatchTelemetry?.eligible ?? false,
          coreviewHtmlQuickPatchAttempted: pending.quickPatchTelemetry?.attempted ?? false,
          coreviewHtmlQuickPatchResult: pending.quickPatchTelemetry
            ? "patched"
            : null,
          coreviewHtmlQuickPatchKind: pending.quickPatchTelemetry?.kind ?? null,
          coreviewHtmlQuickPatchFallbackReason: pending.quickPatchTelemetry?.fallbackReason ?? null,
          coreviewHtmlQuickPatchLatencyMs: pending.quickPatchTelemetry?.latencyMs ?? null,
          coreviewHtmlQuickPatchRevisionPathHash: pending.quickPatchTelemetry?.revisionPathHash
            ?? pending.versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
          coreviewHtmlQuickPatchUsedFullBuilder: pending.quickPatchTelemetry ? false : null,
          coreviewHtmlQuickPatchRenderConfirmed: pending.quickPatchTelemetry ? true : null,
          coreviewHtmlQuickPatchPreservedOriginal: pending.quickPatchTelemetry?.preservedOriginal ?? null,
          coreviewHtmlQuickPatchRestoreAvailable: pending.quickPatchTelemetry
            ? pending.versionTelemetry.coreviewHtmlUpdateRestoreAvailable
            : null,
          coreviewArtifactOriginalVersionIdPresent: pending.versionTelemetry.coreviewArtifactOriginalVersionIdPresent,
          coreviewArtifactCurrentVersionIdPresent: pending.versionTelemetry.coreviewArtifactCurrentVersionIdPresent,
          coreviewArtifactVersionCount: pending.versionTelemetry.coreviewArtifactVersionCount,
          coreviewHtmlUpdatePreservedReview: true,
          coreviewHtmlUpdatePreservedMic: true,
          rawArtifactTextExcluded: true,
          rawCommentTextExcluded: true,
          rawFrameExcluded: true,
        },
      })
      setPendingCoreviewHtmlAutoApply(null)
      return
    }

    const restoredState = restoreOriginalVersion({
      workspaceKey: pending.context.workspaceKey,
      logicalArtifactId: pending.versionState.logicalArtifactId,
    })
    const restoredVersion = getCurrentVersion(restoredState)
    const fallbackOriginalPath = restoredVersion?.artifactPath ?? pending.originalPath
    if (restoredState) {
      setCoreviewArtifactVersionState(restoredState)
    }
    if (fallbackOriginalPath) {
      onSelectedBuilderArtifactPathChange?.(fallbackOriginalPath)
    }
    setCoreviewBuilderUpdateCard((current) => ({
      artifactTitle: current?.artifactTitle ?? pending.context.artifactTitle ?? pending.output.artifactTitle ?? "Selected artifact",
      requestedChangeSummary: current?.requestedChangeSummary ?? pending.context.requestedChangeSummary,
      status: "preview_not_refreshed",
      currentStep: null,
      outputTitle: pending.output.artifactTitle ?? current?.outputTitle ?? null,
      outputPath: pending.outputPath,
      unsupportedReason: null,
      autoApplied: false,
      nonHtmlOutput: false,
      versionLabel: null,
      restoreAvailable: false,
    }))
    setVoiceCommandStatus({
      text: "The update was built, but I couldn’t refresh the preview yet.",
      tone: "warn",
    })
    onCoreviewActionFeedback?.(createCoreviewActionFeedback({
      actionKind: "quick_patch",
      status: "failed",
      displayMessage: "Preview could not refresh.",
      spokenMessage: "The update was built, but I couldn't refresh the preview yet.",
      shouldSpeak: isVoiceMode,
      dedupeKey: `quick-patch-preview-refresh:${pending.signature}`,
    }))
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-builder-action",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewHtmlLiveUpdateEnabled,
        coreviewArtifactVersioningEnabled: true,
        coreviewHtmlUpdateMatchedBy: pending.matchedBy,
        coreviewHtmlUpdateAutoApplyAttempted: true,
        coreviewHtmlUpdateAutoApplied: false,
        coreviewHtmlUpdateAutoApplyResult: "preview_not_refreshed",
        coreviewHtmlUpdateRenderConfirmed: false,
        coreviewHtmlUpdatePreviewRefreshFailed: true,
        coreviewHtmlUpdateNoViewClickRequired: false,
        coreviewHtmlUpdateRestoreAvailable: false,
        coreviewHtmlUpdateSelectedPathChanged: selectedPathChanged,
        coreviewHtmlUpdateSuccessClaimBlockedUntilRender: true,
        coreviewHtmlUpdatePreviousPathHash: pending.versionTelemetry.coreviewHtmlUpdatePreviousPathHash,
        coreviewHtmlUpdateCurrentPathHash: pending.versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
        coreviewArtifactLogicalId: pending.versionTelemetry.coreviewArtifactLogicalId
          ?? pending.context.artifactStableIdentity
          ?? artifactStableIdentity,
        coreviewHtmlQuickPatchEligible: pending.quickPatchTelemetry?.eligible ?? false,
        coreviewHtmlQuickPatchAttempted: pending.quickPatchTelemetry?.attempted ?? false,
        coreviewHtmlQuickPatchResult: pending.quickPatchTelemetry
          ? "preview_not_refreshed"
          : null,
        coreviewHtmlQuickPatchKind: pending.quickPatchTelemetry?.kind ?? null,
        coreviewHtmlQuickPatchFallbackReason: pending.quickPatchTelemetry?.fallbackReason ?? null,
        coreviewHtmlQuickPatchLatencyMs: pending.quickPatchTelemetry?.latencyMs ?? null,
        coreviewHtmlQuickPatchRevisionPathHash: pending.quickPatchTelemetry?.revisionPathHash
          ?? pending.versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
        coreviewHtmlQuickPatchUsedFullBuilder: pending.quickPatchTelemetry ? false : null,
        coreviewHtmlQuickPatchRenderConfirmed: pending.quickPatchTelemetry ? false : null,
        coreviewHtmlQuickPatchPreservedOriginal: pending.quickPatchTelemetry?.preservedOriginal ?? null,
        coreviewHtmlQuickPatchRestoreAvailable: pending.quickPatchTelemetry ? false : null,
        coreviewArtifactOriginalVersionIdPresent: pending.versionTelemetry.coreviewArtifactOriginalVersionIdPresent,
        coreviewArtifactCurrentVersionIdPresent: pending.versionTelemetry.coreviewArtifactCurrentVersionIdPresent,
        coreviewArtifactVersionCount: pending.versionTelemetry.coreviewArtifactVersionCount,
        coreviewHtmlUpdatePreservedReview: true,
        coreviewHtmlUpdatePreservedMic: true,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
    setPendingCoreviewHtmlAutoApply(null)
  }, [
    artifactStableIdentity,
    builderVisualCaptureStatus,
    coreviewHtmlLiveUpdateEnabled,
    isVoiceMode,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    onCoreviewActionFeedback,
    onSelectedBuilderArtifactPathChange,
    pendingCoreviewHtmlAutoApply,
    sessionId,
    threadId,
  ])

  useEffect(() => {
    if (!isVisible || !builderStageActive) {
      return
    }

    const unregisterCoreviewToolBridge = registerCoreviewToolBridge((call: CoreviewToolCallInput) => (
      runCoreviewAction((bus) => bus.handleToolCall(call))
    ))
    const unregisterCoreviewBuilderToolBridge = registerCoreviewBuilderToolBridge(async (call: CoreviewBuilderToolCallInput) => {
      const result = await coreviewBuilderActionBus.handleToolCall(call)
      if (call.name === "coreview_get_builder_status") {
        recordCoreviewBuilderTelemetry(result)
        emitCoreviewBuilderFeedback(result, {
          voiceTriggered: isVoiceMode,
          dedupePrefix: "builder-tool-status",
        })
      } else {
        applyCoreviewBuilderResult(result)
      }
      return result
    })

    return () => {
      unregisterCoreviewToolBridge()
      unregisterCoreviewBuilderToolBridge()
    }
  }, [
    applyCoreviewBuilderResult,
    builderStageActive,
    coreviewBuilderActionBus,
    emitCoreviewBuilderFeedback,
    isVisible,
    isVoiceMode,
    recordCoreviewBuilderTelemetry,
    runCoreviewAction,
  ])

  const routeArtifactReviewVoiceCommand = useCallback((transcript: string): ArtifactReviewVoiceCommandRouteResult => {
    if (!isVisible || !builderStageActive) {
      return { handled: false }
    }

    const commands = parseArtifactReviewVoiceCommands(transcript)
    const command = commands[0] ?? parseArtifactReviewVoiceCommand(transcript)
    if (!command) {
      return { handled: false }
    }

    const startedAtMs = Date.now()
    const annotationOrFocusCommands = commands.filter(isAnnotationOrFocusVoiceCommand)
    const currentView = coreviewCurrentViewRef.current ?? coreviewCurrentView
    const currentPageIndex = currentView.pageIndex
    const currentPageCount = Math.max(1, currentView.pageCount)
    const transportStateBefore = builderArtifactCoReview.transportStatus.statusText
    const toolName = coreviewToolNameFromVoiceCommand(command)
    const nativeToolsPrimary = Boolean(
      isVoiceMode
        && builderArtifactCoReview.state.state === "co_review_live"
        && builderArtifactCoReview.transportStatus.toolsSupportedInCoReview
    )

    if (command.kind === "builder_update" || command.kind === "builder_cancel") {
      const isUpdateCommand = command.kind === "builder_update"
      setVoiceCommandStatus({
        text: isUpdateCommand ? "Starting artifact update" : "Cancelling artifact update",
        tone: "pending",
      })
      if (isUpdateCommand) {
        const optimisticContext = coreviewBuilderActionBus.buildUpdateContext({
          userUpdateRequest: command.updateRequest ?? transcript,
          updateMode: command.updateMode ?? null,
          sourceActor: "user",
        })
        if (optimisticContext?.rendererKind === "html") {
          latestCoreviewBuilderContextRef.current = optimisticContext
          setCoreviewBuilderUpdateCard({
            artifactTitle: optimisticContext.artifactTitle ?? stageBuilderArtifact?.artifactTitle ?? "Selected artifact",
            requestedChangeSummary: optimisticContext.requestedChangeSummary,
            status: "applying",
            currentStep: "Applying update...",
            outputTitle: null,
            outputPath: null,
            unsupportedReason: null,
            autoApplied: false,
            nonHtmlOutput: false,
            versionLabel: null,
            restoreAvailable: false,
          })
        }
      }

      const runBuilderCommand = async () => {
        const result = isUpdateCommand
          ? await coreviewBuilderActionBus.requestArtifactUpdate({
              userUpdateRequest: command.updateRequest ?? transcript,
              updateMode: command.updateMode ?? null,
              sourceActor: "user",
            })
          : await coreviewBuilderActionBus.cancelBuilderTask("user")
        applyCoreviewBuilderResult(result)
        recordReviewVoiceCommandTelemetry({
          command,
          commands,
          applied: result.ok,
          blockedReason: result.blockedReason === "no_selected_artifact"
            ? "no_artifact_selected"
            : result.blockedReason === "no_active_builder_task"
              ? "no_active_builder_task"
              : result.blockedReason
                ? "unsupported_update_mode"
                : null,
          triggeredRefresh: false,
          refreshResult: "not_requested",
          artifactCurrentPageIndex: currentPageIndex,
          artifactCurrentPageCount: currentPageCount,
          autoRefreshBlockedReason: result.blockedReason ?? null,
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
        })
      }

      window.setTimeout(() => {
        void runBuilderCommand().catch(() => {
          const failedResult: CoreviewBuilderActionResult = {
            ok: false,
            action: isUpdateCommand ? "coreview_request_artifact_update" : "coreview_cancel_builder_task",
            result: "failed",
            blockedReason: isUpdateCommand ? "builder_start_failed" : "builder_cancel_failed",
            userFacingMessage: isUpdateCommand
              ? "Sophia could not start the artifact update."
              : "Sophia could not cancel the update.",
            preservedMic: true,
            preservedReview: true,
            rawArtifactTextExcluded: true,
            rawFrameExcluded: true,
            rawCommentTextExcluded: true,
          }
          applyCoreviewBuilderResult(failedResult)
        })
      }, 0)

      return {
        handled: true,
        command,
        applied: true,
        blockedReason: null,
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
        suppressAssistant: true,
      }
    }

    if (annotationOrFocusCommands.length > 0) {
      const allNativeCommandsAlreadyHandled = annotationOrFocusCommands.every((candidate) => (
        candidate.kind === "add_annotation"
          ? coreviewAnnotationCommandAlreadyHandled(candidate, startedAtMs - 2200)
          : coreviewFocusCommandAlreadyHandled(startedAtMs - 2200)
      ))

      if (nativeToolsPrimary && allNativeCommandsAlreadyHandled) {
        return {
          handled: true,
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
          suppressAssistant: false,
        }
      }

      if (!builderArtifactId || !currentView.artifactId) {
        setVoiceCommandStatus({
          text: "No artifact is selected.",
          tone: "warn",
        })
        recordReviewVoiceCommandTelemetry({
          command,
          commands,
          applied: false,
          blockedReason: "no_artifact_selected",
          triggeredRefresh: false,
          refreshResult: "not_requested",
          artifactCurrentPageIndex: currentPageIndex,
          artifactCurrentPageCount: currentPageCount,
          autoRefreshBlockedReason: "no_artifact_selected",
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
          annotationFallbackAttempted: command.kind === "add_annotation",
          annotationFallbackResult: command.kind === "add_annotation" ? "blocked" : null,
          annotationFallbackBlockedReason: command.kind === "add_annotation" ? "no_artifact_selected" : null,
          recentAnnotationActionSucceeded: false,
          annotationCommitAttempted: false,
          annotationCommitResult: command.kind === "add_annotation" ? "no_selected_artifact" : null,
          annotationCommitCountBefore: command.kind === "add_annotation" ? 0 : null,
          annotationCommitCountAfter: command.kind === "add_annotation" ? 0 : null,
          annotationCommitVerified: false,
          annotationCommandPreventedNavigation: command.kind === "add_annotation",
          annotationCommandKeptArtifactMounted: false,
          annotationViewReadyTimedOut: false,
          annotationPartialSuccess: false,
          sessionLeaveGuardSuppressedForAnnotation: command.kind === "add_annotation",
        })
        return {
          handled: true,
          command,
          applied: false,
          blockedReason: "no_artifact_selected",
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
          suppressAssistant: true,
          assistantAnnotationClaimSuppressed: true,
        }
      }

      setVoiceCommandStatus({
        text: nativeToolsPrimary ? "Annotation request queued" : buildAppliedVoiceCommandStatus(command, currentPageIndex),
        tone: nativeToolsPrimary ? "pending" : "neutral",
      })

      const executeFallbackCommands = async () => {
        for (const nextCommand of commands) {
          if (
            nativeToolsPrimary
            && nextCommand.kind === "add_annotation"
            && coreviewAnnotationCommandAlreadyHandled(nextCommand, startedAtMs)
          ) {
            continue
          }
          if (
            nativeToolsPrimary
            && nextCommand.kind === "focus_anchor"
            && coreviewFocusCommandAlreadyHandled(startedAtMs)
          ) {
            continue
          }

          const commandView = coreviewCurrentViewRef.current ?? currentView
          const result = await runCoreviewAction((bus) => {
            if (nextCommand.kind === "refresh_view") {
              return bus.refreshView({ reason: "voice command fallback" }, "frontend_fallback")
            }
            if (nextCommand.kind === "add_annotation") {
              return bus.addAnnotation(
                coreviewAddAnnotationInputFromVoiceCommand(
                  nextCommand,
                  commandView,
                  lastCoreviewFocusedAnchorTypeRef.current,
                ),
                "frontend_fallback",
              )
            }
            if (nextCommand.kind === "focus_anchor") {
              return bus.focusAnchor(
                coreviewFocusAnchorInputFromVoiceCommand(
                  nextCommand,
                  commandView,
                  lastCoreviewFocusedAnchorTypeRef.current,
                ),
                "frontend_fallback",
              )
            }
            return bus.setView(coreviewSetViewInputFromVoiceCommand(nextCommand, commandView), "frontend_fallback")
          }, {
            voiceTriggered: true,
            commandKind: nextCommand.kind,
            dedupePrefix: `voice:${startedAtMs}`,
          })
          const annotationStateChanged = coreviewAnnotationStateChanged(result)
          const annotationFallbackResult = annotationFallbackResultFromCoreview(result)
          const annotationCommand = nextCommand.kind === "add_annotation"
          const annotationCommandKeptArtifactMounted = Boolean(
            annotationCommand
            && isVisible
            && builderStageActive
            && builderVoiceCommandTargetRef.current,
          )

          recordReviewVoiceCommandTelemetry({
            command: nextCommand,
            commands,
            applied: annotationCommand
              ? annotationStateChanged
              : (
                  result.ok
                  || routeBlockedReasonFromCoreview(result.blocked_reason) === null
                  || result.blocked_reason === "refresh_unavailable"
                  || result.blocked_reason === "review_not_active"
                ),
            blockedReason: result.ok ? null : routeBlockedReasonFromCoreview(result.blocked_reason),
            triggeredRefresh: result.refresh_attempted,
            refreshResult: result.refresh_attempted
              ? refreshResultFromCoreview(result.refresh_result)
              : "not_requested",
            artifactCurrentPageIndex: result.page_index ?? commandView.pageIndex,
            artifactCurrentPageCount: result.page_count ?? Math.max(1, commandView.pageCount),
            staleAfterPageChange: result.stale,
            waitedForViewReady: result.view_ready_wait_ms !== null,
            autoRefreshTiming: result.view_ready_wait_ms !== null
              ? `after_view_ready:${result.view_ready_wait_ms}ms`
              : null,
            autoRefreshBlockedReason: result.blocked_reason,
            transportStateBefore,
            transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
            annotationFallbackAttempted: annotationCommand,
            annotationFallbackResult: annotationCommand ? annotationFallbackResult : null,
            annotationFallbackBlockedReason: annotationCommand ? result.blocked_reason : null,
            recentAnnotationActionSucceeded: annotationStateChanged,
            annotationCommitAttempted: annotationCommand ? result.annotation_commit_attempted : false,
            annotationCommitResult: annotationCommand ? result.annotation_commit_result : null,
            annotationCommitCountBefore: annotationCommand ? result.annotation_commit_count_before : null,
            annotationCommitCountAfter: annotationCommand ? result.annotation_commit_count_after : null,
            annotationCommitVerified: annotationCommand ? result.annotation_commit_verified : false,
            annotationCommandPreventedNavigation: annotationCommand,
            annotationCommandKeptArtifactMounted,
            annotationViewReadyTimedOut: annotationCommand ? result.annotation_view_ready_timed_out : false,
            annotationPartialSuccess: annotationCommand ? result.annotation_partial_success : false,
            sessionLeaveGuardSuppressedForAnnotation: annotationCommand,
          })
        }
      }

      window.setTimeout(() => {
        void executeFallbackCommands().catch(() => {
          recordReviewVoiceCommandTelemetry({
            command,
            commands,
            applied: false,
            blockedReason: "visual_refresh_unavailable",
            triggeredRefresh: false,
            refreshResult: "error",
            artifactCurrentPageIndex: currentPageIndex,
            artifactCurrentPageCount: currentPageCount,
            staleAfterPageChange: false,
            waitedForViewReady: false,
            autoRefreshTiming: nativeToolsPrimary ? "delayed_native_tool_fallback" : "queued",
            autoRefreshBlockedReason: "refresh_exception",
            transportStateBefore,
            transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
            annotationFallbackAttempted: command.kind === "add_annotation",
            annotationFallbackResult: command.kind === "add_annotation" ? "blocked" : null,
            annotationFallbackBlockedReason: command.kind === "add_annotation" ? "refresh_exception" : null,
            recentAnnotationActionSucceeded: false,
            annotationCommitAttempted: command.kind === "add_annotation",
            annotationCommitResult: command.kind === "add_annotation" ? "annotation_commit_failed" : null,
            annotationCommitCountBefore: command.kind === "add_annotation" ? currentView.annotationCount : null,
            annotationCommitCountAfter: command.kind === "add_annotation" ? currentView.annotationCount : null,
            annotationCommitVerified: false,
            annotationCommandPreventedNavigation: command.kind === "add_annotation",
            annotationCommandKeptArtifactMounted: Boolean(
              command.kind === "add_annotation"
              && isVisible
              && builderStageActive
              && builderVoiceCommandTargetRef.current,
            ),
            annotationViewReadyTimedOut: false,
            annotationPartialSuccess: false,
            sessionLeaveGuardSuppressedForAnnotation: command.kind === "add_annotation",
          })
        })
      }, nativeToolsPrimary ? 120 : 0)

      return {
        handled: true,
        command,
        applied: true,
        blockedReason: null,
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
        suppressAssistant: true,
        assistantAnnotationClaimSuppressed: false,
      }
    }

    if (nativeToolsPrimary) {
      if (wasRecentCoreviewToolActionHandled({ toolName, sinceMs: Date.now() - 2200 })) {
        return {
          handled: true,
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh: false,
          refreshResult: "not_requested",
          userMessage: null,
          suppressAssistant: true,
        }
      }
      return { handled: false }
    }

    if (!builderArtifactId || !currentView.artifactId) {
      setVoiceCommandStatus({
        text: buildBlockedVoiceCommandMessage(command, currentPageCount),
        tone: "warn",
      })
      recordReviewVoiceCommandTelemetry({
        command,
        commands,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        artifactCurrentPageIndex: currentPageIndex,
        artifactCurrentPageCount: currentPageCount,
        autoRefreshBlockedReason: "no_artifact_selected",
        transportStateBefore,
        transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: "no_artifact_selected",
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
      }
    }

    const frameSenderAvailable = Boolean(
      builderArtifactCoReview.transportStatus.stillFramesSupported
      && builderArtifactCoReview.transportStatus.visualTransportSupported
    )
    let blockedReason: CoreviewToolBlockedReason | null = null
    let nextPageIndex = currentPageIndex
    let nextZoom = currentView.zoom
    let nextFitMode = currentView.fitMode

    if (command.kind !== "refresh_view") {
      const setInput = coreviewSetViewInputFromVoiceCommand(command, currentView)
      if (typeof setInput.pageIndex === "number") {
        nextPageIndex = Math.floor(setInput.pageIndex)
      } else if (typeof setInput.pageNumber === "number") {
        nextPageIndex = Math.floor(setInput.pageNumber) - 1
      }
      nextZoom = typeof setInput.zoom === "number" ? clampArtifactZoom(setInput.zoom) : nextZoom
      nextFitMode = setInput.fitMode ?? nextFitMode

      const requestedPage = typeof setInput.pageIndex === "number" || typeof setInput.pageNumber === "number"
      const requestedZoom = typeof setInput.zoom === "number" || typeof setInput.fitMode === "string"
      if (requestedPage && (!currentView.capabilities.supportsPages || currentPageCount <= 1)) {
        blockedReason = "pages_not_supported"
      } else if (requestedPage && (nextPageIndex < 0 || nextPageIndex >= currentPageCount)) {
        blockedReason = "requested_page_out_of_bounds"
      } else if (requestedZoom && !currentView.capabilities.supportsZoom) {
        blockedReason = "zoom_not_supported"
      }
    }

    if (blockedReason) {
      setVoiceCommandStatus({
        text: buildBlockedVoiceCommandMessage(command, currentPageCount),
        tone: "warn",
      })
      recordReviewVoiceCommandTelemetry({
        command,
        commands,
        applied: false,
        blockedReason: routeBlockedReasonFromCoreview(blockedReason),
        triggeredRefresh: false,
        refreshResult: "not_requested",
        artifactCurrentPageIndex: currentPageIndex,
        artifactCurrentPageCount: currentPageCount,
        autoRefreshBlockedReason: blockedReason,
        transportStateBefore,
        transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
      })
      return {
        handled: true,
        command,
        applied: false,
        blockedReason: routeBlockedReasonFromCoreview(blockedReason),
        triggeredRefresh: false,
        refreshResult: "not_requested",
        userMessage: null,
      }
    }

    const viewChanged = (
      command.kind !== "refresh_view"
      && (
        nextPageIndex !== currentPageIndex
        || Math.abs(nextZoom - currentView.zoom) >= 0.01
        || nextFitMode !== currentView.fitMode
      )
    )
    const refreshResult: ArtifactReviewVoiceCommandRefreshResult = currentView.canRefresh
      ? "pending"
      : frameSenderAvailable
        ? "not_active"
        : "unavailable"
    const triggeredRefresh = currentView.canRefresh
    const shouldStartVoiceReview = command.kind !== "refresh_view" && (
      !currentView.reviewHasFrame
      || (
        builderArtifactCoReview.transportStatus.stillFramesSupported
        && !builderArtifactCoReview.transportStatus.visualTransportSupported
      )
    )

    if (viewChanged) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("preview_not_ready"))
    }
    setVoiceCommandStatus(triggeredRefresh
      ? {
          text: buildAppliedVoiceCommandStatus(command, nextPageIndex),
          tone: "neutral",
        }
      : {
          text: buildRefreshUnavailableVoiceCommandMessage(command, shouldStartVoiceReview, viewChanged && currentView.reviewHasFrame),
          tone: command.kind === "refresh_view" || viewChanged ? "warn" : "neutral",
        })

    void runCoreviewAction((bus) => (
      command.kind === "refresh_view"
        ? bus.refreshView({ reason: "voice command fallback" }, "frontend_fallback")
        : bus.setView(coreviewSetViewInputFromVoiceCommand(command, currentView), "frontend_fallback")
    ), {
      applyStatus: triggeredRefresh,
      voiceTriggered: true,
      commandKind: command.kind,
      dedupePrefix: `voice:${startedAtMs}`,
    })
      .then((result) => {
        recordReviewVoiceCommandTelemetry({
          command,
          commands,
          applied: result.ok
            || routeBlockedReasonFromCoreview(result.blocked_reason) === null
            || result.blocked_reason === "refresh_unavailable"
            || result.blocked_reason === "review_not_active",
          blockedReason: result.ok
            ? null
            : result.action === "set_view" && result.blocked_reason
            ? routeBlockedReasonFromCoreview(result.blocked_reason)
            : null,
          triggeredRefresh: result.refresh_attempted,
          refreshResult: result.refresh_attempted
            ? refreshResultFromCoreview(result.refresh_result)
            : refreshResult,
          artifactCurrentPageIndex: result.page_index ?? nextPageIndex,
          artifactCurrentPageCount: result.page_count ?? currentPageCount,
          staleAfterPageChange: result.stale,
          waitedForViewReady: result.view_ready_wait_ms !== null,
          autoRefreshTiming: result.view_ready_wait_ms !== null
            ? `after_view_ready:${result.view_ready_wait_ms}ms`
            : null,
          autoRefreshBlockedReason: result.blocked_reason,
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
        })
      })
      .catch(() => {
        recordReviewVoiceCommandTelemetry({
          command,
          applied: true,
          blockedReason: null,
          triggeredRefresh,
          refreshResult: "error",
          artifactCurrentPageIndex: nextPageIndex,
          artifactCurrentPageCount: currentPageCount,
          staleAfterPageChange: viewChanged,
          waitedForViewReady: false,
          autoRefreshTiming: triggeredRefresh ? "queued" : "not_requested",
          autoRefreshBlockedReason: "refresh_exception",
          transportStateBefore,
          transportStateAfter: builderArtifactCoReview.transportStatus.statusText,
        })
      })

    return {
      handled: true,
      command,
      applied: true,
      blockedReason: null,
      triggeredRefresh,
      refreshResult,
      userMessage: null,
    }
  }, [
    builderArtifactCoReview.state.state,
    builderArtifactCoReview.transportStatus.statusText,
    builderArtifactCoReview.transportStatus.stillFramesSupported,
    builderArtifactCoReview.transportStatus.toolsSupportedInCoReview,
    builderArtifactCoReview.transportStatus.visualTransportSupported,
    builderArtifactId,
    builderStageActive,
    applyCoreviewBuilderResult,
    coreviewBuilderActionBus,
    coreviewCurrentView,
    isVoiceMode,
    isVisible,
    recordReviewVoiceCommandTelemetry,
    runCoreviewAction,
    stageBuilderArtifact?.artifactTitle,
  ])

  useEffect(() => {
    onArtifactReviewVoiceCommandRouteChange?.(routeArtifactReviewVoiceCommand)
    return () => onArtifactReviewVoiceCommandRouteChange?.(null)
  }, [onArtifactReviewVoiceCommandRouteChange, routeArtifactReviewVoiceCommand])

  useEffect(() => {
    setVoiceCommandStaleViewSignature(null)
    setVoiceCommandStatus(null)
  }, [builderArtifactId, stagePrimaryFile?.path, stageRendererKind])

  useEffect(() => {
    if (
      !voiceCommandStaleViewSignature
      || builderArtifactCoReview.state.state !== "co_review_live"
      || (builderArtifactCoReview.state.frameSentCount ?? 0) <= 0
    ) {
      if (voiceCommandStaleViewSignature) {
        setVoiceCommandStaleViewSignature(null)
      }
      return
    }

    if (
      builderArtifactCoReview.state.refreshFrameResult === "success"
      && builderArtifactViewSignature === voiceCommandStaleViewSignature
      && !builderArtifactCoReview.reviewStale
    ) {
      setVoiceCommandStaleViewSignature(null)
    }
  }, [
    builderArtifactCoReview.reviewStale,
    builderArtifactCoReview.state.frameSentCount,
    builderArtifactCoReview.state.refreshFrameResult,
    builderArtifactCoReview.state.state,
    builderArtifactViewSignature,
    voiceCommandStaleViewSignature,
  ])

  useEffect(() => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId) {
      selectedStageCaptureSignatureRef.current = null
      return
    }

    const signature = [
      sessionId ?? "",
      normalSessionId ?? "",
      threadId ?? "",
      builderArtifactId,
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageCaptureSignatureRef.current === signature) {
      return
    }
    selectedStageCaptureSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: false,
      rebindSource: "artifact_stage_mount",
      rebindReason: null,
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderExactTextAvailable,
    effectiveBuilderVisualCaptureStatus.reason,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionCharCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionPageCount,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionSource,
    effectiveBuilderVisualCaptureStatus.pdfTextExtractionStatus,
    effectiveBuilderVisualCaptureStatus.ready,
    effectiveBuilderVisualCaptureStatus.source,
    isVisible,
    normalSessionId,
    normalizedSelectedBuilderArtifactPath,
    recordSelectedStageArtifactTelemetry,
    sessionId,
    stageBuilderArtifact,
    stageArtifactPath,
    stageRendererKind,
    threadId,
  ])

  useEffect(() => {
    if (!isVisible || !stageBuilderArtifact || !builderArtifactId || !voiceAgentSessionId) {
      return
    }

    const signature = [
      "voice_connect",
      voiceAgentSessionId,
      threadId ?? "",
      builderArtifactId,
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
      effectiveBuilderVisualCaptureStatus.ready ? "ready" : "not-ready",
      builderExactTextAvailable ? "exact" : "no-exact",
    ].join("|")

    if (selectedStageRebindSignatureRef.current === signature) {
      return
    }
    selectedStageRebindSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: true,
      rebindSource: "voice_connect",
      rebindReason: "voice_connect_visible_artifact",
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderExactTextAvailable,
    effectiveBuilderVisualCaptureStatus.ready,
    isVisible,
    recordSelectedStageArtifactTelemetry,
    stageArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
    threadId,
    voiceAgentSessionId,
  ])

  useEffect(() => {
    if (
      !isVisible
      || !stageBuilderArtifact
      || !builderArtifactId
      || (builderReviewStateName !== "co_review_starting" && builderReviewStateName !== "co_review_live")
    ) {
      return
    }

    const signature = [
      "review_start",
      sessionId ?? "",
      normalSessionId ?? "",
      voiceAgentSessionId ?? "",
      threadId ?? "",
      builderArtifactId,
      stageArtifactPath ?? "",
      stageRendererKind,
      builderArtifactViewSignature ?? "",
    ].join("|")

    if (selectedStageRebindSignatureRef.current === signature) {
      return
    }
    selectedStageRebindSignatureRef.current = signature

    recordSelectedStageArtifactTelemetry({
      rebindAttempted: true,
      rebindSource: "review_start",
      rebindReason: "review_start_visible_artifact",
    })
  }, [
    builderArtifactId,
    builderArtifactViewSignature,
    builderReviewStateName,
    isVisible,
    normalSessionId,
    recordSelectedStageArtifactTelemetry,
    sessionId,
    stageArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
    threadId,
    voiceAgentSessionId,
  ])

  // Phase lifecycle
  useEffect(() => {
    if (isVisible && stageBuilderArtifact) {
      const sameVisibleBuilderStage = builderStageVisibilitySignatureRef.current === builderStageVisibilitySignature
      builderStageVisibilitySignatureRef.current = builderStageVisibilitySignature
      setPhase("visible")
      setRevealStep(4)
      setReflectionTapped(false)
      if (sameVisibleBuilderStage) {
        recordSophiaCaptureEvent({
          category: "builder-ui",
          name: "artifact-stage-unmount-prevented",
          payload: {
            artifactStageUnmountPrevented: true,
            artifactStageProtectedFromSnapshot: true,
            builderSnapshotIgnoredForActiveArtifact: true,
            artifactRendererKind: stageRendererKind,
            selectedBuilderArtifactPathPresent: Boolean(normalizedSelectedBuilderArtifactPath),
            rawArtifactTextExcluded: true,
            rawCommentTextExcluded: true,
            rawFrameExcluded: true,
          },
        })
      }
      return
    }

    if (isVisible && (artifacts || stageBuilderArtifact || hasBuilderLibrary)) {
      builderStageVisibilitySignatureRef.current = null
      setPhase("entering")
      setRevealStep(0)
      setReflectionTapped(false)
      requestAnimationFrame(() => setPhase("visible"))
    } else if (phase !== "hidden") {
      builderStageVisibilitySignatureRef.current = null
      setPhase("exiting")
      const t = setTimeout(() => setPhase("hidden"), 800)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    artifacts,
    builderStageVisibilitySignature,
    hasBuilderLibrary,
    isVisible,
    normalizedSelectedBuilderArtifactPath,
    stageBuilderArtifact,
    stageRendererKind,
  ])

  useEffect(() => {
    if (!builderArtifactId) {
      setBuilderVisualCaptureStatus(unavailableCaptureStatus("no_selected_artifact"))
      return
    }

    if (!stageUsesHtmlPreview && !stageUsesMarkdownPreview && !stageUsesPdfPreview) {
      setBuilderVisualCaptureStatus({
        ready: true,
        reason: null,
        source: "metadata_canvas",
        exactTextAvailable: true,
      })
      return
    }

    setBuilderVisualCaptureStatus(unavailableCaptureStatus(
      "preview_not_ready",
      stageUsesHtmlPreview ? "html_preview_canvas" : stageUsesMarkdownPreview ? "markdown_preview_canvas" : "pdf_page_canvas",
    ))
  }, [builderArtifactId, stageUsesHtmlPreview, stageUsesMarkdownPreview, stageUsesPdfPreview])

  // Staggered reveal — each piece fades in like a star brightening
  useEffect(() => {
    staggerRef.current.forEach(clearTimeout)
    staggerRef.current = []

    if (phase === "visible") {
      const delays = [100, 800, 1600, 2800]
      delays.forEach((d, i) => {
        staggerRef.current.push(setTimeout(() => setRevealStep(i + 1), d))
      })
    } else if (phase === "hidden") {
      setRevealStep(0)
    }

    return () => staggerRef.current.forEach(clearTimeout)
  }, [phase])

  // Voice mode: auto-dismiss after 18s — BUT NOT when builder deliverable is present
  // Builder results are high-value; user needs time to act on them
  useEffect(() => {
    if (autoCollapseRef.current) {
      clearTimeout(autoCollapseRef.current)
      autoCollapseRef.current = null
    }
    if (phase === "visible" && isVoiceMode && !stageBuilderArtifact && !hasBuilderLibrary && !showDomArtifactCoReview) {
      autoCollapseRef.current = setTimeout(() => {
        autoCollapseRef.current = null
        onDismiss()
      }, 18000)
    }
    return () => {
      if (autoCollapseRef.current) clearTimeout(autoCollapseRef.current)
    }
  }, [phase, isVoiceMode, onDismiss, stageBuilderArtifact, hasBuilderLibrary, showDomArtifactCoReview])

  useEffect(() => {
    if (!pendingBuilderArtifactReview || !hasBuilder || !stageBuilderArtifact) {
      return
    }

    if (builderReviewStateName === "co_review_live" || builderReviewStateName === "co_review_starting") {
      onPendingBuilderArtifactReviewConsumed?.()
      return
    }

    if (!builderReviewCanStart) {
      return
    }

    onPendingBuilderArtifactReviewConsumed?.()
    void startBuilderArtifactReview()
  }, [
    builderReviewCanStart,
    builderReviewStateName,
    hasBuilder,
    onPendingBuilderArtifactReviewConsumed,
    pendingBuilderArtifactReview,
    stageBuilderArtifact,
    startBuilderArtifactReview,
  ])

  const handleDismiss = useCallback(() => {
    haptic("light")
    onDismiss()
  }, [onDismiss])

  const handleReflectionTap = useCallback(() => {
    if (!artifacts?.reflection_candidate || !isRealReflection(artifacts.reflection_candidate.prompt) || reflectionTapped) return
    haptic("medium")
    setReflectionTapped(true)
    onReflectionTap?.({
      prompt: artifacts.reflection_candidate.prompt,
      why: artifacts.reflection_candidate.why,
    })
  }, [artifacts?.reflection_candidate, reflectionTapped, onReflectionTap])

  const handleCancelCoreviewBuilderUpdate = useCallback(() => {
    setCoreviewBuilderUpdateCard((current) => current ? { ...current, status: "cancelling" } : current)
    void coreviewBuilderActionBus.cancelBuilderTask("user")
      .then(applyCoreviewBuilderResult)
      .catch(() => {
        applyCoreviewBuilderResult({
          ok: false,
          action: "coreview_cancel_builder_task",
          result: "failed",
          blockedReason: "builder_cancel_failed",
          userFacingMessage: "Sophia could not cancel the update.",
          preservedMic: true,
          preservedReview: true,
          rawArtifactTextExcluded: true,
          rawFrameExcluded: true,
          rawCommentTextExcluded: true,
        })
      })
  }, [applyCoreviewBuilderResult, coreviewBuilderActionBus])

  const handleViewCoreviewBuilderUpdatedVersion = useCallback(() => {
    const path = coreviewBuilderUpdateCard?.outputPath ?? latestCoreviewBuilderOutput?.artifactPath ?? null
    const context = latestCoreviewBuilderContextRef.current
    if (context) {
      emitCoreviewBuilderWorkspaceEvent({
        type: "artifact.version_selected",
        context,
        taskId: builderTask?.taskId ?? builderCompletion?.task_id ?? null,
        runId: builderTask?.runId ?? builderCompletion?.run_id ?? null,
        result: "selected",
        output: {
          artifactPath: path,
          artifactTitle: coreviewBuilderUpdateCard?.outputTitle ?? latestCoreviewBuilderOutput?.artifactTitle ?? null,
        },
      })
    }
    onCoreviewBuilderViewUpdatedVersion?.(path)
  }, [
    builderCompletion?.run_id,
    builderCompletion?.task_id,
    builderTask?.runId,
    builderTask?.taskId,
    coreviewBuilderUpdateCard?.outputPath,
    coreviewBuilderUpdateCard?.outputTitle,
    emitCoreviewBuilderWorkspaceEvent,
    latestCoreviewBuilderOutput,
    onCoreviewBuilderViewUpdatedVersion,
  ])

  const handleRestoreOriginalCoreviewArtifact = useCallback(() => {
    if (!coreviewArtifactVersionState) {
      return
    }
    setRestoreOriginalPending(true)
    const restoredState = restoreOriginalVersion({
      workspaceKey: coreviewWorkspaceKey,
      logicalArtifactId: coreviewArtifactVersionState.logicalArtifactId,
    })
    const restoredVersion = getCurrentVersion(restoredState)
    const restoreResult = restoredState && restoredVersion ? "success" : "version_state_unavailable"
    const versionTelemetry = getVersionTelemetry(restoredState ?? coreviewArtifactVersionState)
    if (restoredState && restoredVersion) {
      setCoreviewArtifactVersionState(restoredState)
      onSelectedBuilderArtifactPathChange?.(restoredVersion.artifactPath)
      const context = latestCoreviewBuilderContextRef.current
      if (context) {
        emitCoreviewBuilderWorkspaceEvent({
          type: "artifact.version_selected",
          context,
          taskId: restoredVersion.builderTaskId ?? builderTask?.taskId ?? builderCompletion?.task_id ?? null,
          runId: builderTask?.runId ?? builderCompletion?.run_id ?? null,
          result: "restore_original",
          output: {
            artifactPath: restoredVersion.artifactPath,
            artifactTitle: restoredVersion.artifactTitle,
          },
        })
      }
      setCoreviewBuilderUpdateCard((current) => current
        ? {
            ...current,
            status: "completed",
            currentStep: null,
            outputTitle: restoredVersion.artifactTitle,
            outputPath: restoredVersion.artifactPath,
            autoApplied: true,
            nonHtmlOutput: false,
            versionLabel: "Version 1 restored",
            restoreAvailable: false,
          }
        : current)
    }
    onCoreviewActionFeedback?.(createCoreviewActionFeedback({
      actionKind: "restore_original",
      status: restoredState && restoredVersion ? "completed" : "failed",
      displayMessage: restoredState && restoredVersion ? "Original restored." : "Original could not be restored.",
      spokenMessage: restoredState && restoredVersion ? "Original restored." : "I couldn't restore the original.",
      shouldSpeak: isVoiceMode,
      dedupeKey: `restore-original:${coreviewArtifactVersionState.logicalArtifactId}:${restoreResult}`,
    }))
    setRestoreOriginalPending(false)
    recordSophiaCaptureEvent({
      category: "voice-session",
      name: "coreview-builder-action",
      payload: {
        sessionId: sessionId ?? null,
        normalSessionId: normalSessionId ?? null,
        threadId: threadId ?? null,
        coreviewHtmlLiveUpdateEnabled,
        coreviewArtifactVersioningEnabled: true,
        coreviewArtifactLogicalId: versionTelemetry.coreviewArtifactLogicalId
          ?? coreviewArtifactVersionState.logicalArtifactId,
        coreviewArtifactOriginalVersionIdPresent: versionTelemetry.coreviewArtifactOriginalVersionIdPresent,
        coreviewArtifactCurrentVersionIdPresent: versionTelemetry.coreviewArtifactCurrentVersionIdPresent,
        coreviewArtifactVersionCount: versionTelemetry.coreviewArtifactVersionCount,
        coreviewHtmlUpdatePreviousPathHash: versionTelemetry.coreviewHtmlUpdatePreviousPathHash,
        coreviewHtmlUpdateCurrentPathHash: versionTelemetry.coreviewHtmlUpdateCurrentPathHash,
        coreviewHtmlUpdateRestoreAvailable: versionTelemetry.coreviewHtmlUpdateRestoreAvailable,
        coreviewHtmlUpdateRestoreResult: restoreResult,
        coreviewHtmlUpdatePreservedReview: true,
        coreviewHtmlUpdatePreservedMic: true,
        rawArtifactTextExcluded: true,
        rawCommentTextExcluded: true,
        rawFrameExcluded: true,
      },
    })
  }, [
    builderCompletion?.run_id,
    builderCompletion?.task_id,
    builderTask?.runId,
    builderTask?.taskId,
    coreviewArtifactVersionState,
    coreviewHtmlLiveUpdateEnabled,
    coreviewWorkspaceKey,
    emitCoreviewBuilderWorkspaceEvent,
    isVoiceMode,
    normalSessionId,
    onCoreviewActionFeedback,
    onSelectedBuilderArtifactPathChange,
    sessionId,
    threadId,
  ])

  if ((!artifacts && !stageBuilderArtifact && !hasBuilderLibrary) || phase === "hidden") return null

  const hasContent = hasBuilder || hasBuilderLibrary || hasTakeaway || hasReflection || hasMemories

  if (!hasContent) return null

  const isActive = phase === "visible"
  const isTextModeBuilderStage = !isVoiceMode && hasBuilder
  const showSecondaryArtifactSurfaces = !builderStageActive

  // Presence-reactive bloom color
  const bloomColor =
    status === "speaking"
      ? "var(--sophia-glow)"
      : status === "listening"
        ? "var(--cosmic-teal)"
        : "var(--sophia-purple)"

  return (
    <div
      className={cn(
        "pointer-events-none select-none",
        "transition-all duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        isVoiceMode
          ? hasBuilder
            ? "fixed inset-x-0 top-[72px] bottom-[calc(8.75rem+env(safe-area-inset-bottom,0px))] z-25 flex min-h-0 items-center justify-center overflow-hidden px-3 sm:px-6"
            : "fixed left-1/2 -translate-x-1/2 bottom-[155px] z-25 w-full max-w-[720px] px-4 sm:px-6"
          : isTextModeBuilderStage
            ? "relative z-10 h-full min-h-0 w-full max-w-none px-0"
          : cn(
              "relative z-10 w-full mx-auto px-6 mb-3",
              hasBuilder ? "max-w-4xl" : "max-w-2xl",
            ),
        isActive ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      )}
      role="complementary"
      aria-label="Session artifacts"
    >
      {/* Bloom halo — the nebula glow behind the content */}
      <div
        className="absolute inset-0 -inset-x-8 -inset-y-4 rounded-full pointer-events-none transition-opacity duration-[2000ms]"
        style={{
          background: `radial-gradient(ellipse 80% 70% at 50% 40%, color-mix(in srgb, ${bloomColor} 8%, transparent) 0%, transparent 70%)`,
          filter: "blur(30px)",
          opacity: isActive ? 1 : 0,
        }}
      />

      {/* Dismiss zone — entire panel, tap to dismiss in voice mode */}
      <div
        className={cn(
          "relative pointer-events-auto",
          isVoiceMode && "cursor-pointer",
          isVoiceMode
            ? hasBuilder
              ? "flex h-full min-h-0 w-full max-w-[1120px] flex-col overflow-hidden rounded-xl px-0 py-0"
              : "max-h-[68vh] overflow-y-auto rounded-2xl px-4 py-4"
            : isTextModeBuilderStage
              ? "flex h-full min-h-0 flex-col overflow-hidden rounded-xl"
              : "rounded-2xl px-5 py-4"
        )}
        style={isTextModeBuilderStage || (isVoiceMode && hasBuilder)
          ? undefined
          : {
              background: 'var(--cosmic-panel)',
              borderRadius: '16px',
              border: '1px solid var(--cosmic-border-soft)',
              backdropFilter: 'blur(20px) saturate(1.2)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
            }}
        onClick={isVoiceMode && !hasBuilder ? handleDismiss : undefined}
      >
        {/* Dismiss hint — whisper-thin, top-right */}
        <button
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
          className={cn(
            "absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center",
            "transition-all duration-700",
            "pointer-events-auto cursor-pointer",
            revealStep >= 1 ? "opacity-100" : "opacity-0"
          )}
          style={{ color: 'var(--cosmic-text-faint)' }}
          aria-label="Dismiss"
        >
          <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round" />
          </svg>
        </button>

        {hasBuilder && stageBuilderArtifact && (
          <div
            ref={setBuilderArtifactRoot}
            className={cn(
              "relative transition-all duration-[1400ms] ease-out",
              isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
              isVoiceMode && "flex h-full min-h-0 w-full flex-col overflow-hidden",
              revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            )}
          >
            {builderArtifactId && !stageUsesHtmlPreview && !stageUsesMarkdownPreview && !stageUsesPdfPreview && (
              <CoreviewRealArtifactCanvas
                artifactId={builderArtifactId}
                builderArtifact={stageBuilderArtifact}
                sessionId={sessionId}
                normalSessionId={normalSessionId}
                voiceAgentSessionId={voiceAgentSessionId}
                threadId={threadId}
                artifactStableIdentity={artifactStableIdentity}
              />
            )}

            {coreviewBuilderUpdateCard && (
              <ArtifactReviewBuilderUpdateCard
                artifactTitle={coreviewBuilderUpdateCard.artifactTitle}
                requestedChangeSummary={coreviewBuilderUpdateCard.requestedChangeSummary}
                status={coreviewBuilderUpdateCard.status}
                currentStep={coreviewBuilderUpdateCard.currentStep}
                unsupportedReason={coreviewBuilderUpdateCard.unsupportedReason}
                cancellable={Boolean(activeCoreviewBuilderTask?.cancellable && coreviewBuilderUpdateCard.status === "updating")}
                cancelPending={isCancellingBuilderTask || coreviewBuilderUpdateCard.status === "cancelling"}
                outputTitle={coreviewBuilderUpdateCard.outputTitle}
                outputPath={coreviewBuilderUpdateCard.outputPath}
                autoApplied={coreviewBuilderUpdateCard.autoApplied}
                nonHtmlOutput={coreviewBuilderUpdateCard.nonHtmlOutput}
                versionLabel={coreviewBuilderUpdateCard.versionLabel}
                restoreAvailable={coreviewBuilderUpdateCard.restoreAvailable}
                restorePending={restoreOriginalPending}
                onCancel={handleCancelCoreviewBuilderUpdate}
                onRestoreOriginal={handleRestoreOriginalCoreviewArtifact}
                onViewUpdatedVersion={handleViewCoreviewBuilderUpdatedVersion}
              />
            )}

            <div
              className={cn(
                isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
                isVoiceMode && "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden",
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {isVoiceMode ? (
                <VoiceArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  voiceAgentSessionId={voiceAgentSessionId}
                  artifactStableIdentity={artifactStableIdentity}
                  artifactLogicalId={coreviewArtifactLogicalId}
                  artifactVersionId={coreviewArtifactVersionId}
                  annotations={coreviewAnnotationList}
                  annotationStoreTelemetry={coreviewAnnotationTelemetry}
                  onAddAnnotation={addCoreviewAnnotation}
                  onUpdateAnnotation={updateCoreviewAnnotation}
                  onDeleteAnnotation={deleteCoreviewAnnotation}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewPreparing={visualReviewPreparing}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesHtmlPreview || stageUsesMarkdownPreview || stageUsesPdfPreview ? builderVisualCaptureStatus : null}
                  reviewViewPending={builderReviewViewPending}
                  reviewStale={builderReviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
                  voiceCommandStatusText={voiceCommandStatus?.text ?? null}
                  voiceCommandStatusTone={voiceCommandStatus?.tone}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
                  onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
                  onWorkspaceToolModeChange={handleWorkspaceToolModeChange}
                  onWorkspaceExportRequested={handleWorkspaceExportRequested}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                  onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
                />
              ) : (
                <ArtifactStage
                  builderArtifact={stageBuilderArtifact}
                  builderArtifactLibrary={builderArtifactLibrary}
                  threadId={threadId}
                  artifactId={builderArtifactId}
                  sessionId={sessionId}
                  normalSessionId={normalSessionId}
                  voiceAgentSessionId={voiceAgentSessionId}
                  artifactStableIdentity={artifactStableIdentity}
                  artifactLogicalId={coreviewArtifactLogicalId}
                  artifactVersionId={coreviewArtifactVersionId}
                  annotations={coreviewAnnotationList}
                  annotationStoreTelemetry={coreviewAnnotationTelemetry}
                  onAddAnnotation={addCoreviewAnnotation}
                  onUpdateAnnotation={updateCoreviewAnnotation}
                  onDeleteAnnotation={deleteCoreviewAnnotation}
                  reviewState={builderArtifactCoReview.state}
                  transportStatus={builderArtifactCoReview.transportStatus}
                  exactTextAvailable={builderExactTextAvailable}
                  canStartReview={builderArtifactCoReview.canStart}
                  reviewEnabled={builderArtifactCoReview.enabled}
                  visualReviewRequiresVoice={visualReviewRequiresVoice}
                  pendingStartVoiceReview={pendingBuilderArtifactReview}
                  visualCaptureStatus={stageUsesHtmlPreview || stageUsesMarkdownPreview || stageUsesPdfPreview ? builderVisualCaptureStatus : null}
                  reviewViewPending={builderReviewViewPending}
                  reviewStale={builderReviewStale}
                  canRefreshReview={builderArtifactCoReview.canRefresh}
                  voiceCommandStatusText={voiceCommandStatus?.text ?? null}
                  voiceCommandStatusTone={voiceCommandStatus?.tone}
                  onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
                  onArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
                  onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
                  onWorkspaceToolModeChange={handleWorkspaceToolModeChange}
                  onWorkspaceExportRequested={handleWorkspaceExportRequested}
                  onStartVoiceReview={onStartVoiceBuilderArtifactReview}
                  onStartReview={() => { void builderArtifactCoReview.startReview() }}
                  onStopReview={() => { void builderArtifactCoReview.stopReview() }}
                  onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
                  fillAvailable={isTextModeBuilderStage}
                  className={cn(isTextModeBuilderStage && "min-h-0 flex-1")}
                />
              )}
            </div>
          </div>
        )}

        <PresenceArtifactSecondarySurfaces
          artifacts={artifacts}
          builderArtifactLibrary={builderArtifactLibrary}
          stageBuilderArtifact={stageBuilderArtifact}
          showSecondaryArtifactSurfaces={showSecondaryArtifactSurfaces}
          showDomArtifactCoReview={showDomArtifactCoReview}
          threadId={threadId}
          sessionId={sessionId}
          normalSessionId={normalSessionId}
          revealStep={revealStep}
          isActive={isActive}
          bloomColor={bloomColor}
          reflectionTapped={reflectionTapped}
          domArtifactCoReview={domArtifactCoReview}
          onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
          onHandleReflectionTap={handleReflectionTap}
          onReflectionTap={onReflectionTap}
          onMemoryApprove={onMemoryApprove}
          onMemoryReject={onMemoryReject}
          onDomArtifactRootChange={setDomArtifactRoot}
        />
      </div>
    </div>
  )
}

/**
 * Cosmic toggle — a faint constellation marker that glows when tapped.
 * Shows when artifacts are dismissed but available.
 * Matches the whisper-indicator aesthetic: near-invisible, part of the field.
 */
export function ArtifactToggleIcon({
  hasArtifacts,
  onClick,
  isNew,
}: {
  hasArtifacts: boolean
  onClick: () => void
  /** True when new/unseen insights are available */
  isNew?: boolean
}) {
  if (!hasArtifacts) return null

  return (
    <button
      onClick={() => { haptic("light"); onClick() }}
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 rounded-full",
        "transition-all duration-500 cursor-pointer",
        isNew && "animate-[insightPulse_2.5s_ease-in-out_infinite]",
      )}
      style={{
        color: isNew ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text)',
        background: isNew
          ? 'color-mix(in srgb, var(--sophia-purple) 18%, var(--cosmic-panel))'
          : 'var(--cosmic-panel-soft)',
        border: isNew
          ? '1px solid color-mix(in srgb, var(--sophia-purple) 35%, transparent)'
          : '1px solid var(--cosmic-border-soft)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      aria-label={isNew ? "New insights available" : "Show insights"}
    >
      {/* Bloom dot */}
      <span
        className={cn(
          "w-2 h-2 rounded-full transition-all duration-700",
          isNew && "shadow-[0_0_10px_var(--sophia-glow)]",
        )}
        style={{
          background: isNew
            ? 'var(--sophia-glow)'
            : 'color-mix(in srgb, var(--sophia-purple) 50%, var(--cosmic-panel-soft))',
        }}
      />
      <span className={cn(
        "text-[11px] tracking-[0.1em] lowercase font-medium",
        isNew && "text-[12px]",
      )}>
        {isNew ? 'new insight' : 'insights'}
      </span>
    </button>
  )
}
