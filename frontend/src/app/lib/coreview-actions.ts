import {
  buildArtifactViewSignature,
  clampArtifactZoom,
  type ArtifactFitMode,
  type ArtifactRendererKind,
} from "./artifact-renderers"

export const COREVIEW_SET_VIEW_TOOL_NAME = "coreview_set_view"
export const COREVIEW_REFRESH_VIEW_TOOL_NAME = "coreview_refresh_view"
export const COREVIEW_GET_CURRENT_VIEW_TOOL_NAME = "coreview_get_current_view"

export const COREVIEW_TOOL_NAMES = [
  COREVIEW_SET_VIEW_TOOL_NAME,
  COREVIEW_REFRESH_VIEW_TOOL_NAME,
  COREVIEW_GET_CURRENT_VIEW_TOOL_NAME,
] as const

export type CoreviewToolName = typeof COREVIEW_TOOL_NAMES[number]
export type CoreviewActionName = "set_view" | "refresh_view" | "get_current_view"
export type CoreviewToolCommandSource = "gemini_tool" | "frontend_fallback"

export type CoreviewToolRefreshResult =
  | "not_requested"
  | "success"
  | "error"
  | "failed"
  | "not_active"
  | "unavailable"
  | "refresh_unavailable"

export type CoreviewToolBlockedReason =
  | "no_selected_artifact"
  | "artifact_mismatch"
  | "artifact_rebind_required"
  | "artifact_rebind_failed"
  | "artifact_not_available_in_current_session"
  | "unsupported_renderer"
  | "unsupported_pages"
  | "requested_page_out_of_bounds"
  | "view_ready_timeout"
  | "refresh_unavailable"
  | "review_not_active"
  | "tool_unavailable"
  | "invalid_tool_args"

export interface CoreviewSetViewInput {
  artifactId?: string
  pageIndex?: number
  pageNumber?: number
  pageLabel?: string
  zoom?: number
  fitMode?: ArtifactFitMode
  reason?: string
}

export interface CoreviewRefreshViewInput {
  reason?: string
}

export interface CoreviewGetCurrentViewInput {
  artifactId?: string
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
  supportsPagination: boolean
  supportsZoom: boolean
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
  viewSignature: string | null
  stale: boolean
  refreshInProgress: boolean
  canRefresh: boolean
  reviewActive: boolean
  reviewHasFrame: boolean
  exactTextAvailable: boolean
  visualFrameFresh: boolean
  annotationOverlayCaptured: boolean | null
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

export interface CoreviewRendererAdapter {
  getCurrentViewState(): CoreviewCurrentView
  setView(input: Required<Pick<CoreviewSetViewInput, "pageIndex" | "zoom" | "fitMode">>): Promise<void> | void
  refreshView(input?: CoreviewRefreshViewInput): Promise<CoreviewRefreshAdapterResult> | CoreviewRefreshAdapterResult
  waitForViewReady(viewSignature: string | null): Promise<CoreviewViewReadyResult>
  markViewStale(viewSignature: string | null): void
  clearViewStale(viewSignature: string | null): void
  rebindVisibleArtifact?(input: CoreviewArtifactRebindInput): CoreviewArtifactRebindResult
}

export interface CoreviewActionResult {
  ok: boolean
  action: CoreviewActionName
  artifact_id: string | null
  artifact_path: string | null
  artifact_title: string | null
  renderer_kind: ArtifactRendererKind | null
  page_index: number | null
  page_number: number | null
  page_count: number | null
  zoom: number | null
  fit_mode: ArtifactFitMode | null
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
  artifact_stable_identity?: string | null
  rebind_status: CoreviewArtifactRebindStatus
  rebind_attempted: boolean
  rebind_result: CoreviewArtifactRebindStatus
  rebind_reason: string | null
  raw_artifact_text_excluded: true
  raw_frame_excluded: true
}

export interface CoreviewActionBus {
  setView(input: CoreviewSetViewInput, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  refreshView(input: CoreviewRefreshViewInput | undefined, source: CoreviewToolCommandSource): Promise<CoreviewActionResult>
  getCurrentView(input: CoreviewGetCurrentViewInput | undefined, source: CoreviewToolCommandSource): CoreviewActionResult
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
    await adapter.setView(normalized)

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
      resultSummary: `Switched to ${pageSummary(after)}.${refreshSummary}`,
      refreshAttempted,
      refreshResult,
      viewReadyWaitMs: ready.waitMs,
      viewSignatureBefore: initialBefore.viewSignature,
      viewSignatureAfter: after.viewSignature,
      staleOverride: forceStale,
      visualFrameFreshOverride: forceVisualFrameFresh,
      ...resolved.rebind,
    })
  }

  return {
    setView,
    refreshView,
    getCurrentView,
    handleToolCall(call) {
      if (call.name === COREVIEW_SET_VIEW_TOOL_NAME) {
        return setView(coreviewSetViewInputFromArgs(call.args), "gemini_tool")
      }
      if (call.name === COREVIEW_REFRESH_VIEW_TOOL_NAME) {
        return refreshView(coreviewRefreshViewInputFromArgs(call.args), "gemini_tool")
      }
      return Promise.resolve(getCurrentView(coreviewGetCurrentViewInputFromArgs(call.args), "gemini_tool"))
    },
  }
}

