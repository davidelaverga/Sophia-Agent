import {
  buildArtifactViewSignature,
  clampArtifactZoom,
  type ArtifactFitMode,
  type ArtifactRendererKind,
} from "./artifact-renderers"
import {
  buildCoreviewCapabilitySummary,
  getCoreviewArtifactCapabilities,
} from "./coreview-artifact-capabilities"
import { coreviewBuilderGeminiFunctionDeclarations } from "./coreview-builder-actions"
import {
  COREVIEW_WORKSPACE_CONTRACT_VERSION,
  type CoreviewArtifactCapabilities,
  type CoreviewCurrentViewCapabilitySummary,
} from "./coreview-workspace-contract"

export const COREVIEW_SET_VIEW_TOOL_NAME = "coreview_set_view"
export const COREVIEW_REFRESH_VIEW_TOOL_NAME = "coreview_refresh_view"
export const COREVIEW_GET_CURRENT_VIEW_TOOL_NAME = "coreview_get_current_view"
export const COREVIEW_ADD_ANNOTATION_TOOL_NAME = "coreview_add_annotation"
export const COREVIEW_FOCUS_ANCHOR_TOOL_NAME = "coreview_focus_anchor"

export const COREVIEW_TOOL_NAMES = [
  COREVIEW_SET_VIEW_TOOL_NAME,
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  COREVIEW_GET_CURRENT_VIEW_TOOL_NAME,
  COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
] as const

const GEMINI_GENERIC_BUILDER_TOOL_NAMES = new Set([
  "start_builder_task",
  "edit_builder_artifact",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks",
])

export type CoreviewToolName = typeof COREVIEW_TOOL_NAMES[number]
export type CoreviewActionName = "set_view" | "refresh_view" | "get_current_view" | "add_annotation" | "focus_anchor"
export type CoreviewToolCommandSource = "gemini_tool" | "frontend_fallback"

export type CoreviewToolRefreshResult =
  | "not_requested"
  | "success"
  | "error"
  | "failed"
  | "not_active"
  | "unavailable"
  | "view_ready_timeout"
  | "refresh_unavailable"

export type CoreviewToolBlockedReason =
  | "no_selected_artifact"
  | "artifact_mismatch"
  | "artifact_rebind_required"
  | "artifact_rebind_failed"
  | "artifact_not_available_in_current_session"
  | "unsupported_renderer"
  | "unsupported_pages"
  | "pages_not_supported"
  | "zoom_not_supported"
  | "annotations_not_supported"
  | "layout_anchor_not_supported"
  | "section_not_found"
  | "iframe_not_ready"
  | "section_index_not_ready"
  | "command_timeout"
  | "bridge_unavailable"
  | "document_unavailable"
  | "cross_origin_unavailable"
  | "ocr_not_available"
  | "pptx_native_renderer_unavailable"
  | "requested_page_out_of_bounds"
  | "view_ready_timeout"
  | "refresh_unavailable"
  | "review_not_active"
  | "tool_unavailable"
  | "invalid_tool_args"
  | "unsupported_annotation_kind"
  | "anchor_not_found"
  | "text_anchor_not_found"
  | "invalid_rect"
  | "annotation_commit_failed"
  | "annotation_target_unavailable"

export type CoreviewAnnotationKind = "highlight" | "comment" | "underline" | "arrow"
export type CoreviewAnnotationColor = "yellow" | "purple" | "blue" | "pink"
export type CoreviewAnnotationCommitResult =
  | "not_attempted"
  | "success"
  | "partial_success"
  | "annotation_commit_failed"
  | CoreviewToolBlockedReason

export interface CoreviewNormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CoreviewNormalizedPoint {
  x: number
  y: number
}

export interface CoreviewNormalizedLine {
  start: CoreviewNormalizedPoint
  end: CoreviewNormalizedPoint
}

export type CoreviewAnnotationAnchor =
  | { type: "current_title" }
  | { type: "current_selection" }
  | { type: "text_quote"; text: string; occurrence?: number }
  | ({ type: "rect" } & CoreviewNormalizedRect)
  | ({ type: "point" } & CoreviewNormalizedPoint)

export interface CoreviewSetViewInput {
  artifactId?: string
  pageIndex?: number
  pageNumber?: number
  pageLabel?: string
  zoom?: number
  fitMode?: ArtifactFitMode
  htmlScrollDelta?: number
  htmlScrollPosition?: "top" | "bottom"
  reason?: string
}

export interface CoreviewRefreshViewInput {
  reason?: string
}

export interface CoreviewGetCurrentViewInput {
  artifactId?: string
}

export interface CoreviewAddAnnotationInput {
  kind: CoreviewAnnotationKind | string
  artifactId?: string
  pageIndex?: number
  pageNumber?: number
  anchor?: CoreviewAnnotationAnchor
  rect?: CoreviewNormalizedRect
  point?: CoreviewNormalizedPoint
  color?: CoreviewAnnotationColor
  text?: string
  note?: string
  source: "sophia" | "user"
}

export interface CoreviewFocusAnchorInput {
  artifactId?: string
  pageIndex?: number
  pageNumber?: number
  anchor?: CoreviewAnnotationAnchor
  zoom?: number
  zoomDelta?: number
  fitMode?: ArtifactFitMode
  reason?: string
}

export interface CoreviewToolCallInput {
  id: string | null
  name: CoreviewToolName
  args: Record<string, unknown>
}

export interface CoreviewCurrentView {
  artifactId: string | null
  artifactPath: string | null
  artifactTitle: string | null
  artifactStableIdentity?: string | null
  rendererKind: ArtifactRendererKind
  capabilities: CoreviewArtifactCapabilities
  supportsPagination: boolean
  supportsZoom: boolean
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
  scrollTop?: number | null
  scrollHeight?: number | null
  documentHeight?: number | null
  viewportHeight?: number | null
  viewportWidth?: number | null
  scale?: number | null
  visibleTextSummary?: string | null
  visibleHeadings?: string[]
  currentSection?: string | null
  htmlBridgeReady?: boolean | null
  htmlSectionIndexReady?: boolean | null
  htmlSectionIndexEntryCount?: number | null
  htmlSectionIndexBuildResult?: string | null
  stillFrameAvailable?: boolean | null
  viewSignature: string | null
  stale: boolean
  refreshInProgress: boolean
  canRefresh: boolean
  reviewActive: boolean
  reviewHasFrame: boolean
  exactTextAvailable: boolean
  visualFrameFresh: boolean
  annotationOverlayCaptured: boolean | null
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount?: number
  arrowCount?: number
  drawPathCount?: number
  rebindStatus?: CoreviewArtifactRebindStatus
}

export type CoreviewArtifactRebindSource =
  | "voice_connect"
  | "review_start"
  | "coreview_tool"
  | "artifact_stage_mount"

export type CoreviewArtifactRebindStatus = "not_attempted" | "success" | "failed" | "not_needed"

export interface CoreviewArtifactRebindInput {
  source: CoreviewArtifactRebindSource
  reason: string
  requestedArtifactId?: string | null
}

export interface CoreviewArtifactRebindResult {
  ok: boolean
  status: CoreviewArtifactRebindStatus
  reason: string | null
  currentView?: CoreviewCurrentView | null
}

export interface CoreviewViewReadyResult {
  ok: boolean
  waitMs: number
  blockedReason: CoreviewToolBlockedReason | null
}

export interface CoreviewRefreshAdapterResult {
  ok: boolean
  refreshResult: CoreviewToolRefreshResult
  blockedReason: CoreviewToolBlockedReason | null
}

export interface CoreviewResolvedAnnotationAnchor {
  anchorType: CoreviewAnnotationAnchor["type"]
  pageIndex: number
  rect: CoreviewNormalizedRect | null
  point: CoreviewNormalizedPoint | null
  text?: string | null
  matchCount?: number | null
  textLength?: number | null
}

export type CoreviewResolveAnnotationAnchorResult =
  | { ok: true; anchor: CoreviewResolvedAnnotationAnchor }
  | { ok: false; blockedReason: CoreviewToolBlockedReason }

export interface CoreviewAddAnnotationAdapterInput {
  kind: CoreviewAnnotationKind
  pageIndex: number
  anchor: CoreviewResolvedAnnotationAnchor
  rect: CoreviewNormalizedRect | null
  point: CoreviewNormalizedPoint | null
  line: CoreviewNormalizedLine | null
  color: CoreviewAnnotationColor
  text: string | null
  source: "sophia" | "user"
}

export interface CoreviewAddAnnotationAdapterResult {
  ok: boolean
  annotationId: string | null
  blockedReason: CoreviewToolBlockedReason | null
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount?: number
  arrowCount?: number
  drawPathCount?: number
}

export interface CoreviewSetViewAdapterInput {
  pageIndex: number
  zoom: number
  fitMode: ArtifactFitMode
  htmlScrollDelta?: number | null
  htmlScrollPosition?: "top" | "bottom" | null
  htmlNavigationSource?: "voice" | "tool" | "manual"
}

export interface CoreviewHtmlNavigationTelemetry {
  htmlNavigationControllerActive?: boolean | null
  htmlNavigationRouterUsed?: boolean | null
  htmlNavigationCommandKind?: string | null
  htmlNavigationTargetSafe?: string | null
  htmlNavigationTargetKind?: string | null
  htmlNavigationResult?: string | null
  htmlNavigationFailureReason?: string | null
  htmlNavigationScrollTopBefore?: number | null
  htmlNavigationScrollTopAfter?: number | null
  htmlNavigationScrolled?: boolean | null
  htmlNavigationCommandId?: string | null
  htmlNavigationTimedOut?: boolean | null
  htmlNavigationWaitedForReady?: boolean | null
  htmlNavigationFeedbackEmitted?: boolean | null
  htmlNavigationPreventedPdfFallback?: boolean | null
  htmlNavigationBlockedGenericToolCount?: number | null
  htmlInternalNavigationUsedSameResolver?: boolean | null
  htmlVoiceNavigationUsedSameResolver?: boolean | null
  htmlNavigationSuppressedEmitArtifact?: boolean | null
  htmlNavigationSuppressedBuilderTool?: boolean | null
  htmlNavigationResultConfirmedBeforeFeedback?: boolean | null
}

export interface CoreviewSetViewAdapterResult extends CoreviewHtmlNavigationTelemetry {
  ok: boolean
  blockedReason: CoreviewToolBlockedReason | null
  method?: string | null
  scrolled?: boolean | null
}

export interface CoreviewFocusAnchorAdapterInput {
  pageIndex: number
  anchor: CoreviewResolvedAnnotationAnchor
  zoom: number
  fitMode: ArtifactFitMode
  htmlNavigationSource?: "voice" | "tool" | "manual"
}

export interface CoreviewFocusAnchorAdapterResult {
  ok: boolean
  blockedReason: CoreviewToolBlockedReason | null
  method?: string | null
  scrolled?: boolean | null
  htmlNavigation?: CoreviewHtmlNavigationTelemetry | null
}

export interface CoreviewRendererAdapter {
  getCurrentViewState(): CoreviewCurrentView
  setView(input: CoreviewSetViewAdapterInput): Promise<CoreviewSetViewAdapterResult | void> | CoreviewSetViewAdapterResult | void
  refreshView(input?: CoreviewRefreshViewInput): Promise<CoreviewRefreshAdapterResult> | CoreviewRefreshAdapterResult
  waitForViewReady(viewSignature: string | null): Promise<CoreviewViewReadyResult>
  markViewStale(viewSignature: string | null): void
  clearViewStale(viewSignature: string | null): void
  rebindVisibleArtifact?(input: CoreviewArtifactRebindInput): CoreviewArtifactRebindResult
  resolveAnnotationAnchor?(input: {
    anchor: CoreviewAnnotationAnchor
    pageIndex: number
  }): CoreviewResolveAnnotationAnchorResult
  addAnnotation?(input: CoreviewAddAnnotationAdapterInput): CoreviewAddAnnotationAdapterResult
  focusAnnotationAnchor?(input: CoreviewFocusAnchorAdapterInput): Promise<CoreviewFocusAnchorAdapterResult> | CoreviewFocusAnchorAdapterResult
}

export interface CoreviewActionResult {
  ok: boolean
  action: CoreviewActionName
  artifact_id: string | null
  artifact_path: string | null
  artifact_title: string | null
  renderer_kind: ArtifactRendererKind | null
  coreview_workspace_contract_version?: number
  capability_summary?: CoreviewCurrentViewCapabilitySummary
  page_index: number | null
  page_number: number | null
  page_count: number | null
  zoom: number | null
  fit_mode: ArtifactFitMode | null
  scroll_top?: number | null
  scroll_height?: number | null
  document_height?: number | null
  viewport_height?: number | null
  viewport_width?: number | null
  scale?: number | null
  visible_text_summary?: string | null
  visible_headings?: string[]
  current_section?: string | null
  html_bridge_ready?: boolean | null
  html_section_index_ready?: boolean | null
  html_section_index_entry_count?: number | null
  html_section_index_build_result?: string | null
  still_frame_available?: boolean | null
  html_scroll_attempted?: boolean
  html_scroll_result?: string | null
  html_focus_anchor_attempted?: boolean
  html_focus_anchor_result?: string | null
  html_focus_anchor_method?: string | null
  html_focus_anchor_scrolled?: boolean | null
  navigation_model?: "scroll_document" | "page" | null
  html_navigation_controller_active?: boolean | null
  html_navigation_router_used?: boolean | null
  html_navigation_command_kind?: string | null
  html_navigation_target_safe?: string | null
  html_navigation_target_kind?: string | null
  html_navigation_result?: string | null
  html_navigation_failure_reason?: string | null
  html_navigation_scroll_top_before?: number | null
  html_navigation_scroll_top_after?: number | null
  html_navigation_scrolled?: boolean | null
  html_navigation_command_id?: string | null
  html_navigation_timed_out?: boolean | null
  html_navigation_waited_for_ready?: boolean | null
  html_navigation_feedback_emitted?: boolean | null
  html_navigation_prevented_pdf_fallback?: boolean | null
  html_navigation_blocked_generic_tool_count?: number | null
  html_internal_navigation_used_same_resolver?: boolean | null
  html_voice_navigation_used_same_resolver?: boolean | null
  html_navigation_suppressed_emit_artifact?: boolean | null
  html_navigation_suppressed_builder_tool?: boolean | null
  html_navigation_result_confirmed_before_feedback?: boolean | null
  view_signature: string | null
  stale: boolean
  refresh_attempted: boolean
  refresh_result: CoreviewToolRefreshResult
  blocked_reason: CoreviewToolBlockedReason | null
  result_summary: string
  command_source: CoreviewToolCommandSource
  preserved_mic: true
  preserved_review: true
  view_ready_wait_ms: number | null
  view_signature_before: string | null
  view_signature_after: string | null
  exact_text_available?: boolean
  visual_frame_fresh?: boolean
  visual_fresh?: boolean
  frame_sent?: boolean
  review_active?: boolean
  current_view_summary?: string
  annotation_overlay_captured?: boolean | null
  annotation_id?: string | null
  annotation_kind?: CoreviewAnnotationKind | null
  annotation_anchor_type?: CoreviewAnnotationAnchor["type"] | null
  annotation_color?: CoreviewAnnotationColor | null
  annotation_page_index?: number | null
  annotation_count?: number | null
  highlight_count?: number | null
  comment_count?: number | null
  underline_count?: number | null
  arrow_count?: number | null
  draw_path_count?: number | null
  unsupported_annotation_kind?: string | null
  annotation_action_source?: "sophia" | "user" | null
  annotation_commit_attempted?: boolean
  annotation_commit_result?: CoreviewAnnotationCommitResult | null
  annotation_commit_count_before?: number | null
  annotation_commit_count_after?: number | null
  annotation_commit_verified?: boolean
  annotation_created?: boolean | null
  annotation_view_ready_timed_out?: boolean
  annotation_partial_success?: boolean
  focus_anchor_type?: CoreviewAnnotationAnchor["type"] | null
  focused_rect?: CoreviewNormalizedRect | null
  artifact_stable_identity?: string | null
  rebind_status: CoreviewArtifactRebindStatus
  rebind_attempted: boolean
  rebind_result: CoreviewArtifactRebindStatus
  rebind_reason: string | null
  raw_comment_text_excluded: true
  raw_artifact_text_excluded: true
  raw_frame_excluded: true
}