export type CoreviewToolBridgeHandler = (call: CoreviewToolCallInput) => Promise<CoreviewActionResult> | CoreviewActionResult

let activeToolBridge: CoreviewToolBridgeHandler | null = null
let lastHandledToolAction: { toolName: CoreviewToolName; handledAt: number; result: CoreviewActionResult } | null = null

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
  lastHandledToolAction = {
    toolName: call.name,
    handledAt: Date.now(),
    result,
  }
  return result
}

export function wasRecentCoreviewToolActionHandled(params: {
  toolName?: CoreviewToolName
  sinceMs: number
  windowMs?: number
}): boolean {
  if (!lastHandledToolAction) {
    return false
  }
  const windowMs = params.windowMs ?? 2200
  if (params.toolName && lastHandledToolAction.toolName !== params.toolName) {
    return false
  }
  return lastHandledToolAction.handledAt >= params.sinceMs
    && Date.now() - lastHandledToolAction.handledAt <= windowMs
}

export function clearCoreviewToolBridgeForTests(): void {
  activeToolBridge = null
  lastHandledToolAction = null
}

export function isCoreviewToolName(name: string | null | undefined): name is CoreviewToolName {
  return COREVIEW_TOOL_NAMES.includes(name as CoreviewToolName)
}

export function coreviewGeminiFunctionDeclarations(): Record<string, unknown>[] {
  return [
    {
      name: COREVIEW_SET_VIEW_TOOL_NAME,
      description: "Set the active Coreview artifact view during Review with Sophia. Use for page navigation or zoom changes, then wait for the app result before acknowledging.",
      parameters: {
        type: "OBJECT",
        properties: {
          artifact_id: { type: "STRING", description: "Optional active artifact id. Omit when using the currently selected artifact." },
          page_index: { type: "NUMBER", description: "Zero-based page index. Preferred for exact page navigation." },
          page_number: { type: "NUMBER", description: "One-based user-facing page number." },
          page_label: { type: "STRING", description: "Optional user-facing page label." },
          zoom: { type: "NUMBER", description: "Zoom multiplier, for example 1.2." },
          fit_mode: { type: "STRING", enum: ["page", "width", "custom"], description: "View fit mode." },
          reason: { type: "STRING", description: "Short safe reason for the view change." },
        },
        required: [],
      },
    },
    {
      name: COREVIEW_REFRESH_VIEW_TOOL_NAME,
      description: "Refresh Sophia's still-frame view of the active Coreview artifact without changing artifact contents.",
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
  ]
}

export function withCoreviewGeminiToolDeclarations(
  setup: Record<string, unknown>,
  enabled: boolean,
  options: { allowArtifactCreation?: boolean } = {},
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
  const toolWithDeclarations = nextTools.find((tool): tool is Record<string, unknown> => (
    isRecord(tool) && Array.isArray(tool.functionDeclarations)
  ))
  const declarations = coreviewGeminiFunctionDeclarations()

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
  if (current.rendererKind === "unsupported" || current.rendererKind === "download_only") {
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
  | { ok: true; pageIndex: number; zoom: number; fitMode: ArtifactFitMode }
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
  if (pageRequested && !current.supportsPagination) {
    return { ok: false, blockedReason: "unsupported_pages" }
  }
  if (pageRequested && (pageIndex < 0 || pageIndex >= Math.max(1, current.pageCount))) {
    return { ok: false, blockedReason: "requested_page_out_of_bounds" }
  }

  const zoomRequested = typeof input.zoom === "number" || typeof input.fitMode === "string"
  if (zoomRequested && !current.supportsZoom) {
    return { ok: false, blockedReason: "unsupported_renderer" }
  }

  const fitMode = input.fitMode ?? current.fitMode
  const zoom = typeof input.zoom === "number" && Number.isFinite(input.zoom)
    ? clampArtifactZoom(input.zoom)
    : fitMode === "custom"
      ? current.zoom
      : 1

  return { ok: true, pageIndex, zoom, fitMode }
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
}): CoreviewActionResult {
  const current = params.current
  const stale = params.staleOverride ?? current.stale
  const visualFrameFresh = params.visualFrameFreshOverride ?? current.visualFrameFresh
  const rebindAttempted = params.rebindAttempted ?? false
  const rebindResult = params.rebindResult ?? current.rebindStatus ?? "not_attempted"
  const rebindStatus = params.rebindStatus ?? current.rebindStatus ?? rebindResult
  return {
    ok: params.ok,
    action: params.action,
    artifact_id: current.artifactId,
    artifact_path: current.artifactPath,
    artifact_title: current.artifactTitle,
    renderer_kind: current.rendererKind,
    page_index: current.pageIndex,
    page_number: current.pageIndex + 1,
    page_count: current.pageCount,
    zoom: clampArtifactZoom(current.zoom),
    fit_mode: current.fitMode,
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
    annotation_overlay_captured: current.annotationOverlayCaptured,
    artifact_stable_identity: current.artifactStableIdentity ?? null,
    rebind_status: rebindStatus,
    rebind_attempted: rebindAttempted,
    rebind_result: rebindResult,
    rebind_reason: params.rebindReason ?? null,
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

function pageSummary(current: CoreviewCurrentView): string {
  return `page ${current.pageIndex + 1} of ${Math.max(1, current.pageCount)}`
}

function currentViewSummary(current: CoreviewCurrentView): string {
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
      return "The active renderer does not support pages."
    case "requested_page_out_of_bounds":
      return "The requested page is out of range."
    case "unsupported_renderer":
      return "The active renderer does not support that Coreview action."
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
    default:
      return "The Coreview action was blocked."
  }
}

function coreviewSetViewInputFromArgs(args: Record<string, unknown>): CoreviewSetViewInput {
  return {
    artifactId: stringFromAnyKey(args, "artifact_id", "artifactId") ?? undefined,
    pageIndex: numberFromAnyKey(args, "page_index", "pageIndex") ?? undefined,
    pageNumber: numberFromAnyKey(args, "page_number", "pageNumber") ?? undefined,
    pageLabel: stringFromAnyKey(args, "page_label", "pageLabel") ?? undefined,
    zoom: numberFromAnyKey(args, "zoom") ?? undefined,
    fitMode: fitModeFromArgs(args),
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

function fitModeFromArgs(args: Record<string, unknown>): ArtifactFitMode | undefined {
  const value = stringFromAnyKey(args, "fit_mode", "fitMode")
  return value === "page" || value === "width" || value === "custom" ? value : undefined
}

function unavailableToolResult(toolName: CoreviewToolName): CoreviewActionResult {
  return buildCoreviewResult({
    action: toolName === COREVIEW_REFRESH_VIEW_TOOL_NAME
      ? "refresh_view"
      : toolName === COREVIEW_GET_CURRENT_VIEW_TOOL_NAME
        ? "get_current_view"
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
  return {
    artifactId: null,
    artifactPath: null,
    artifactTitle: null,
    artifactStableIdentity: null,
    rendererKind: "unsupported",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filterArtifactCreationDeclarations(declarations: unknown[]): unknown[] {
  return declarations.filter((declaration) => !(
    isRecord(declaration)
    && typeof declaration.name === "string"
    && declaration.name === "emit_artifact"
  ))
}