export interface CoreviewActionBus {
  setView(input: CoreviewSetViewInput, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  refreshView(input: CoreviewRefreshViewInput | undefined, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  getCurrentView(input: CoreviewGetCurrentViewInput | undefined, source: CoreviewToolCommandSource): CoreviewActionResult
  addAnnotation(input: CoreviewAddAnnotationInput, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  focusAnchor(input: CoreviewFocusAnchorInput, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  handleToolCall(call: CoreviewToolCallInput): Promise<CoreviewActionResult>
}

export function createCoreviewActionBus(adapter: CoreviewRendererAdapter): CoreviewActionBus {
  const getCurrentView = (
    input: CoreviewGetCurrentViewInput | undefined,
    source: CoreviewToolCommandSource,
  ): CoreviewActionResult => {
    const initial = adapter.getCurrentViewState()
    const resolved = resolveCurrentViewWithRebind({
      adapter,
      current: initial,
      requestedArtifactId: input?.artifactId ?? null,
      blockedReason: currentViewBlockedReason(initial, input?.artifactId),
    })
    const current = resolved.current
    const blockedReason = blockedReasonAfterRebind(
      currentViewBlockedReason(current, input?.artifactId),
      resolved,
    )
    return buildCoreviewResult({
      action: "get_current_view",
      source,
      current,
      ok: !blockedReason,
      blockedReason,
      resultSummary: blockedReason
        ? blockedSummary(blockedReason)
        : currentViewSummary(current),
      refreshAttempted: false,
      refreshResult: "not_requested",
      viewReadyWaitMs: null,
      viewSignatureBefore: initial.viewSignature,
      viewSignatureAfter: current.viewSignature,
      ...resolved.rebind,
    })
  }

  const refreshView = async (
    input: CoreviewRefreshViewInput | undefined,
    source: CoreviewToolCommandSource,
  ): Promise<CoreviewActionResult> => {
    const before = adapter.getCurrentViewState()
    const blockedReason = currentViewBlockedReason(before)
    if (blockedReason) {
      return buildCoreviewResult({
        action: "refresh_view",
        source,
        current: before,
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: before.viewSignature,
        viewSignatureAfter: before.viewSignature,
      })
    }

    const ready = await adapter.waitForViewReady(before.viewSignature)
    if (!ready.ok) {
      return buildCoreviewResult({
        action: "refresh_view",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason: ready.blockedReason ?? "view_ready_timeout",
        resultSummary: blockedSummary(ready.blockedReason ?? "view_ready_timeout"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: ready.waitMs,
        viewSignatureBefore: before.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
      })
    }

    const refresh = before.canRefresh
      ? await adapter.refreshView(input)
      : {
          ok: false,
          refreshResult: before.reviewActive ? "refresh_unavailable" : "not_active",
          blockedReason: before.reviewActive ? "refresh_unavailable" : "review_not_active",
        } satisfies CoreviewRefreshAdapterResult
    const after = adapter.getCurrentViewState()
    if (refresh.ok) {
      adapter.clearViewStale(after.viewSignature)
    }

    return buildCoreviewResult({
      action: "refresh_view",
      source,
      current: adapter.getCurrentViewState(),
      ok: refresh.ok,
      blockedReason: refresh.blockedReason,
      resultSummary: refresh.ok
        ? `Refreshed the current view. ${pageSummary(adapter.getCurrentViewState())}`
        : blockedSummary(refresh.blockedReason ?? "refresh_unavailable"),
      refreshAttempted: true,
      refreshResult: refresh.refreshResult,
      viewReadyWaitMs: ready.waitMs,
      viewSignatureBefore: before.viewSignature,
      viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
    })
  }

  const setView = async (
    input: CoreviewSetViewInput,
    source: CoreviewToolCommandSource,
  ): Promise<CoreviewActionResult> => {
    const initialBefore = adapter.getCurrentViewState()
    const resolved = resolveCurrentViewWithRebind({
      adapter,
      current: initialBefore,
      requestedArtifactId: input.artifactId ?? null,
      blockedReason: currentViewBlockedReason(initialBefore, input.artifactId),
    })
    const before = resolved.current
    const baseBlockedReason = currentViewBlockedReason(before, input.artifactId)
    const blockedAfterRebind = blockedReasonAfterRebind(baseBlockedReason, resolved)
    if (blockedAfterRebind) {
      return buildCoreviewResult({
        action: "set_view",
        source,
        current: before,
        ok: false,
        blockedReason: blockedAfterRebind,
        resultSummary: blockedSummary(blockedAfterRebind),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        ...resolved.rebind,
      })
    }

    const normalized = normalizeSetViewInput(input, before)
    if (normalized.ok === false) {
      const blockedReason = normalized.blockedReason
      return buildCoreviewResult({
        action: "set_view",
        source,
        current: before,
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        ...resolved.rebind,
      })
    }

    const expectedViewSignature = buildArtifactViewSignature({
      artifactId: before.artifactId,
      filePath: before.artifactPath,
      rendererKind: before.rendererKind,
      pageIndex: normalized.pageIndex,
      pageCount: before.pageCount,
      zoom: normalized.zoom,
      fitMode: normalized.fitMode,
    })
    const changed = expectedViewSignature !== before.viewSignature

    if (changed && before.reviewHasFrame) {
      adapter.markViewStale(expectedViewSignature)
    }
    const htmlScrollAttempted = before.rendererKind === "html" && (
      normalized.htmlScrollDelta !== null
      || Boolean(normalized.htmlScrollPosition)
    )
    const htmlNavigationSource = source === "gemini_tool" ? "tool" : input.reason?.includes("voice command") ? "voice" : "manual"
    const setViewResult = await adapter.setView({
      ...normalized,
      htmlNavigationSource,
    })
    const structuredSetViewResult = isCoreviewSetViewAdapterResult(setViewResult)
      ? setViewResult
      : null
    if (htmlScrollAttempted && structuredSetViewResult?.ok === false) {
      const afterFailedScroll = adapter.getCurrentViewState()
      return buildCoreviewResult({
        action: "set_view",
        source,
        current: afterFailedScroll,
        ok: false,
        blockedReason: structuredSetViewResult.blockedReason ?? "section_not_found",
        resultSummary: blockedSummary(structuredSetViewResult.blockedReason ?? "section_not_found"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: afterFailedScroll.viewSignature,
        htmlScrollAttempted,
        htmlScrollResult: structuredSetViewResult.blockedReason ?? "failed",
        htmlNavigation: htmlNavigationTelemetryFromAdapterResult(structuredSetViewResult, {
          commandKind: htmlNavigationCommandKindForSetView(normalized.htmlScrollDelta, normalized.htmlScrollPosition),
          fallbackResult: structuredSetViewResult.blockedReason ?? "failed",
        }),
        ...resolved.rebind,
      })
    }

    const ready = await adapter.waitForViewReady(expectedViewSignature)
    if (!ready.ok) {
      return buildCoreviewResult({
        action: "set_view",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason: ready.blockedReason ?? "view_ready_timeout",
        resultSummary: blockedSummary(ready.blockedReason ?? "view_ready_timeout"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: ready.waitMs,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        ...resolved.rebind,
      })
    }

    const readyView = adapter.getCurrentViewState()
    let refreshAttempted = false
    let refreshResult: CoreviewToolRefreshResult = "not_requested"
    let blockedReason: CoreviewToolBlockedReason | null = null
    let refreshSummary = ""
    let forceVisualFrameFresh: boolean | null = null
    let forceStale: boolean | null = null

    if (readyView.canRefresh) {
      refreshAttempted = true
      const refresh = await adapter.refreshView({ reason: input.reason })
      refreshResult = normalizeSetViewRefreshResult(refresh.refreshResult)
      blockedReason = refresh.ok ? null : refresh.blockedReason ?? "refresh_unavailable"
      if (refresh.ok) {
        adapter.clearViewStale(expectedViewSignature)
        forceVisualFrameFresh = true
        forceStale = false
        refreshSummary = " Refresh succeeded."
      } else {
        forceVisualFrameFresh = false
        forceStale = changed && before.reviewHasFrame ? true : null
        refreshSummary = " Visual refresh failed."
      }
    } else if (readyView.reviewActive || readyView.reviewHasFrame || changed) {
      refreshResult = "unavailable"
      blockedReason = readyView.reviewActive ? "refresh_unavailable" : "review_not_active"
      forceVisualFrameFresh = false
      forceStale = changed && readyView.reviewHasFrame ? true : null
      refreshSummary = readyView.reviewActive
        ? " Visual refresh unavailable."
        : " Visual review is not active."
    }

    const after = adapter.getCurrentViewState()
    return buildCoreviewResult({
      action: "set_view",
      source,
      current: after,
      ok: true,
      blockedReason,
      resultSummary: htmlScrollAttempted
        ? `Scrolled the HTML document.${refreshSummary}`
        : `Switched to ${pageSummary(after)}.${refreshSummary}`,
      refreshAttempted,
      refreshResult,
      viewReadyWaitMs: ready.waitMs,
      viewSignatureBefore: initialBefore.viewSignature,
      viewSignatureAfter: after.viewSignature,
      staleOverride: forceStale,
      visualFrameFreshOverride: forceVisualFrameFresh,
      htmlScrollAttempted,
      htmlScrollResult: htmlScrollAttempted
        ? structuredSetViewResult?.htmlNavigationResult ?? (structuredSetViewResult?.ok === false ? structuredSetViewResult.blockedReason ?? "failed" : "success")
        : null,
      htmlNavigation: htmlNavigationTelemetryFromAdapterResult(structuredSetViewResult, {
        commandKind: htmlScrollAttempted
          ? htmlNavigationCommandKindForSetView(normalized.htmlScrollDelta, normalized.htmlScrollPosition)
          : null,
        fallbackResult: htmlScrollAttempted ? "success" : null,
      }),
      ...resolved.rebind,
    })
  }

  const addAnnotation = async (
    input: CoreviewAddAnnotationInput,
    source: CoreviewToolCommandSource,
  ): Promise<CoreviewActionResult> => {
    const initialBefore = adapter.getCurrentViewState()
    const resolved = resolveCurrentViewWithRebind({
      adapter,
      current: initialBefore,
      requestedArtifactId: input.artifactId ?? null,
      blockedReason: currentViewBlockedReason(initialBefore, input.artifactId),
    })
    const before = resolved.current
    const baseBlockedReason = currentViewBlockedReason(before, input.artifactId)
    const blockedAfterRebind = blockedReasonAfterRebind(baseBlockedReason, resolved)
    if (blockedAfterRebind) {
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: before,
        ok: false,
        blockedReason: blockedAfterRebind,
        resultSummary: blockedSummary(blockedAfterRebind),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        annotationKind: normalizeAnnotationKindValue(input.kind),
        annotationAnchorType: input.anchor?.type ?? null,
        annotationColor: input.color ?? null,
        annotationActionSource: input.source,
        unsupportedAnnotationKind: unsupportedAnnotationKindFromValue(input.kind),
        ...resolved.rebind,
      })
    }

    const requestedKind = normalizeAnnotationKindValue(input.kind)
    const unsupportedAnnotationKind = unsupportedAnnotationKindFromValue(input.kind)
    if (!requestedKind) {
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: before,
        ok: false,
        blockedReason: "unsupported_annotation_kind",
        resultSummary: blockedSummary("unsupported_annotation_kind"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        annotationKind: null,
        annotationAnchorType: input.anchor?.type ?? null,
        annotationColor: input.color ?? null,
        annotationActionSource: input.source,
        annotationCount: before.annotationCount,
        highlightCount: before.highlightCount,
        commentCount: before.commentCount,
        underlineCount: before.underlineCount ?? 0,
        arrowCount: before.arrowCount ?? 0,
        drawPathCount: before.drawPathCount ?? 0,
        unsupportedAnnotationKind,
        ...resolved.rebind,
      })
    }

    if (!annotationKindSupportedByCapabilities(requestedKind, before.capabilities)) {
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: before,
        ok: false,
        blockedReason: "annotations_not_supported",
        resultSummary: blockedSummary("annotations_not_supported"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        annotationKind: requestedKind,
        annotationAnchorType: input.anchor?.type ?? null,
        annotationColor: input.color ?? null,
        annotationActionSource: input.source,
        unsupportedAnnotationKind: null,
        ...resolved.rebind,
      })
    }

    if (!adapter.resolveAnnotationAnchor || !adapter.addAnnotation) {
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: before,
        ok: false,
        blockedReason: "annotation_target_unavailable",
        resultSummary: blockedSummary("annotation_target_unavailable"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        annotationKind: normalizeAnnotationKindValue(input.kind),
        annotationAnchorType: input.anchor?.type ?? null,
        annotationColor: input.color ?? null,
        annotationActionSource: input.source,
        unsupportedAnnotationKind: unsupportedAnnotationKindFromValue(input.kind),
        ...resolved.rebind,
      })
    }

    const normalized = normalizeAddAnnotationInput(input, before)
    if (normalized.ok === false) {
      const blockedReason = normalized.blockedReason
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: before,
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        annotationKind: normalizeAnnotationKindValue(input.kind),
        unsupportedAnnotationKind: normalized.unsupportedAnnotationKind ?? null,
        annotationAnchorType: input.anchor?.type ?? null,
        annotationColor: input.color ?? null,
        annotationActionSource: input.source,
        annotationCount: before.annotationCount,
        highlightCount: before.highlightCount,
        commentCount: before.commentCount,
        underlineCount: before.underlineCount ?? 0,
        arrowCount: before.arrowCount ?? 0,
        drawPathCount: before.drawPathCount ?? 0,
        ...resolved.rebind,
      })
    }

    const resolvedAnchor = adapter.resolveAnnotationAnchor({
      anchor: normalized.anchor,
      pageIndex: normalized.pageIndex,
    })
    if (resolvedAnchor.ok === false) {
      const blockedReason = resolvedAnchor.blockedReason
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        annotationKind: normalized.kind,
        annotationAnchorType: normalized.anchor.type,
        annotationColor: normalized.color,
        annotationActionSource: normalized.source,
        ...resolved.rebind,
      })
    }

    const annotationTarget = annotationTargetFromResolvedAnchor(normalized.kind, resolvedAnchor.anchor)
    if (annotationTarget.ok === false) {
      const blockedReason = annotationTarget.blockedReason
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        annotationKind: normalized.kind,
        annotationAnchorType: normalized.anchor.type,
        annotationColor: normalized.color,
        annotationActionSource: normalized.source,
        ...resolved.rebind,
      })
    }

    const annotationCountBefore = before.annotationCount
    const kindCountBefore = annotationKindCount(before, normalized.kind)
    const added = adapter.addAnnotation({
      kind: normalized.kind,
      pageIndex: normalized.pageIndex,
      anchor: resolvedAnchor.anchor,
      rect: annotationTarget.rect,
      point: annotationTarget.point,
      line: annotationTarget.line,
      color: normalized.color,
      text: normalized.text,
      source: normalized.source,
    })
    const annotationCountAfter = added.annotationCount
    const kindCountAfter = annotationKindCount(added, normalized.kind)
    const commitVerified = Boolean(
      added.ok
      && added.annotationId
      && annotationCountAfter > annotationCountBefore
      && kindCountAfter > kindCountBefore,
    )
    if (!added.ok || !commitVerified) {
      const blockedReason = added.blockedReason ?? "annotation_commit_failed"
      return buildCoreviewResult({
        action: "add_annotation",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        annotationKind: normalized.kind,
        annotationAnchorType: normalized.anchor.type,
        annotationColor: normalized.color,
        annotationPageIndex: normalized.pageIndex,
        annotationActionSource: normalized.source,
        annotationCount: added.annotationCount,
        highlightCount: added.highlightCount,
        commentCount: added.commentCount,
        underlineCount: added.underlineCount ?? 0,
        arrowCount: added.arrowCount ?? 0,
        drawPathCount: added.drawPathCount ?? 0,
        annotationCommitAttempted: true,
        annotationCommitResult: blockedReason,
        annotationCommitCountBefore: annotationCountBefore,
        annotationCommitCountAfter: annotationCountAfter,
        annotationCommitVerified: false,
        annotationCreated: false,
        ...resolved.rebind,
      })
    }

    const staleSignature = before.viewSignature
    if (before.reviewHasFrame) {
      adapter.markViewStale(staleSignature)
    }
    const ready = await adapter.waitForViewReady(staleSignature)
    const readyView = adapter.getCurrentViewState()
    let refreshAttempted = false
    let refreshResult: CoreviewToolRefreshResult = "not_requested"
    let blockedReason: CoreviewToolBlockedReason | null = null
    let visualFrameFreshOverride: boolean | null = null
    let staleOverride: boolean | null = before.reviewHasFrame ? true : null
    let refreshSummary = ""

    if (ready.ok && readyView.canRefresh) {
      refreshAttempted = true
      const refresh = await adapter.refreshView({ reason: "coreview annotation changed" })
      refreshResult = normalizeSetViewRefreshResult(refresh.refreshResult)
      blockedReason = refresh.ok ? null : refresh.blockedReason ?? "refresh_unavailable"
      if (refresh.ok) {
        adapter.clearViewStale(staleSignature)
        visualFrameFreshOverride = true
        staleOverride = false
        refreshSummary = " Refresh succeeded."
      } else {
        visualFrameFreshOverride = false
        staleOverride = before.reviewHasFrame ? true : null
        refreshSummary = " Visual refresh failed."
      }
    } else if (!ready.ok) {
      blockedReason = ready.blockedReason ?? "view_ready_timeout"
      refreshResult = "view_ready_timeout"
      visualFrameFreshOverride = false
      staleOverride = before.reviewHasFrame ? true : null
      refreshSummary = " Refresh timed out; annotation remains visible."
    } else if (readyView.reviewActive || readyView.reviewHasFrame) {
      refreshResult = "unavailable"
      blockedReason = readyView.reviewActive ? "refresh_unavailable" : "review_not_active"
      visualFrameFreshOverride = false
      staleOverride = before.reviewHasFrame ? true : null
      refreshSummary = readyView.reviewActive
        ? " Visual refresh unavailable."
        : " Visual review is not active."
    }

    const after = adapter.getCurrentViewState()
    const viewReadyTimedOut = blockedReason === "view_ready_timeout"
    return buildCoreviewResult({
      action: "add_annotation",
      source,
      current: after,
      ok: true,
      blockedReason,
      resultSummary: `${annotationSummary(normalized.kind, normalized.anchor.type, normalized.color, normalized.pageIndex)}${refreshSummary}`,
      refreshAttempted,
      refreshResult,
      viewReadyWaitMs: ready.waitMs,
      viewSignatureBefore: initialBefore.viewSignature,
      viewSignatureAfter: after.viewSignature,
      staleOverride,
      visualFrameFreshOverride,
      annotationId: added.annotationId,
      annotationKind: normalized.kind,
      annotationAnchorType: normalized.anchor.type,
      annotationColor: normalized.color,
      annotationPageIndex: normalized.pageIndex,
      annotationActionSource: normalized.source,
      annotationCount: added.annotationCount,
      highlightCount: added.highlightCount,
      commentCount: added.commentCount,
      underlineCount: added.underlineCount ?? 0,
      arrowCount: added.arrowCount ?? 0,
      drawPathCount: added.drawPathCount ?? 0,
      annotationCommitAttempted: true,
      annotationCommitResult: viewReadyTimedOut ? "partial_success" : "success",
      annotationCommitCountBefore: annotationCountBefore,
      annotationCommitCountAfter: annotationCountAfter,
      annotationCommitVerified: true,
      annotationCreated: true,
      annotationViewReadyTimedOut: viewReadyTimedOut,
      annotationPartialSuccess: viewReadyTimedOut,
      ...resolved.rebind,
    })
  }

  const focusAnchor = async (
    input: CoreviewFocusAnchorInput,
    source: CoreviewToolCommandSource,
  ): Promise<CoreviewActionResult> => {
    const initialBefore = adapter.getCurrentViewState()
    const resolved = resolveCurrentViewWithRebind({
      adapter,
      current: initialBefore,
      requestedArtifactId: input.artifactId ?? null,
      blockedReason: currentViewBlockedReason(initialBefore, input.artifactId),
    })
    const before = resolved.current
    const baseBlockedReason = currentViewBlockedReason(before, input.artifactId)
    const blockedAfterRebind = blockedReasonAfterRebind(baseBlockedReason, resolved)
    if (blockedAfterRebind) {
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: before,
        ok: false,
        blockedReason: blockedAfterRebind,
        resultSummary: blockedSummary(blockedAfterRebind),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        focusAnchorType: input.anchor?.type ?? null,
        ...resolved.rebind,
      })
    }

    const capabilityBlock = focusCapabilityBlockedReason(input.anchor ?? { type: "current_selection" }, before.capabilities)
    if (capabilityBlock) {
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: before,
        ok: false,
        blockedReason: capabilityBlock,
        resultSummary: blockedSummary(capabilityBlock),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        focusAnchorType: input.anchor?.type ?? "current_selection",
        ...resolved.rebind,
      })
    }

    if (!adapter.resolveAnnotationAnchor || !adapter.focusAnnotationAnchor) {
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: before,
        ok: false,
        blockedReason: "annotation_target_unavailable",
        resultSummary: blockedSummary("annotation_target_unavailable"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        focusAnchorType: input.anchor?.type ?? null,
        ...resolved.rebind,
      })
    }

    const normalized = normalizeFocusAnchorInput(input, before)
    if (normalized.ok === false) {
      const blockedReason = normalized.blockedReason
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: before,
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: before.viewSignature,
        focusAnchorType: input.anchor?.type ?? null,
        ...resolved.rebind,
      })
    }

    const resolvedAnchorResult = adapter.resolveAnnotationAnchor({
      anchor: normalized.anchor,
      pageIndex: normalized.pageIndex,
    })
    let resolvedAnchor: CoreviewResolvedAnnotationAnchor | null = resolvedAnchorResult.ok
      ? resolvedAnchorResult.anchor
      : null
    if (!resolvedAnchor && before.rendererKind === "html" && normalized.anchor.type === "text_quote") {
      resolvedAnchor = buildHtmlFocusTextAnchor(normalized.anchor.text, normalized.pageIndex)
    }
    if (!resolvedAnchor) {
      const blockedReason = resolvedAnchorResult.ok === false ? resolvedAnchorResult.blockedReason : "anchor_not_found"
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        focusAnchorType: normalized.anchor.type,
        ...resolved.rebind,
      })
    }
    if (!resolvedAnchor.rect && !(before.rendererKind === "html" && resolvedAnchor.text)) {
      const blockedReason: CoreviewToolBlockedReason = "anchor_not_found"
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason,
        resultSummary: blockedSummary(blockedReason),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        focusAnchorType: normalized.anchor.type,
        ...resolved.rebind,
      })
    }

    const expectedViewSignature = buildArtifactViewSignature({
      artifactId: before.artifactId,
      filePath: before.artifactPath,
      rendererKind: before.rendererKind,
      pageIndex: normalized.pageIndex,
      pageCount: before.pageCount,
      zoom: normalized.zoom,
      fitMode: normalized.fitMode,
    })
    const changed = expectedViewSignature !== before.viewSignature
    if (changed && before.reviewHasFrame) {
      adapter.markViewStale(expectedViewSignature)
    }

    const focused = await adapter.focusAnnotationAnchor({
      pageIndex: normalized.pageIndex,
      anchor: resolvedAnchor,
      zoom: normalized.zoom,
      fitMode: normalized.fitMode,
      htmlNavigationSource: source === "gemini_tool" ? "tool" : input.reason?.includes("voice command") ? "voice" : "manual",
    })
    if (!focused.ok) {
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason: focused.blockedReason ?? "annotation_target_unavailable",
        resultSummary: blockedSummary(focused.blockedReason ?? "annotation_target_unavailable"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: null,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        focusAnchorType: normalized.anchor.type,
        focusedRect: resolvedAnchor.rect,
        htmlFocusAnchorAttempted: before.rendererKind === "html",
        htmlFocusAnchorResult: before.rendererKind === "html" ? focused.blockedReason ?? "failed" : null,
        htmlFocusAnchorMethod: focused.method ?? null,
        htmlFocusAnchorScrolled: focused.scrolled ?? null,
        htmlNavigation: focused.htmlNavigation ?? null,
        ...resolved.rebind,
      })
    }

    const ready = await adapter.waitForViewReady(expectedViewSignature)
    if (!ready.ok) {
      return buildCoreviewResult({
        action: "focus_anchor",
        source,
        current: adapter.getCurrentViewState(),
        ok: false,
        blockedReason: ready.blockedReason ?? "view_ready_timeout",
        resultSummary: blockedSummary(ready.blockedReason ?? "view_ready_timeout"),
        refreshAttempted: false,
        refreshResult: "not_requested",
        viewReadyWaitMs: ready.waitMs,
        viewSignatureBefore: initialBefore.viewSignature,
        viewSignatureAfter: adapter.getCurrentViewState().viewSignature,
        focusAnchorType: normalized.anchor.type,
        focusedRect: resolvedAnchor.rect,
        ...resolved.rebind,
      })
    }

    const readyView = adapter.getCurrentViewState()
    let refreshAttempted = false
    let refreshResult: CoreviewToolRefreshResult = "not_requested"
    let blockedReason: CoreviewToolBlockedReason | null = null
    let forceVisualFrameFresh: boolean | null = null
    let forceStale: boolean | null = null
    let refreshSummary = ""

    if (readyView.canRefresh) {
      refreshAttempted = true
      const refresh = await adapter.refreshView({ reason: input.reason })
      refreshResult = normalizeSetViewRefreshResult(refresh.refreshResult)
      blockedReason = refresh.ok ? null : refresh.blockedReason ?? "refresh_unavailable"
      if (refresh.ok) {
        adapter.clearViewStale(expectedViewSignature)
        forceVisualFrameFresh = true
        forceStale = false
        refreshSummary = " Refresh succeeded."
      } else {
        forceVisualFrameFresh = false
        forceStale = changed && before.reviewHasFrame ? true : null
        refreshSummary = " Visual refresh failed."
      }
    } else if (readyView.reviewActive || readyView.reviewHasFrame || changed) {
      refreshResult = "unavailable"
      blockedReason = readyView.reviewActive ? "refresh_unavailable" : "review_not_active"
      forceVisualFrameFresh = false
      forceStale = changed && readyView.reviewHasFrame ? true : null
      refreshSummary = readyView.reviewActive
        ? " Visual refresh unavailable."
        : " Visual review is not active."
    }

    const after = adapter.getCurrentViewState()
    return buildCoreviewResult({
      action: "focus_anchor",
      source,
      current: after,
      ok: true,
      blockedReason,
      resultSummary: before.rendererKind === "html"
        ? `Focused the HTML section.${refreshSummary}`
        : `Focused ${anchorLabel(normalized.anchor.type)} on ${pageSummary(after)}.${refreshSummary}`,
      refreshAttempted,
      refreshResult,
      viewReadyWaitMs: ready.waitMs,
      viewSignatureBefore: initialBefore.viewSignature,
      viewSignatureAfter: after.viewSignature,
      staleOverride: forceStale,
      visualFrameFreshOverride: forceVisualFrameFresh,
      focusAnchorType: normalized.anchor.type,
      focusedRect: resolvedAnchor.rect,
      htmlFocusAnchorAttempted: before.rendererKind === "html",
      htmlFocusAnchorResult: before.rendererKind === "html" ? "success" : null,
      htmlFocusAnchorMethod: focused.method ?? null,
      htmlFocusAnchorScrolled: focused.scrolled ?? null,
      htmlNavigation: focused.htmlNavigation ?? null,
      ...resolved.rebind,
    })
  }

  return {
    setView,
    refreshView,
    getCurrentView,
    addAnnotation,
    focusAnchor,
    handleToolCall(call) {
      if (call.name === COREVIEW_SET_VIEW_TOOL_NAME) {
        return setView(coreviewSetViewInputFromArgs(call.args), "gemini_tool")
      }
      if (call.name === COREVIEW_REFRESH_VIEW_TOOL_NAME) {
        return refreshView(coreviewRefreshViewInputFromArgs(call.args), "gemini_tool")
      }
      if (call.name === COREVIEW_GET_CURRENT_VIEW_TOOL_NAME) {
        return Promise.resolve(getCurrentView(coreviewGetCurrentViewInputFromArgs(call.args), "gemini_tool"))
      }
      if (call.name === COREVIEW_ADD_ANNOTATION_TOOL_NAME) {
        return addAnnotation(coreviewAddAnnotationInputFromArgs(call.args), "gemini_tool")
      }
      return focusAnchor(coreviewFocusAnchorInputFromArgs(call.args), "gemini_tool")
    },
  }
}

export type CoreviewToolBridgeHandler = (call: CoreviewToolCallInput) => Promise<CoreviewActionResult> | CoreviewActionResult

let activeToolBridge: CoreviewToolBridgeHandler | null = null
let recentHandledToolActions: Array<{ toolName: CoreviewToolName; handledAt: number; result: CoreviewActionResult }> = []
const MAX_RECENT_HANDLED_TOOL_ACTIONS = 12

export function registerCoreviewToolBridge(handler: CoreviewToolBridgeHandler): () => void {
  activeToolBridge = handler
  return () => {
    if (activeToolBridge === handler) {
      activeToolBridge = null
    }
  }
}

export async function executeCoreviewToolBridgeCall(call: CoreviewToolCallInput): Promise<CoreviewActionResult> {
  if (!activeToolBridge) {
    return unavailableToolResult(call.name)
  }

  const result = await activeToolBridge(call)
  recentHandledToolActions = [
    ...recentHandledToolActions.slice(-(MAX_RECENT_HANDLED_TOOL_ACTIONS - 1)),
    {
      toolName: call.name,
      handledAt: Date.now(),
      result,
    },
  ]
  return result
}

export function wasRecentCoreviewToolActionHandled(params: {
  toolName?: CoreviewToolName
  sinceMs: number
  windowMs?: number
  matchResult?: (result: CoreviewActionResult) => boolean
}): boolean {
  if (recentHandledToolActions.length === 0) {
    return false
  }
  const windowMs = params.windowMs ?? 2200
  return recentHandledToolActions.some((entry) => {
    if (params.toolName && entry.toolName !== params.toolName) {
      return false
    }
    if (entry.handledAt < params.sinceMs || Date.now() - entry.handledAt > windowMs) {
      return false
    }
    return params.matchResult ? params.matchResult(entry.result) : true
  })
}

export function clearCoreviewToolBridgeForTests(): void {
  activeToolBridge = null
  recentHandledToolActions = []
}

export function isCoreviewToolName(name: string | null | undefined): name is CoreviewToolName {
  return COREVIEW_TOOL_NAMES.includes(name as CoreviewToolName)
}

export function coreviewGeminiFunctionDeclarations(): Record<string, unknown>[] {
  return [
    {
      name: COREVIEW_SET_VIEW_TOOL_NAME,
      description: "Set the active Coreview artifact view during Review with Sophia. Use page fields for PDF page navigation, zoom fields for generic zoom changes, and html_scroll_delta/html_scroll_position for HTML document scrolling. For zoom/focus on a specific title, text, selection, section, or area, use coreview_focus_anchor instead. Wait for the app result before acknowledging.",
      parameters: {
        type: "OBJECT",
        properties: {
          artifact_id: { type: "STRING", description: "Optional active artifact id. Omit when using the currently selected artifact." },
          page_index: { type: "NUMBER", description: "Zero-based page index for PDF page navigation." },
          page_number: { type: "NUMBER", description: "One-based user-facing PDF page number." },
          page_label: { type: "STRING", description: "Optional user-facing PDF page label." },
          zoom: { type: "NUMBER", description: "Zoom multiplier, for example 1.2." },
          fit_mode: { type: "STRING", enum: ["page", "width", "custom"], description: "View fit mode." },
          html_scroll_delta: { type: "NUMBER", description: "HTML-only vertical document scroll delta in pixels. Positive scrolls down; negative scrolls up." },
          html_scroll_position: { type: "STRING", enum: ["top", "bottom"], description: "HTML-only document scroll target." },
          reason: { type: "STRING", description: "Short safe reason for the view change." },
        },
        required: [],
      },
    },
    {
      name: COREVIEW_REFRESH_VIEW_TOOL_NAME,
      description: "Refresh Sophia's still-frame view of the active Coreview artifact without changing artifact contents. Use only for requests like \"refresh your view\" or \"refresh your page\". Do not use this as a substitute for highlights, marks, notes, comments, pins, flags, callouts, or other annotations.",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "Short safe reason for refreshing the current view." },
        },
        required: [],
      },
    },
    {
      name: COREVIEW_GET_CURRENT_VIEW_TOOL_NAME,
      description: "Get safe metadata about what Sophia can currently see in the active Coreview artifact. Prefer this for simple visibility or current-page questions. Returns no raw artifact text, comments, or visual frame.",
      parameters: {
        type: "OBJECT",
        properties: {
          artifact_id: { type: "STRING", description: "Optional active artifact id to verify." },
        },
        required: [],
      },
    },
    {
      name: COREVIEW_ADD_ANNOTATION_TOOL_NAME,
      description: "Required for annotation intents during Review with Sophia. For any user request containing highlight, mark, underline, arrow, annotate, note, comment, pin, flag, or callout, call this tool. Do not use coreview_refresh_view as a substitute. Do not say an annotation was added unless this tool returned ok=true. Examples: \"Highlight it yellow\" -> kind=highlight, anchor_type=current_title or current_selection, color=yellow. \"Underline the title\" -> kind=underline, anchor_type=current_title. \"Add an arrow pointing to this\" -> kind=arrow, anchor_type=current_selection or current_title. \"Leave a comment: change the font\" -> kind=comment, anchor_type=current_title, comment_text=\"change the font\". \"Highlight the title yellow and comment change the font\" -> call this tool twice, once for highlight and once for comment.",
      parameters: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: ["highlight", "comment", "underline", "arrow"], description: "Annotation kind to add. Use highlight for highlight/mark/flag/callout requests; underline for underline requests; arrow for arrow/pointer requests; comment for comment/note/pin text requests." },
          anchor_type: { type: "STRING", enum: ["current_title", "current_selection", "text_quote", "rect", "point"], description: "What to attach the annotation to. For \"it\" after focusing or discussing the title, prefer current_title. For selected visible text, use current_selection. Use text_quote only when the user names exact text." },
          artifact_id: { type: "STRING", description: "Optional active artifact id. Omit when using the currently selected artifact." },
          page_number: { type: "NUMBER", description: "Optional one-based user-facing page number." },
          page_index: { type: "NUMBER", description: "Optional zero-based page index." },
          text_quote: { type: "STRING", description: "Text to find when anchor_type is text_quote." },
          occurrence: { type: "NUMBER", description: "One-based occurrence for text_quote; defaults to 1." },
          color: { type: "STRING", enum: ["yellow", "purple", "blue", "pink"], description: "Annotation color. Defaults to yellow for highlights/comments and purple for underlines/arrows; \"Highlight it yellow\" must pass color=yellow." },
          comment_text: { type: "STRING", description: "Comment text for comment annotations. Required for user requests like \"Leave a comment: change the font\". Do not include raw comment text in telemetry." },
          note: { type: "STRING", description: "Alias for comment_text when the user says note." },
          rect: {
            type: "OBJECT",
            description: "Normalized page rectangle for rect anchors.",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              width: { type: "NUMBER" },
              height: { type: "NUMBER" },
            },
            required: [],
          },
          point: {
            type: "OBJECT",
            description: "Normalized page point for point anchors.",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
            },
            required: [],
          },
        },
        required: ["kind", "anchor_type"],
      },
    },
    {
      name: COREVIEW_FOCUS_ANCHOR_TOOL_NAME,
      description: "Zoom and center the active Coreview artifact around a text or coordinate anchor during Review with Sophia. For \"zoom/focus on X\" requests, use this tool, for example \"Zoom in on the current title\" -> anchor_type=current_title. Do not use this for highlights or comments; follow annotation requests with coreview_add_annotation.",
      parameters: {
        type: "OBJECT",
        properties: {
          anchor_type: { type: "STRING", enum: ["current_title", "current_selection", "text_quote", "rect", "point"], description: "Anchor to focus." },
          artifact_id: { type: "STRING", description: "Optional active artifact id. Omit when using the currently selected artifact." },
          page_number: { type: "NUMBER", description: "Optional one-based user-facing page number." },
          page_index: { type: "NUMBER", description: "Optional zero-based page index." },
          text_quote: { type: "STRING", description: "Text to find when anchor_type is text_quote." },
          occurrence: { type: "NUMBER", description: "One-based occurrence for text_quote; defaults to 1." },
          zoom: { type: "NUMBER", description: "Target zoom multiplier." },
          zoom_delta: { type: "NUMBER", description: "Zoom multiplier delta relative to current zoom." },
          fit_mode: { type: "STRING", enum: ["custom"], description: "Focus uses custom fit mode." },
          rect: {
            type: "OBJECT",
            description: "Normalized page rectangle for rect anchors.",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
              width: { type: "NUMBER" },
              height: { type: "NUMBER" },
            },
            required: [],
          },
          point: {
            type: "OBJECT",
            description: "Normalized page point for point anchors.",
            properties: {
              x: { type: "NUMBER" },
              y: { type: "NUMBER" },
            },
            required: [],
          },
        },
        required: ["anchor_type"],
      },
    },
  ]
}

export function withCoreviewGeminiToolDeclarations(
  setup: Record<string, unknown>,
  enabled: boolean,
  options: {
    allowArtifactCreation?: boolean
    builderActionsEnabled?: boolean
    allowGenericBuilderTools?: boolean
  } = {},
): Record<string, unknown> {
  if (!enabled) {
    return setup
  }

  const existingTools = Array.isArray(setup.tools) ? setup.tools : []
  const nextTools = existingTools.map((tool) => (
    isRecord(tool) ? { ...tool } : tool
  ))
  if (options.allowArtifactCreation !== true) {
    for (const tool of nextTools) {
      if (!isRecord(tool)) {
        continue
      }
      if (Array.isArray(tool.functionDeclarations)) {
        tool.functionDeclarations = filterArtifactCreationDeclarations(tool.functionDeclarations)
      }
      if (Array.isArray(tool.function_declarations)) {
        tool.function_declarations = filterArtifactCreationDeclarations(tool.function_declarations)
      }
    }
  }
  if (options.builderActionsEnabled !== false && options.allowGenericBuilderTools !== true) {
    for (const tool of nextTools) {
      if (!isRecord(tool)) {
        continue
      }
      if (Array.isArray(tool.functionDeclarations)) {
        tool.functionDeclarations = filterGenericBuilderDeclarations(tool.functionDeclarations)
      }
      if (Array.isArray(tool.function_declarations)) {
        tool.function_declarations = filterGenericBuilderDeclarations(tool.function_declarations)
      }
    }
  }
  const toolWithDeclarations = nextTools.find((tool): tool is Record<string, unknown> => (
    isRecord(tool) && Array.isArray(tool.functionDeclarations)
  ))
  const declarations = [
    ...(options.builderActionsEnabled === false ? [] : coreviewBuilderGeminiFunctionDeclarations()),
    ...coreviewGeminiFunctionDeclarations(),
  ]

  if (toolWithDeclarations) {
    const functionDeclarations = Array.isArray(toolWithDeclarations.functionDeclarations)
      ? toolWithDeclarations.functionDeclarations
      : []
    const existingDeclarations = functionDeclarations
      .filter(isRecord)
      .map((declaration) => ({ ...declaration }))
    const existingNames = new Set(existingDeclarations.map((declaration) => (
      typeof declaration.name === "string" ? declaration.name : ""
    )))
    toolWithDeclarations.functionDeclarations = [
      ...existingDeclarations,
      ...declarations.filter((declaration) => !existingNames.has(String(declaration.name))),
    ]
    return {
      ...setup,
      tools: nextTools,
    }
  }

  return {
    ...setup,
    tools: [
      ...nextTools,
      { functionDeclarations: declarations },
    ],
  }
}

function currentViewBlockedReason(
  current: CoreviewCurrentView,
  artifactId?: string,
): CoreviewToolBlockedReason | null {
  if (!current.artifactId) {
    return "no_selected_artifact"
  }
  if (artifactId && artifactId !== current.artifactId) {
    return "artifact_mismatch"
  }
  if (current.rendererKind === "unsupported" || !current.capabilities.canRender) {
    return "unsupported_renderer"
  }
  return null
}

type CoreviewRebindMetadata = Pick<
  Parameters<typeof buildCoreviewResult>[0],
  "rebindAttempted" | "rebindResult" | "rebindReason" | "rebindStatus"
>

function resolveCurrentViewWithRebind({
  adapter,
  current,
  requestedArtifactId,
  blockedReason,
}: {
  adapter: CoreviewRendererAdapter
  current: CoreviewCurrentView
  requestedArtifactId: string | null
  blockedReason: CoreviewToolBlockedReason | null
}): {
  current: CoreviewCurrentView
  rebind: CoreviewRebindMetadata
} {
  const defaultRebind: CoreviewRebindMetadata = {
    rebindAttempted: false,
    rebindResult: current.rebindStatus ?? "not_attempted",
    rebindReason: null,
    rebindStatus: current.rebindStatus ?? "not_attempted",
  }

  if (
    !adapter.rebindVisibleArtifact
    || (blockedReason !== "no_selected_artifact" && blockedReason !== "artifact_mismatch")
  ) {
    return { current, rebind: defaultRebind }
  }

  const result = adapter.rebindVisibleArtifact({
    source: "coreview_tool",
    reason: blockedReason,
    requestedArtifactId,
  })
  const reboundCurrent = result.currentView ?? adapter.getCurrentViewState()

  return {
    current: reboundCurrent,
    rebind: {
      rebindAttempted: true,
      rebindResult: result.status,
      rebindReason: result.reason,
      rebindStatus: result.status,
    },
  }
}

function blockedReasonAfterRebind(
  blockedReason: CoreviewToolBlockedReason | null,
  resolved: { rebind: CoreviewRebindMetadata },
): CoreviewToolBlockedReason | null {
  if (!blockedReason || !resolved.rebind.rebindAttempted) {
    return blockedReason
  }

  if (resolved.rebind.rebindResult === "failed") {
    return resolved.rebind.rebindReason === "artifact_not_available_in_current_session"
      ? "artifact_not_available_in_current_session"
      : "artifact_rebind_failed"
  }

  if (blockedReason === "no_selected_artifact" || blockedReason === "artifact_mismatch") {
    return "artifact_rebind_required"
  }

  return blockedReason
}

function normalizeSetViewInput(
  input: CoreviewSetViewInput,
  current: CoreviewCurrentView,
): (
  | { ok: true; pageIndex: number; zoom: number; fitMode: ArtifactFitMode; htmlScrollDelta?: number | null; htmlScrollPosition?: "top" | "bottom" | null }
  | { ok: false; blockedReason: CoreviewToolBlockedReason }
) {
  let pageIndex = current.pageIndex
  if (typeof input.pageIndex === "number" && Number.isFinite(input.pageIndex)) {
    pageIndex = Math.floor(input.pageIndex)
  } else if (typeof input.pageNumber === "number" && Number.isFinite(input.pageNumber)) {
    pageIndex = Math.floor(input.pageNumber) - 1
  } else if (input.pageLabel) {
    const parsed = Number.parseInt(input.pageLabel.replace(/[^0-9]/gu, ""), 10)
    if (Number.isFinite(parsed)) {
      pageIndex = parsed - 1
    }
  }

  const pageRequested = typeof input.pageIndex === "number"
    || typeof input.pageNumber === "number"
    || Boolean(input.pageLabel)
  if (pageRequested && !current.capabilities.supportsPages) {
    return { ok: false, blockedReason: "pages_not_supported" }
  }
  if (pageRequested && (pageIndex < 0 || pageIndex >= Math.max(1, current.pageCount))) {
    return { ok: false, blockedReason: "requested_page_out_of_bounds" }
  }

  const zoomRequested = typeof input.zoom === "number" || typeof input.fitMode === "string"
  if (zoomRequested && !current.capabilities.supportsZoom) {
    return { ok: false, blockedReason: "zoom_not_supported" }
  }

  const htmlScrollDelta = typeof input.htmlScrollDelta === "number" && Number.isFinite(input.htmlScrollDelta)
    ? input.htmlScrollDelta
    : null
  const htmlScrollPosition = input.htmlScrollPosition === "top" || input.htmlScrollPosition === "bottom"
    ? input.htmlScrollPosition
    : null
  if ((htmlScrollDelta !== null || htmlScrollPosition) && current.rendererKind !== "html") {
    return { ok: false, blockedReason: "layout_anchor_not_supported" }
  }

  const fitMode = current.rendererKind === "html" && input.fitMode === "page"
    ? "width"
    : input.fitMode ?? current.fitMode
  const zoom = typeof input.zoom === "number" && Number.isFinite(input.zoom)
    ? clampArtifactZoom(input.zoom)
    : fitMode === "custom"
      ? current.zoom
      : 1

  return { ok: true, pageIndex, zoom, fitMode, htmlScrollDelta, htmlScrollPosition }
}

function buildCoreviewResult(params: {
  action: CoreviewActionName
  source: CoreviewToolCommandSource
  current: CoreviewCurrentView
  ok: boolean
  blockedReason: CoreviewToolBlockedReason | null
  resultSummary: string
  refreshAttempted: boolean
  refreshResult: CoreviewToolRefreshResult
  viewReadyWaitMs: number | null
  viewSignatureBefore: string | null
  viewSignatureAfter: string | null
  staleOverride?: boolean | null
  visualFrameFreshOverride?: boolean | null
  rebindAttempted?: boolean
  rebindResult?: CoreviewArtifactRebindStatus
  rebindReason?: string | null
  rebindStatus?: CoreviewArtifactRebindStatus
  annotationId?: string | null
  annotationKind?: CoreviewAnnotationKind | null
  annotationAnchorType?: CoreviewAnnotationAnchor["type"] | null
  annotationColor?: CoreviewAnnotationColor | null
  annotationPageIndex?: number | null
  annotationActionSource?: "sophia" | "user" | null
  annotationCount?: number | null
  highlightCount?: number | null
  commentCount?: number | null
  underlineCount?: number | null
  arrowCount?: number | null
  drawPathCount?: number | null
  unsupportedAnnotationKind?: string | null
  annotationCommitAttempted?: boolean
  annotationCommitResult?: CoreviewAnnotationCommitResult | null
  annotationCommitCountBefore?: number | null
  annotationCommitCountAfter?: number | null
  annotationCommitVerified?: boolean
  annotationCreated?: boolean | null
  annotationViewReadyTimedOut?: boolean
  annotationPartialSuccess?: boolean
  focusAnchorType?: CoreviewAnnotationAnchor["type"] | null
  focusedRect?: CoreviewNormalizedRect | null
  htmlScrollAttempted?: boolean
  htmlScrollResult?: string | null
  htmlFocusAnchorAttempted?: boolean
  htmlFocusAnchorResult?: string | null
  htmlFocusAnchorMethod?: string | null
  htmlFocusAnchorScrolled?: boolean | null
  htmlNavigation?: CoreviewHtmlNavigationTelemetry | null
}): CoreviewActionResult {
  const current = params.current
  const stale = params.staleOverride ?? current.stale
  const visualFrameFresh = params.visualFrameFreshOverride ?? current.visualFrameFresh
  const rebindAttempted = params.rebindAttempted ?? false
  const rebindResult = params.rebindResult ?? current.rebindStatus ?? "not_attempted"
  const rebindStatus = params.rebindStatus ?? current.rebindStatus ?? rebindResult
  const capabilitySummary = buildCoreviewCapabilitySummary({
    capabilities: current.capabilities,
    rendererKind: current.rendererKind,
    pageIndex: current.pageIndex,
    pageCount: current.pageCount,
  })
  const annotationOverlayCaptured = params.annotationCount !== undefined && params.annotationCount !== null
    ? params.annotationCount > 0
    : current.annotationOverlayCaptured
  return {
    ok: params.ok,
    action: params.action,
    artifact_id: current.artifactId,
    artifact_path: current.artifactPath,
    artifact_title: current.artifactTitle,
    renderer_kind: current.rendererKind,
    coreview_workspace_contract_version: COREVIEW_WORKSPACE_CONTRACT_VERSION,
    capability_summary: capabilitySummary,
    page_index: current.pageIndex,
    page_number: current.pageIndex + 1,
    page_count: current.pageCount,
    zoom: clampArtifactZoom(current.zoom),
    fit_mode: current.fitMode,
    scroll_top: current.scrollTop ?? null,
    scroll_height: current.scrollHeight ?? null,
    document_height: current.documentHeight ?? null,
    viewport_height: current.viewportHeight ?? null,
    viewport_width: current.viewportWidth ?? null,
    scale: current.scale ?? current.zoom,
    visible_text_summary: current.visibleTextSummary ?? null,
    visible_headings: current.visibleHeadings ?? [],
    current_section: current.currentSection ?? null,
    html_bridge_ready: current.htmlBridgeReady ?? null,
    html_section_index_ready: current.htmlSectionIndexReady ?? null,
    html_section_index_entry_count: current.htmlSectionIndexEntryCount ?? null,
    html_section_index_build_result: current.htmlSectionIndexBuildResult ?? null,
    still_frame_available: current.stillFrameAvailable ?? current.reviewHasFrame,
    html_scroll_attempted: params.htmlScrollAttempted ?? false,
    html_scroll_result: params.htmlScrollResult ?? null,
    html_focus_anchor_attempted: params.htmlFocusAnchorAttempted ?? false,
    html_focus_anchor_result: params.htmlFocusAnchorResult ?? null,
    html_focus_anchor_method: params.htmlFocusAnchorMethod ?? null,
    html_focus_anchor_scrolled: params.htmlFocusAnchorScrolled ?? null,
    navigation_model: current.rendererKind === "html" ? "scroll_document" : current.capabilities.supportsPages ? "page" : null,
    html_navigation_controller_active: params.htmlNavigation?.htmlNavigationControllerActive ?? null,
    html_navigation_router_used: params.htmlNavigation?.htmlNavigationRouterUsed ?? null,
    html_navigation_command_kind: params.htmlNavigation?.htmlNavigationCommandKind ?? null,
    html_navigation_target_safe: params.htmlNavigation?.htmlNavigationTargetSafe ?? null,
    html_navigation_target_kind: params.htmlNavigation?.htmlNavigationTargetKind ?? null,
    html_navigation_result: params.htmlNavigation?.htmlNavigationResult ?? null,
    html_navigation_failure_reason: params.htmlNavigation?.htmlNavigationFailureReason ?? null,
    html_navigation_scroll_top_before: params.htmlNavigation?.htmlNavigationScrollTopBefore ?? null,
    html_navigation_scroll_top_after: params.htmlNavigation?.htmlNavigationScrollTopAfter ?? null,
    html_navigation_scrolled: params.htmlNavigation?.htmlNavigationScrolled ?? null,
    html_navigation_command_id: params.htmlNavigation?.htmlNavigationCommandId ?? null,
    html_navigation_timed_out: params.htmlNavigation?.htmlNavigationTimedOut ?? null,
    html_navigation_waited_for_ready: params.htmlNavigation?.htmlNavigationWaitedForReady ?? null,
    html_navigation_feedback_emitted: params.htmlNavigation?.htmlNavigationFeedbackEmitted ?? null,
    html_navigation_prevented_pdf_fallback: params.htmlNavigation?.htmlNavigationPreventedPdfFallback ?? null,
    html_navigation_blocked_generic_tool_count: params.htmlNavigation?.htmlNavigationBlockedGenericToolCount ?? null,
    html_internal_navigation_used_same_resolver: params.htmlNavigation?.htmlInternalNavigationUsedSameResolver ?? null,
    html_voice_navigation_used_same_resolver: params.htmlNavigation?.htmlVoiceNavigationUsedSameResolver ?? null,
    html_navigation_suppressed_emit_artifact: params.htmlNavigation?.htmlNavigationSuppressedEmitArtifact ?? null,
    html_navigation_suppressed_builder_tool: params.htmlNavigation?.htmlNavigationSuppressedBuilderTool ?? null,
    html_navigation_result_confirmed_before_feedback: params.htmlNavigation?.htmlNavigationResultConfirmedBeforeFeedback ?? null,
    view_signature: current.viewSignature,
    stale,
    refresh_attempted: params.refreshAttempted,
    refresh_result: params.refreshResult,
    blocked_reason: params.blockedReason,
    result_summary: params.resultSummary,
    command_source: params.source,
    preserved_mic: true,
    preserved_review: true,
    view_ready_wait_ms: params.viewReadyWaitMs,
    view_signature_before: params.viewSignatureBefore,
    view_signature_after: params.viewSignatureAfter,
    exact_text_available: current.exactTextAvailable,
    visual_frame_fresh: visualFrameFresh,
    visual_fresh: visualFrameFresh,
    frame_sent: current.reviewHasFrame,
    review_active: current.reviewActive,
    current_view_summary: currentViewSummary(current),
    annotation_overlay_captured: annotationOverlayCaptured,
    annotation_id: params.annotationId ?? null,
    annotation_kind: params.annotationKind ?? null,
    annotation_anchor_type: params.annotationAnchorType ?? null,
    annotation_color: params.annotationColor ?? null,
    annotation_page_index: params.annotationPageIndex ?? null,
    annotation_count: params.annotationCount ?? null,
    highlight_count: params.highlightCount ?? null,
    comment_count: params.commentCount ?? null,
    underline_count: params.underlineCount ?? null,
    arrow_count: params.arrowCount ?? null,
    draw_path_count: params.drawPathCount ?? null,
    unsupported_annotation_kind: params.unsupportedAnnotationKind ?? null,
    annotation_action_source: params.annotationActionSource ?? null,
    annotation_commit_attempted: params.annotationCommitAttempted ?? false,
    annotation_commit_result: params.annotationCommitResult ?? null,
    annotation_commit_count_before: params.annotationCommitCountBefore ?? null,
    annotation_commit_count_after: params.annotationCommitCountAfter ?? null,
    annotation_commit_verified: params.annotationCommitVerified ?? false,
    annotation_created: params.annotationCreated ?? null,
    annotation_view_ready_timed_out: params.annotationViewReadyTimedOut ?? false,
    annotation_partial_success: params.annotationPartialSuccess ?? false,
    focus_anchor_type: params.focusAnchorType ?? null,
    focused_rect: params.focusedRect ?? null,
    artifact_stable_identity: current.artifactStableIdentity ?? null,
    rebind_status: rebindStatus,
    rebind_attempted: rebindAttempted,
    rebind_result: rebindResult,
    rebind_reason: params.rebindReason ?? null,
    raw_comment_text_excluded: true,
    raw_artifact_text_excluded: true,
    raw_frame_excluded: true,
  }
}

function normalizeSetViewRefreshResult(result: CoreviewToolRefreshResult): CoreviewToolRefreshResult {
  if (result === "success") {
    return "success"
  }
  if (result === "not_active" || result === "refresh_unavailable" || result === "unavailable") {
    return "unavailable"
  }
  return "failed"
}

function isCoreviewSetViewAdapterResult(
  result: CoreviewSetViewAdapterResult | void | null | undefined,
): result is CoreviewSetViewAdapterResult {
  return Boolean(result && typeof result === "object" && "ok" in result)
}

function htmlNavigationTelemetryFromAdapterResult(
  result: (CoreviewSetViewAdapterResult | CoreviewFocusAnchorAdapterResult | void) | null | undefined,
  fallback: {
    commandKind?: string | null
    fallbackResult?: string | null
  } = {},
): CoreviewHtmlNavigationTelemetry | null {
  if (!result) {
    return fallback.commandKind || fallback.fallbackResult
      ? {
          htmlNavigationControllerActive: true,
          htmlNavigationRouterUsed: true,
          htmlNavigationCommandKind: fallback.commandKind ?? null,
          htmlNavigationResult: fallback.fallbackResult ?? null,
          htmlNavigationPreventedPdfFallback: true,
        }
      : null
  }
  const resultOk = "ok" in result ? result.ok : true
  const resultBlockedReason = "blockedReason" in result ? result.blockedReason : null
  const resultScrolled = "scrolled" in result ? result.scrolled ?? null : null
  const direct: CoreviewHtmlNavigationTelemetry | null = "htmlNavigation" in result
    ? result.htmlNavigation ?? null
    : isCoreviewSetViewAdapterResult(result)
      ? result
      : null
  if (!direct) {
    return fallback.commandKind || fallback.fallbackResult
      ? {
          htmlNavigationControllerActive: true,
          htmlNavigationRouterUsed: true,
          htmlNavigationCommandKind: fallback.commandKind ?? null,
          htmlNavigationResult: fallback.fallbackResult ?? (resultOk ? "success" : resultBlockedReason ?? "failed"),
          htmlNavigationFailureReason: resultOk ? null : resultBlockedReason ?? "failed",
          htmlNavigationPreventedPdfFallback: true,
        }
      : null
  }
  return {
    htmlNavigationControllerActive: direct.htmlNavigationControllerActive ?? true,
    htmlNavigationRouterUsed: direct.htmlNavigationRouterUsed ?? true,
    htmlNavigationCommandKind: direct.htmlNavigationCommandKind ?? fallback.commandKind ?? null,
    htmlNavigationTargetSafe: direct.htmlNavigationTargetSafe ?? null,
    htmlNavigationTargetKind: direct.htmlNavigationTargetKind ?? null,
    htmlNavigationResult: direct.htmlNavigationResult ?? fallback.fallbackResult ?? (resultOk ? "success" : resultBlockedReason ?? "failed"),
    htmlNavigationFailureReason: direct.htmlNavigationFailureReason ?? (resultOk ? null : resultBlockedReason ?? "failed"),
    htmlNavigationScrollTopBefore: direct.htmlNavigationScrollTopBefore ?? null,
    htmlNavigationScrollTopAfter: direct.htmlNavigationScrollTopAfter ?? null,
    htmlNavigationScrolled: direct.htmlNavigationScrolled ?? resultScrolled,
    htmlNavigationCommandId: direct.htmlNavigationCommandId ?? null,
    htmlNavigationTimedOut: direct.htmlNavigationTimedOut ?? null,
    htmlNavigationWaitedForReady: direct.htmlNavigationWaitedForReady ?? null,
    htmlNavigationFeedbackEmitted: direct.htmlNavigationFeedbackEmitted ?? null,
    htmlNavigationPreventedPdfFallback: direct.htmlNavigationPreventedPdfFallback ?? true,
    htmlNavigationBlockedGenericToolCount: direct.htmlNavigationBlockedGenericToolCount ?? null,
    htmlInternalNavigationUsedSameResolver: direct.htmlInternalNavigationUsedSameResolver ?? null,
    htmlVoiceNavigationUsedSameResolver: direct.htmlVoiceNavigationUsedSameResolver ?? null,
    htmlNavigationSuppressedEmitArtifact: direct.htmlNavigationSuppressedEmitArtifact ?? null,
    htmlNavigationSuppressedBuilderTool: direct.htmlNavigationSuppressedBuilderTool ?? null,
    htmlNavigationResultConfirmedBeforeFeedback: direct.htmlNavigationResultConfirmedBeforeFeedback ?? null,
  }
}

function htmlNavigationCommandKindForSetView(
  delta: number | null | undefined,
  position: "top" | "bottom" | null | undefined,
): string | null {
  if (typeof delta === "number" && Number.isFinite(delta)) {
    return delta >= 0 ? "scroll_down" : "scroll_up"
  }
  if (position === "top") {
    return "go_top"
  }
  if (position === "bottom") {
    return "go_bottom"
  }
  return null
}

function annotationKindCount(
  counts: Pick<CoreviewCurrentView, "highlightCount" | "commentCount" | "underlineCount" | "arrowCount" | "drawPathCount">,
  kind: CoreviewAnnotationKind,
): number {
  switch (kind) {
    case "highlight":
      return counts.highlightCount
    case "comment":
      return counts.commentCount
    case "underline":
      return counts.underlineCount ?? 0
    case "arrow":
      return counts.arrowCount ?? 0
    default:
      return 0
  }
}

function pageSummary(current: CoreviewCurrentView): string {
  if (current.rendererKind === "html") {
    const scrollTop = Math.max(0, Math.round(current.scrollTop ?? 0))
    const viewportHeight = Math.max(0, Math.round(current.viewportHeight ?? 0))
    const documentHeight = Math.max(0, Math.round(current.documentHeight ?? current.scrollHeight ?? 0))
    if (documentHeight > 0 && viewportHeight > 0) {
      return `HTML document at scroll ${scrollTop} of ${Math.max(0, documentHeight - viewportHeight)}`
    }
    return "HTML document"
  }
  return `page ${current.pageIndex + 1} of ${Math.max(1, current.pageCount)}`
}

function currentViewSummary(current: CoreviewCurrentView): string {
  if (current.rendererKind === "html") {
    const section = current.currentSection ? ` Current section is ${current.currentSection}.` : ""
    return `Current view is an HTML document.${section}`
  }
  return `Current view is ${pageSummary(current)}.`
}

function blockedSummary(reason: CoreviewToolBlockedReason): string {
  switch (reason) {
    case "no_selected_artifact":
      return "No artifact is selected."
    case "artifact_mismatch":
      return "The requested artifact is not the active Coreview artifact."
    case "artifact_rebind_required":
      return "The visible artifact needs to be rebound before Sophia can review it."
    case "artifact_rebind_failed":
      return "The visible artifact could not be rebound. Reopen the artifact, then start Review with Sophia again."
    case "artifact_not_available_in_current_session":
      return "The requested artifact is not available in the current session. Reopen it from this session thread."
    case "unsupported_pages":
    case "pages_not_supported":
      return "The active renderer does not support pages."
    case "zoom_not_supported":
      return "The active renderer does not support zoom controls."
    case "requested_page_out_of_bounds":
      return "The requested page is out of range."
    case "unsupported_renderer":
      return "The active renderer does not support that Coreview action."
    case "annotations_not_supported":
      return "Annotations are not available for this artifact format."
    case "layout_anchor_not_supported":
      return "Layout anchors are not available for this artifact format."
    case "section_not_found":
      return "Sophia could not find that section in the HTML document."
    case "iframe_not_ready":
      return "The HTML document is still loading."
    case "section_index_not_ready":
      return "The HTML document index is still loading."
    case "command_timeout":
      return "The HTML navigation command timed out."
    case "bridge_unavailable":
      return "The HTML navigation bridge is unavailable."
    case "document_unavailable":
      return "The HTML document is unavailable."
    case "cross_origin_unavailable":
      return "The HTML document cannot be inspected safely."
    case "ocr_not_available":
      return "OCR is not available yet."
    case "pptx_native_renderer_unavailable":
      return "PPTX native canvas rendering is not available yet."
    case "review_not_active":
      return "Artifact review is not active."
    case "refresh_unavailable":
      return "Sophia's visual refresh is unavailable."
    case "view_ready_timeout":
      return "The artifact view did not become ready in time."
    case "tool_unavailable":
      return "The Coreview tool bridge is unavailable."
    case "invalid_tool_args":
      return "The Coreview tool arguments were invalid."
    case "unsupported_annotation_kind":
      return "That annotation type is not available yet."
    case "anchor_not_found":
      return "Sophia could not find that anchor in the current artifact view."
    case "text_anchor_not_found":
      return "Sophia could not find that text in the current artifact view."
    case "invalid_rect":
      return "The annotation rectangle was invalid."
    case "annotation_commit_failed":
      return "Sophia could not verify that the annotation was added."
    case "annotation_target_unavailable":
      return "The active artifact renderer cannot place annotations right now."
    default:
      return "The Coreview action was blocked."
  }
}

function annotationKindSupportedByCapabilities(
  kind: CoreviewAnnotationKind,
  capabilities: CoreviewArtifactCapabilities,
): boolean {
  if (!capabilities.supportsAnnotations) {
    return false
  }
  if (kind === "comment") {
    return capabilities.supportsComments
  }
  if (kind === "underline") {
    return capabilities.supportsUnderline
  }
  if (kind === "arrow") {
    return capabilities.supportsArrow
  }
  return true
}

function focusCapabilityBlockedReason(
  anchor: CoreviewAnnotationAnchor,
  capabilities: CoreviewArtifactCapabilities,
): CoreviewToolBlockedReason | null {
  if (anchorRequiresLayoutAnchor(anchor) && !capabilities.supportsLayoutAnchors) {
    if (capabilities.fallbackReason === "pptx_native_renderer_unavailable") {
      return "pptx_native_renderer_unavailable"
    }
    if (capabilities.requiresOCR && !capabilities.supportsOCR) {
      return "ocr_not_available"
    }
    return "layout_anchor_not_supported"
  }
  if (!capabilities.supportsZoom) {
    return "zoom_not_supported"
  }
  return null
}

function anchorRequiresLayoutAnchor(anchor: CoreviewAnnotationAnchor): boolean {
  return anchor.type === "current_title"
    || anchor.type === "current_selection"
    || anchor.type === "text_quote"
}

function coreviewSetViewInputFromArgs(args: Record<string, unknown>): CoreviewSetViewInput {
  return {
    artifactId: stringFromAnyKey(args, "artifact_id", "artifactId") ?? undefined,
    pageIndex: numberFromAnyKey(args, "page_index", "pageIndex") ?? undefined,
    pageNumber: numberFromAnyKey(args, "page_number", "pageNumber") ?? undefined,
    pageLabel: stringFromAnyKey(args, "page_label", "pageLabel") ?? undefined,
    zoom: numberFromAnyKey(args, "zoom") ?? undefined,
    fitMode: fitModeFromArgs(args),
    htmlScrollDelta: numberFromAnyKey(args, "html_scroll_delta", "htmlScrollDelta") ?? undefined,
    htmlScrollPosition: htmlScrollPositionFromArgs(args),
    reason: stringFromAnyKey(args, "reason") ?? undefined,
  }
}

function coreviewRefreshViewInputFromArgs(args: Record<string, unknown>): CoreviewRefreshViewInput {
  return {
    reason: stringFromAnyKey(args, "reason") ?? undefined,
  }
}

function coreviewGetCurrentViewInputFromArgs(args: Record<string, unknown>): CoreviewGetCurrentViewInput {
  return {
    artifactId: stringFromAnyKey(args, "artifact_id", "artifactId") ?? undefined,
  }
}

function coreviewAddAnnotationInputFromArgs(args: Record<string, unknown>): CoreviewAddAnnotationInput {
  const kind = annotationKindFromArgs(args) ?? "highlight"
  return {
    kind,
    artifactId: stringFromAnyKey(args, "artifact_id", "artifactId") ?? undefined,
    pageIndex: numberFromAnyKey(args, "page_index", "pageIndex") ?? undefined,
    pageNumber: numberFromAnyKey(args, "page_number", "pageNumber") ?? undefined,
    anchor: annotationAnchorFromArgs(args),
    rect: rectFromArgs(args),
    point: pointFromArgs(args),
    color: annotationColorFromArgs(args),
    text: stringFromAnyKey(args, "comment_text", "commentText", "text") ?? undefined,
    note: stringFromAnyKey(args, "note") ?? undefined,
    source: "sophia",
  }
}

function coreviewFocusAnchorInputFromArgs(args: Record<string, unknown>): CoreviewFocusAnchorInput {
  return {
    artifactId: stringFromAnyKey(args, "artifact_id", "artifactId") ?? undefined,
    pageIndex: numberFromAnyKey(args, "page_index", "pageIndex") ?? undefined,
    pageNumber: numberFromAnyKey(args, "page_number", "pageNumber") ?? undefined,
    anchor: annotationAnchorFromArgs(args),
    zoom: numberFromAnyKey(args, "zoom") ?? undefined,
    zoomDelta: numberFromAnyKey(args, "zoom_delta", "zoomDelta") ?? undefined,
    fitMode: focusFitModeFromArgs(args),
    reason: stringFromAnyKey(args, "reason") ?? undefined,
  }
}

function normalizeAddAnnotationInput(
  input: CoreviewAddAnnotationInput,
  current: CoreviewCurrentView,
): (
  | {
      ok: true
      kind: CoreviewAnnotationKind
      pageIndex: number
      anchor: CoreviewAnnotationAnchor
      color: CoreviewAnnotationColor
      text: string | null
      source: "sophia" | "user"
    }
  | { ok: false; blockedReason: CoreviewToolBlockedReason; unsupportedAnnotationKind?: string | null }
) {
  const kind = normalizeAnnotationKindValue(input.kind)
  if (!kind) {
    return {
      ok: false,
      blockedReason: "unsupported_annotation_kind",
      unsupportedAnnotationKind: typeof input.kind === "string" ? input.kind.slice(0, 40) : null,
    }
  }
  const pageIndex = normalizePageIndex(input, current)
  if (pageIndex === null) {
    return { ok: false, blockedReason: "requested_page_out_of_bounds" }
  }
  const anchor = input.anchor
    ?? (input.rect ? { type: "rect", ...input.rect } : null)
    ?? (input.point ? { type: "point", ...input.point } : null)
    ?? { type: "current_selection" }
  const normalizedAnchor = normalizeAnnotationAnchor(anchor)
  if (!normalizedAnchor) {
    return { ok: false, blockedReason: anchor.type === "rect" ? "invalid_rect" : "invalid_tool_args" }
  }
  if ((kind === "highlight" || kind === "underline") && normalizedAnchor.type === "point") {
    return { ok: false, blockedReason: "invalid_rect" }
  }

  return {
    ok: true,
    kind,
    pageIndex,
    anchor: normalizedAnchor,
    color: input.color ?? defaultAnnotationColorForKind(kind),
    text: normalizeAnnotationText(input.text ?? input.note),
    source: input.source === "user" ? "user" : "sophia",
  }
}

function defaultAnnotationColorForKind(kind: CoreviewAnnotationKind): CoreviewAnnotationColor {
  return kind === "underline" || kind === "arrow" ? "purple" : "yellow"
}

function buildHtmlFocusTextAnchor(
  text: string,
  pageIndex: number,
): CoreviewResolvedAnnotationAnchor | null {
  const normalizedText = normalizeAnnotationText(text)
  if (!normalizedText) {
    return null
  }
  return {
    anchorType: "text_quote",
    pageIndex,
    rect: { x: 0, y: 0, width: 0.01, height: 0.01 },
    point: null,
    text: normalizedText,
    matchCount: null,
    textLength: normalizedText.length,
  }
}

function normalizeFocusAnchorInput(
  input: CoreviewFocusAnchorInput,
  current: CoreviewCurrentView,
): (
  | {
      ok: true
      pageIndex: number
      anchor: CoreviewAnnotationAnchor
      zoom: number
      fitMode: ArtifactFitMode
    }
  | { ok: false; blockedReason: CoreviewToolBlockedReason }
) {
  const pageIndex = normalizePageIndex(input, current)
  if (pageIndex === null) {
    return { ok: false, blockedReason: "requested_page_out_of_bounds" }
  }
  if (!current.capabilities.supportsZoom) {
    return { ok: false, blockedReason: "zoom_not_supported" }
  }
  const anchor = input.anchor ?? { type: "current_selection" }
  const normalizedAnchor = normalizeAnnotationAnchor(anchor)
  if (!normalizedAnchor) {
    return { ok: false, blockedReason: anchor.type === "rect" ? "invalid_rect" : "invalid_tool_args" }
  }
  const explicitZoom = typeof input.zoom === "number" && Number.isFinite(input.zoom)
    ? input.zoom
    : null
  const delta = typeof input.zoomDelta === "number" && Number.isFinite(input.zoomDelta)
    ? input.zoomDelta
    : 1.35
  const zoom = clampArtifactZoom(explicitZoom ?? current.zoom * delta)
  return {
    ok: true,
    pageIndex,
    anchor: normalizedAnchor,
    zoom,
    fitMode: input.fitMode === "custom" ? "custom" : "custom",
  }
}

function annotationTargetFromResolvedAnchor(
  kind: CoreviewAnnotationKind,
  anchor: CoreviewResolvedAnnotationAnchor,
): (
  | { ok: true; rect: CoreviewNormalizedRect | null; point: CoreviewNormalizedPoint | null; line: CoreviewNormalizedLine | null }
  | { ok: false; blockedReason: CoreviewToolBlockedReason }
) {
  if (kind === "highlight" || kind === "underline") {
    const rect = anchor.rect ? normalizeRect(anchor.rect) : null
    return rect
      ? { ok: true, rect, point: null, line: null }
      : { ok: false, blockedReason: "invalid_rect" }
  }

  if (kind === "arrow") {
    const point = anchor.point
      ? normalizePoint(anchor.point)
      : anchor.rect
        ? pointNearRect(anchor.rect)
        : null
    const line = point ? arrowLineToPoint(point) : null
    return line
      ? { ok: true, rect: null, point: null, line }
      : { ok: false, blockedReason: "anchor_not_found" }
  }

  const point = anchor.point
    ? normalizePoint(anchor.point)
    : anchor.rect
      ? pointNearRect(anchor.rect)
      : null
  return point
    ? { ok: true, rect: null, point, line: null }
    : { ok: false, blockedReason: "anchor_not_found" }
}

function normalizePageIndex(
  input: Pick<CoreviewAddAnnotationInput, "pageIndex" | "pageNumber">,
  current: CoreviewCurrentView,
): number | null {
  let pageIndex = current.pageIndex
  if (typeof input.pageIndex === "number" && Number.isFinite(input.pageIndex)) {
    pageIndex = Math.floor(input.pageIndex)
  } else if (typeof input.pageNumber === "number" && Number.isFinite(input.pageNumber)) {
    pageIndex = Math.floor(input.pageNumber) - 1
  }
  return pageIndex >= 0 && pageIndex < Math.max(1, current.pageCount) ? pageIndex : null
}

function annotationKindFromArgs(args: Record<string, unknown>): string | null {
  const value = stringFromAnyKey(args, "kind")
  return value ? value.toLowerCase().slice(0, 40) : null
}

function normalizeAnnotationKindValue(value: unknown): CoreviewAnnotationKind | null {
  return value === "highlight" || value === "comment" || value === "underline" || value === "arrow"
    ? value
    : null
}

function unsupportedAnnotationKindFromValue(value: unknown): string | null {
  return normalizeAnnotationKindValue(value) ? null : typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().slice(0, 40)
    : null
}

function annotationColorFromArgs(args: Record<string, unknown>): CoreviewAnnotationColor | undefined {
  const value = stringFromAnyKey(args, "color")
  return value === "yellow" || value === "purple" || value === "blue" || value === "pink" ? value : undefined
}

function annotationAnchorFromArgs(args: Record<string, unknown>): CoreviewAnnotationAnchor | undefined {
  const anchorType = stringFromAnyKey(args, "anchor_type", "anchorType")
  if (anchorType === "current_title" || anchorType === "current_selection") {
    return { type: anchorType }
  }
  if (anchorType === "text_quote") {
    const text = stringFromAnyKey(args, "text_quote", "textQuote", "text")
    return text ? { type: "text_quote", text, occurrence: occurrenceFromArgs(args) } : undefined
  }
  if (anchorType === "rect") {
    const rect = rectFromArgs(args)
    return rect ? { type: "rect", ...rect } : undefined
  }
  if (anchorType === "point") {
    const point = pointFromArgs(args)
    return point ? { type: "point", ...point } : undefined
  }
  return undefined
}

function occurrenceFromArgs(args: Record<string, unknown>): number | undefined {
  const occurrence = numberFromAnyKey(args, "occurrence")
  if (typeof occurrence !== "number" || !Number.isFinite(occurrence)) {
    return undefined
  }
  return Math.max(1, Math.floor(occurrence))
}

function rectFromArgs(args: Record<string, unknown>): CoreviewNormalizedRect | undefined {
  const rect = recordFromAnyKey(args, "rect")
  if (!rect) {
    return undefined
  }
  const candidate = {
    x: numberFromAnyKey(rect, "x") ?? Number.NaN,
    y: numberFromAnyKey(rect, "y") ?? Number.NaN,
    width: numberFromAnyKey(rect, "width") ?? Number.NaN,
    height: numberFromAnyKey(rect, "height") ?? Number.NaN,
  }
  return normalizeRect(candidate) ?? undefined
}

function pointFromArgs(args: Record<string, unknown>): CoreviewNormalizedPoint | undefined {
  const point = recordFromAnyKey(args, "point")
  if (!point) {
    return undefined
  }
  const candidate = {
    x: numberFromAnyKey(point, "x") ?? Number.NaN,
    y: numberFromAnyKey(point, "y") ?? Number.NaN,
  }
  return normalizePoint(candidate) ?? undefined
}

function normalizeAnnotationAnchor(anchor: CoreviewAnnotationAnchor): CoreviewAnnotationAnchor | null {
  if (anchor.type === "current_title" || anchor.type === "current_selection") {
    return anchor
  }
  if (anchor.type === "text_quote") {
    const text = normalizeAnnotationText(anchor.text)
    return text ? { type: "text_quote", text, occurrence: anchor.occurrence } : null
  }
  if (anchor.type === "rect") {
    const rect = normalizeRect(anchor)
    return rect ? { type: "rect", ...rect } : null
  }
  const point = normalizePoint(anchor)
  return point ? { type: "point", ...point } : null
}

function normalizeRect(rect: CoreviewNormalizedRect): CoreviewNormalizedRect | null {
  const x = clampNormalized(rect.x)
  const y = clampNormalized(rect.y)
  const right = clampNormalized(rect.x + rect.width)
  const bottom = clampNormalized(rect.y + rect.height)
  const width = right - x
  const height = bottom - y
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { x, y, width, height }
}

function normalizePoint(point: CoreviewNormalizedPoint): CoreviewNormalizedPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null
  }
  return {
    x: clampNormalized(point.x),
    y: clampNormalized(point.y),
  }
}

function pointNearRect(rect: CoreviewNormalizedRect): CoreviewNormalizedPoint | null {
  const normalized = normalizeRect(rect)
  if (!normalized) {
    return null
  }
  const rightEdge = normalized.x + normalized.width
  return {
    x: clampNormalized(rightEdge + 0.018 <= 1 ? rightEdge + 0.018 : rightEdge - 0.018),
    y: clampNormalized(normalized.y + Math.min(normalized.height * 0.35, 0.035)),
  }
}

function arrowLineToPoint(point: CoreviewNormalizedPoint): CoreviewNormalizedLine | null {
  const end = normalizePoint(point)
  if (!end) {
    return null
  }
  const start = {
    x: clampNormalized(end.x - 0.18),
    y: clampNormalized(end.y + 0.12),
  }
  if (Math.hypot(end.x - start.x, end.y - start.y) <= 0.01) {
    return null
  }
  return { start, end }
}

function normalizeAnnotationText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.replace(/\s+/gu, " ").trim()
  return normalized ? normalized.slice(0, 180) : null
}

function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function focusFitModeFromArgs(args: Record<string, unknown>): ArtifactFitMode | undefined {
  const value = stringFromAnyKey(args, "fit_mode", "fitMode")
  return value === "custom" ? "custom" : undefined
}

function fitModeFromArgs(args: Record<string, unknown>): ArtifactFitMode | undefined {
  const value = stringFromAnyKey(args, "fit_mode", "fitMode")
  return value === "page" || value === "width" || value === "custom" ? value : undefined
}

function htmlScrollPositionFromArgs(args: Record<string, unknown>): "top" | "bottom" | undefined {
  const value = stringFromAnyKey(args, "html_scroll_position", "htmlScrollPosition")
  return value === "top" || value === "bottom" ? value : undefined
}

function unavailableToolResult(toolName: CoreviewToolName): CoreviewActionResult {
  return buildCoreviewResult({
    action: toolName === COREVIEW_REFRESH_VIEW_TOOL_NAME
      ? "refresh_view"
      : toolName === COREVIEW_GET_CURRENT_VIEW_TOOL_NAME
        ? "get_current_view"
        : toolName === COREVIEW_ADD_ANNOTATION_TOOL_NAME
          ? "add_annotation"
          : toolName === COREVIEW_FOCUS_ANCHOR_TOOL_NAME
            ? "focus_anchor"
            : "set_view",
    source: "gemini_tool",
    current: emptyCurrentView(),
    ok: false,
    blockedReason: "tool_unavailable",
    resultSummary: blockedSummary("tool_unavailable"),
    refreshAttempted: false,
    refreshResult: "not_requested",
    viewReadyWaitMs: null,
    viewSignatureBefore: null,
    viewSignatureAfter: null,
  })
}

function emptyCurrentView(): CoreviewCurrentView {
  const capabilities = getCoreviewArtifactCapabilities({
    rendererKind: "unsupported",
    originalDownloadAvailable: false,
    openInNewTabAvailable: false,
  })
  return {
    artifactId: null,
    artifactPath: null,
    artifactTitle: null,
    artifactStableIdentity: null,
    rendererKind: "unsupported",
    capabilities,
    supportsPagination: false,
    supportsZoom: false,
    pageIndex: 0,
    pageCount: 1,
    zoom: 1,
    fitMode: "custom",
    viewSignature: null,
    stale: false,
    refreshInProgress: false,
    canRefresh: false,
    reviewActive: false,
    reviewHasFrame: false,
    exactTextAvailable: false,
    visualFrameFresh: false,
    annotationOverlayCaptured: null,
    annotationCount: 0,
    highlightCount: 0,
    commentCount: 0,
    underlineCount: 0,
    arrowCount: 0,
    drawPathCount: 0,
    rebindStatus: "not_attempted",
  }
}

function stringFromAnyKey(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }
  return null
}

function numberFromAnyKey(value: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return null
}

function recordFromAnyKey(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const candidate = value[key]
    if (isRecord(candidate)) {
      return candidate
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function annotationSummary(
  kind: CoreviewAnnotationKind,
  anchorType: CoreviewAnnotationAnchor["type"],
  color: CoreviewAnnotationColor,
  pageIndex: number,
): string {
  if (kind === "highlight") {
    return `Added a ${color} highlight to ${anchorLabel(anchorType)} on page ${pageIndex + 1}.`
  }
  if (kind === "underline") {
    return `Underlined ${anchorLabel(anchorType)} on page ${pageIndex + 1}.`
  }
  if (kind === "arrow") {
    return `Added an arrow to ${anchorLabel(anchorType)} on page ${pageIndex + 1}.`
  }
  return `Added a comment to ${anchorLabel(anchorType)} on page ${pageIndex + 1}.`
}

function anchorLabel(anchorType: CoreviewAnnotationAnchor["type"]): string {
  switch (anchorType) {
    case "current_title":
      return "the title"
    case "current_selection":
      return "the current selection"
    case "text_quote":
      return "the matching text"
    case "rect":
      return "the selected area"
    case "point":
      return "the selected point"
    default:
      return "the anchor"
  }
}

function filterArtifactCreationDeclarations(declarations: unknown[]): unknown[] {
  return declarations.filter((declaration) => !(
    isRecord(declaration)
    && typeof declaration.name === "string"
    && declaration.name === "emit_artifact"
  ))
}

function filterGenericBuilderDeclarations(declarations: unknown[]): unknown[] {
  return declarations.filter((declaration) => !(
    isRecord(declaration)
    && typeof declaration.name === "string"
    && GEMINI_GENERIC_BUILDER_TOOL_NAMES.has(declaration.name)
  ))
}
