import type { ArtifactRendererKind } from "./artifact-renderers"
import type { CoreviewCurrentView } from "./coreview-actions"
import { buildCoreviewCapabilitySummary } from "./coreview-artifact-capabilities"
import {
  classifyCoreviewHtmlQuickEdit,
  type CoreviewHtmlQuickEditClassification,
  type CoreviewHtmlQuickPatchResponse,
} from "./coreview-html-quick-edit"
import type {
  CoreviewCurrentViewCapabilitySummary,
} from "./coreview-workspace-contract"

export const COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME = "coreview_request_artifact_update"
export const COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME = "coreview_cancel_builder_task"
export const COREVIEW_GET_BUILDER_STATUS_TOOL_NAME = "coreview_get_builder_status"

export const COREVIEW_BUILDER_TOOL_NAMES = [
  COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
  COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME,
  COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
] as const

export type CoreviewBuilderToolName = typeof COREVIEW_BUILDER_TOOL_NAMES[number]

export interface CoreviewBuilderToolCallInput {
  id: string | null
  name: CoreviewBuilderToolName
  args: Record<string, unknown>
}

export type CoreviewArtifactUpdateMode =
  | "create_new"
  | "update_existing"
  | "revise_version"
  | "convert_format"
  | "repair_artifact"

export type CoreviewBuilderActionResultName =
  | typeof COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME
  | typeof COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME
  | typeof COREVIEW_GET_BUILDER_STATUS_TOOL_NAME

export type CoreviewBuilderBlockedReason =
  | "coreview_disabled"
  | "no_selected_artifact"
  | "unsupported_renderer"
  | "unsupported_update_mode"
  | "no_active_builder_task"
  | "update_not_started"
  | "missing_update_callback"
  | "missing_cancel_callback"
  | "review_not_active"
  | "no_workspace_context"
  | "builder_action_unavailable"
  | "builder_start_failed"
  | "builder_cancel_failed"

export type CoreviewBuilderActionResultKind =
  | "update_requested"
  | "task_started"
  | "quick_patch_applied"
  | "status"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "unsupported"
  | "no_active_builder_task"
  | "update_not_started"

export type CoreviewBuilderSourceActor = "user" | "sophia" | "system"

export type CoreviewAnnotationCounts = {
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount: number
  arrowCount: number
  drawPathCount: number
}

export interface CoreviewArtifactUpdateContext {
  workspaceKey: string
  artifactStableIdentity: string | null
  artifactPath: string | null
  artifactTitle: string | null
  rendererKind: ArtifactRendererKind
  capabilitySummary: CoreviewCurrentViewCapabilitySummary
  currentPage: number | null
  pageCount: number | null
  viewSignature: string | null
  annotationCounts: CoreviewAnnotationCounts
  selectedAnnotationIds?: string[]
  userUpdateRequest: string
  requestedChangeSummary: string
  updateMode: CoreviewArtifactUpdateMode
  sourceActor: CoreviewBuilderSourceActor
  sessionId: string | null
  threadId: string | null
  parentThreadId?: string | null
  originalArtifactHref?: string | null
  rawArtifactTextExcluded: true
  rawFrameExcluded: true
  rawCommentTextExcluded: true
}

export interface CoreviewBuilderTaskStatus {
  phase: "starting" | "running" | "completed" | "failed" | "timed_out" | "cancelled" | "idle"
  taskId: string | null
  runId: string | null
  cancellable: boolean
  currentStep: string | null
}

export interface CoreviewBuilderOutputStatus {
  artifactPath: string | null
  artifactTitle: string | null
  artifactHref?: string | null
}

export interface CoreviewHtmlQuickPatchActionTelemetry {
  eligible: boolean
  attempted: boolean
  result: "patched" | "unsupported" | "failed" | "not_eligible" | "fallback_full_builder"
  kind: string | null
  fallbackReason: string | null
  latencyMs: number | null
  revisionPathHash: string | null
  usedFullBuilder: boolean
  renderConfirmed?: boolean | null
  preservedOriginal: boolean
  restoreAvailable?: boolean | null
  typeErrorPrevented?: boolean | null
}

export interface CoreviewBuilderActionResult {
  ok: boolean
  action: CoreviewBuilderActionResultName
  result: CoreviewBuilderActionResultKind
  taskId?: string | null
  runId?: string | null
  blockedReason?: CoreviewBuilderBlockedReason | string | null
  userFacingMessage?: string | null
  updateMode?: CoreviewArtifactUpdateMode | null
  rendererKind?: ArtifactRendererKind | null
  requestedChangeSummary?: string | null
  context?: CoreviewArtifactUpdateContext | null
  status?: CoreviewBuilderTaskStatus | null
  latestOutput?: CoreviewBuilderOutputStatus | null
  htmlQuickPatch?: CoreviewHtmlQuickPatchActionTelemetry | null
  htmlQuickPatchResponse?: CoreviewHtmlQuickPatchResponse | null
  editBuilderArtifactInterceptedByCoreview?: boolean
  editBuilderArtifactDirectCallResult?: string | null
  coreviewUpdateStateCreatedFromDirectEditTool?: boolean
  preservedMic: true
  preservedReview: true
  rawArtifactTextExcluded: true
  rawFrameExcluded: true
  rawCommentTextExcluded: true
}

export interface CoreviewActiveBuilderTaskState {
  workspaceKey: string
  artifactStableIdentity: string | null
  artifactPath: string | null
  rendererKind: ArtifactRendererKind
  requestedChangeSummary: string
  builderTaskId: string | null
  builderRunId: string | null
  status: CoreviewBuilderTaskStatus["phase"]
  phase: CoreviewBuilderTaskStatus["phase"]
  currentStep: string | null
  cancellable: boolean
  startedAt: string
  updatedAt: string
}

export interface CoreviewBuilderStartAdapterResult {
  ok: boolean
  taskId?: string | null
  runId?: string | null
  blockedReason?: string | null
  userFacingMessage?: string | null
}

export interface CoreviewBuilderCancelAdapterResult {
  ok: boolean
  taskId?: string | null
  runId?: string | null
  status?: CoreviewBuilderTaskStatus["phase"] | "completed" | "running" | string | null
  blockedReason?: string | null
  userFacingMessage?: string | null
}

export type CoreviewBuilderWorkspaceEventInput = {
  type:
    | "builder.update_requested"
    | "builder.task_started"
    | "builder.task_cancel_requested"
    | "builder.task_cancelled"
    | "builder.task_failed"
    | "builder.task_completed"
    | "artifact.version_created"
    | "artifact.version_selected"
  context: CoreviewArtifactUpdateContext
  taskId?: string | null
  runId?: string | null
  result?: string | null
  output?: CoreviewBuilderOutputStatus | null
}

export interface CoreviewBuilderActionAdapter {
  getCurrentView(): CoreviewCurrentView
  getWorkspaceKey(): string
  getSessionIds(): {
    sessionId?: string | null
    threadId?: string | null
    parentThreadId?: string | null
  }
  getOriginalArtifactHref?(): string | null
  getSelectedAnnotationIds?(): string[]
  getActiveBuilderTask(): CoreviewBuilderTaskStatus | null
  getLatestOutput(): CoreviewBuilderOutputStatus | null
  emitWorkspaceEvent(input: CoreviewBuilderWorkspaceEventInput): void
  startBuilderTask(input: {
    context: CoreviewArtifactUpdateContext
    prompt: string
  }): Promise<CoreviewBuilderStartAdapterResult> | CoreviewBuilderStartAdapterResult
  quickPatchHtmlArtifact?(input: {
    context: CoreviewArtifactUpdateContext
    classification: CoreviewHtmlQuickEditClassification
  }): Promise<CoreviewHtmlQuickPatchResponse> | CoreviewHtmlQuickPatchResponse
  cancelBuilderTask(input: {
    context: CoreviewArtifactUpdateContext | null
    task: CoreviewBuilderTaskStatus
  }): Promise<CoreviewBuilderCancelAdapterResult> | CoreviewBuilderCancelAdapterResult
}

export interface CoreviewRequestArtifactUpdateInput {
  userUpdateRequest: string
  updateMode?: CoreviewArtifactUpdateMode | null
  sourceActor?: CoreviewBuilderSourceActor
}

export interface CoreviewBuilderActionAvailabilityInput {
  coreviewEnabled: boolean
  artifactSelected: boolean
  artifactPath: string | null
  rendererKind: ArtifactRendererKind
  capabilitySummary: CoreviewCurrentViewCapabilitySummary | null
  requestArtifactUpdateWired: boolean
  cancelBuilderTaskWired: boolean
}

export interface CoreviewBuilderActionAvailability {
  enabled: boolean
  blockedReason: CoreviewBuilderBlockedReason | string | null
  supportsArtifactUpdate: boolean
  supportsVersionedRebuild: boolean
  unsupportedUpdateReason: string | null
}

export interface CoreviewBuilderActionBus {
  requestArtifactUpdate(input: CoreviewRequestArtifactUpdateInput): Promise<CoreviewBuilderActionResult>
  cancelBuilderTask(sourceActor?: CoreviewBuilderSourceActor): Promise<CoreviewBuilderActionResult>
  getBuilderStatus(sourceActor?: CoreviewBuilderSourceActor): CoreviewBuilderActionResult
  buildUpdateContext(input: CoreviewRequestArtifactUpdateInput): CoreviewArtifactUpdateContext | null
  handleToolCall(call: CoreviewBuilderToolCallInput): Promise<CoreviewBuilderActionResult>
}

export function resolveCoreviewBuilderActionAvailability(
  input: CoreviewBuilderActionAvailabilityInput,
): CoreviewBuilderActionAvailability {
  const capabilitySummary = input.capabilitySummary
  const supportsArtifactUpdate = capabilitySummary?.supportsArtifactUpdate === true
  const supportsVersionedRebuild = Boolean(
    capabilitySummary?.supportsVersioning
      && capabilitySummary.supportsRebuildFromSource,
  )
  const unsupportedUpdateReason = capabilitySummary?.unsupportedUpdateReason ?? null
  const unavailable = (
    blockedReason: CoreviewBuilderActionAvailability["blockedReason"],
  ): CoreviewBuilderActionAvailability => ({
    enabled: false,
    blockedReason,
    supportsArtifactUpdate,
    supportsVersionedRebuild,
    unsupportedUpdateReason,
  })

  if (!input.coreviewEnabled) {
    return unavailable("coreview_disabled")
  }
  if (!input.artifactSelected || !input.artifactPath) {
    return unavailable("no_selected_artifact")
  }
  if (!capabilitySummary || (!supportsArtifactUpdate && !supportsVersionedRebuild)) {
    return unavailable("unsupported_renderer")
  }
  if (!input.requestArtifactUpdateWired) {
    return unavailable("missing_update_callback")
  }
  if (!input.cancelBuilderTaskWired) {
    return unavailable("missing_cancel_callback")
  }

  return {
    enabled: true,
    blockedReason: null,
    supportsArtifactUpdate,
    supportsVersionedRebuild,
    unsupportedUpdateReason,
  }
}

export function createCoreviewBuilderActionBus(adapter: CoreviewBuilderActionAdapter): CoreviewBuilderActionBus {
  const buildUpdateContext = (input: CoreviewRequestArtifactUpdateInput): CoreviewArtifactUpdateContext | null => {
    const current = adapter.getCurrentView()
    if (!current.artifactId || !current.artifactPath) {
      return null
    }
    const updateMode = resolveUpdateMode(input.updateMode, current)
    const sessionIds = adapter.getSessionIds()
    const currentPage = current.capabilities.supportsPages ? current.pageIndex + 1 : null
    const pageCount = current.capabilities.supportsPages ? Math.max(1, current.pageCount) : null
    return {
      workspaceKey: adapter.getWorkspaceKey(),
      artifactStableIdentity: current.artifactStableIdentity ?? null,
      artifactPath: current.artifactPath,
      artifactTitle: current.artifactTitle,
      rendererKind: current.rendererKind,
      capabilitySummary: buildCoreviewCapabilitySummary({
        capabilities: current.capabilities,
        rendererKind: current.rendererKind,
        pageIndex: current.pageIndex,
        pageCount: current.pageCount,
      }),
      currentPage,
      pageCount,
      viewSignature: current.viewSignature,
      annotationCounts: {
        annotationCount: current.annotationCount,
        highlightCount: current.highlightCount,
        commentCount: current.commentCount,
        underlineCount: current.underlineCount ?? 0,
        arrowCount: current.arrowCount ?? 0,
        drawPathCount: current.drawPathCount ?? 0,
      },
      selectedAnnotationIds: adapter.getSelectedAnnotationIds?.() ?? [],
      userUpdateRequest: normalizeUserUpdateRequest(input.userUpdateRequest),
      requestedChangeSummary: summarizeRequestedChange(input.userUpdateRequest),
      updateMode,
      sourceActor: input.sourceActor ?? "user",
      sessionId: sessionIds.sessionId ?? null,
      threadId: sessionIds.threadId ?? null,
      parentThreadId: sessionIds.parentThreadId ?? sessionIds.threadId ?? null,
      originalArtifactHref: adapter.getOriginalArtifactHref?.() ?? null,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
      rawCommentTextExcluded: true,
    }
  }

  const requestArtifactUpdate = async (
    input: CoreviewRequestArtifactUpdateInput,
  ): Promise<CoreviewBuilderActionResult> => {
    const context = buildUpdateContext(input)
    if (!context) {
      return builderResult({
        ok: false,
        action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
        result: "failed",
        blockedReason: "no_selected_artifact",
        userFacingMessage: "Select an artifact before asking Sophia to update it.",
      })
    }

    const unsupportedReason = updateUnsupportedReason(context)
    if (unsupportedReason) {
      return builderResult({
        ok: false,
        action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
        result: "unsupported",
        blockedReason: unsupportedReason,
        userFacingMessage: unsupportedReason,
        context,
      })
    }

    const quickEdit = classifyCoreviewHtmlQuickEdit({
      userUpdateRequest: context.userUpdateRequest,
      rendererKind: context.rendererKind,
      artifactPath: context.artifactPath,
      updateMode: context.updateMode,
    })
    const quickPatchEligible = Boolean(
      quickEdit.supported
        && context.rendererKind === "html"
        && context.artifactPath
        && (context.updateMode === "revise_version" || context.updateMode === "update_existing"),
    )
    let updateStateCreated = false
    const beginUpdateState = () => {
      if (updateStateCreated) {
        return
      }
      updateStateCreated = true
      adapter.emitWorkspaceEvent({
        type: "builder.update_requested",
        context,
      })
      upsertActiveCoreviewBuilderTaskState(context, {
        status: "starting",
        taskId: null,
        runId: null,
        cancellable: false,
        currentStep: "Applying update...",
      })
    }
    let quickPatchTelemetry: CoreviewHtmlQuickPatchActionTelemetry | null = quickPatchEligible
      ? {
          eligible: true,
          attempted: false,
          result: "fallback_full_builder",
          kind: quickEdit.quickEditKind,
          fallbackReason: adapter.quickPatchHtmlArtifact ? null : "quick_patch_adapter_unavailable",
          latencyMs: null,
          revisionPathHash: null,
          usedFullBuilder: true,
          preservedOriginal: true,
          restoreAvailable: null,
          renderConfirmed: null,
        }
      : {
          eligible: false,
          attempted: false,
          result: "not_eligible",
          kind: quickEdit.quickEditKind,
          fallbackReason: quickEdit.fallbackReason,
          latencyMs: null,
          revisionPathHash: null,
          usedFullBuilder: true,
          preservedOriginal: true,
          restoreAvailable: null,
          renderConfirmed: null,
        }

    if (quickPatchEligible && adapter.quickPatchHtmlArtifact) {
      beginUpdateState()
      const quickStartedAt = Date.now()
      const quickPatch = await adapter.quickPatchHtmlArtifact({
        context,
        classification: quickEdit,
      })
      const latencyMs = Math.max(0, Date.now() - quickStartedAt)
      quickPatchTelemetry = {
        eligible: true,
        attempted: true,
        result: quickPatch.result,
        kind: quickEdit.quickEditKind,
        fallbackReason: quickPatch.fallback_reason ?? null,
        latencyMs,
        revisionPathHash: quickPatch.revision_path_hash ?? null,
        usedFullBuilder: quickPatch.result !== "patched",
        preservedOriginal: quickPatch.preserved_original !== false,
        restoreAvailable: null,
        renderConfirmed: null,
      }

      if (quickPatch.ok && quickPatch.result === "patched" && quickPatch.revision_artifact_path) {
        upsertActiveCoreviewBuilderTaskState(context, {
          status: "completed",
          taskId: null,
          runId: null,
          cancellable: false,
          currentStep: null,
        })
        return builderResult({
          ok: true,
          action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
          result: "quick_patch_applied",
          taskId: null,
          runId: null,
          userFacingMessage: "Sophia applied a quick HTML update.",
          context,
          status: {
            phase: "completed",
            taskId: null,
            runId: null,
            cancellable: false,
            currentStep: null,
          },
          latestOutput: {
            artifactPath: quickPatch.revision_artifact_path,
            artifactTitle: artifactTitleFromPath(quickPatch.revision_artifact_path),
          },
          htmlQuickPatch: {
            ...quickPatchTelemetry,
            usedFullBuilder: false,
          },
          htmlQuickPatchResponse: quickPatch,
        })
      }

      if (quickPatch.result !== "unsupported") {
        upsertActiveCoreviewBuilderTaskState(context, {
          status: "failed",
          taskId: null,
          runId: null,
          cancellable: false,
          currentStep: "Quick update could not be applied",
        })
        adapter.emitWorkspaceEvent({
          type: "builder.task_failed",
          context,
          result: quickPatch.fallback_reason ?? "quick_patch_failed",
        })
        return builderResult({
          ok: false,
          action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
          result: "failed",
          blockedReason: quickPatch.fallback_reason ?? "quick_patch_failed",
          userFacingMessage: "Sophia could not apply that quick update. Original preserved.",
          context,
          htmlQuickPatch: quickPatchTelemetry,
          htmlQuickPatchResponse: quickPatch,
        })
      }
    }

    beginUpdateState()

    const prompt = buildCoreviewBuilderUpdatePrompt(context)
    const started = await adapter.startBuilderTask({ context, prompt })
    if (!started.ok) {
      upsertActiveCoreviewBuilderTaskState(context, {
        status: "failed",
        taskId: started.taskId ?? null,
        runId: started.runId ?? null,
        cancellable: false,
        currentStep: "Artifact update could not start",
      })
      adapter.emitWorkspaceEvent({
        type: "builder.task_failed",
        context,
        taskId: started.taskId,
        runId: started.runId,
        result: started.blockedReason ?? "builder_start_failed",
      })
      return builderResult({
        ok: false,
        action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
        result: "failed",
        taskId: started.taskId,
        runId: started.runId,
        blockedReason: started.blockedReason ?? "builder_start_failed",
        userFacingMessage: started.userFacingMessage ?? "Sophia could not start the artifact update.",
        context,
        htmlQuickPatch: quickPatchTelemetry,
      })
    }

    const startingStatus: CoreviewBuilderTaskStatus["phase"] = started.taskId || started.runId
      ? "running"
      : "starting"
    upsertActiveCoreviewBuilderTaskState(context, {
      status: startingStatus,
      taskId: started.taskId ?? null,
      runId: started.runId ?? null,
      cancellable: Boolean(started.taskId),
      currentStep: "Applying update...",
    })

    if (started.taskId || started.runId) {
      adapter.emitWorkspaceEvent({
        type: "builder.task_started",
        context,
        taskId: started.taskId,
        runId: started.runId,
      })
    }

    return builderResult({
      ok: true,
      action: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
      result: started.taskId || started.runId ? "task_started" : "update_requested",
      taskId: started.taskId,
      runId: started.runId,
      userFacingMessage: started.userFacingMessage ?? "Sophia is updating this artifact.",
      context,
      htmlQuickPatch: quickPatchTelemetry,
    })
  }

  const cancelBuilderTask = async (
    sourceActor: CoreviewBuilderSourceActor = "user",
  ): Promise<CoreviewBuilderActionResult> => {
    const context = buildUpdateContext({
      userUpdateRequest: "Cancel this artifact update.",
      sourceActor,
    })
    const trackedState = context ? reconcileActiveCoreviewBuilderTaskState(context, adapter.getActiveBuilderTask()) : null
    const task = trackedState ? statusFromActiveCoreviewBuilderTaskState(trackedState) : null
    if (!task?.cancellable || !task.taskId) {
      return builderResult({
        ok: false,
        action: COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME,
        result: "no_active_builder_task",
        blockedReason: "no_active_builder_task",
        userFacingMessage: trackedState
          ? "The update has not started yet. I'll keep the review open."
          : "I don't see an active artifact update right now.",
        context,
        status: task ?? idleStatus(),
      })
    }

    if (context) {
      adapter.emitWorkspaceEvent({
        type: "builder.task_cancel_requested",
        context,
        taskId: task.taskId,
        runId: task.runId,
      })
    }

    const cancelled = await adapter.cancelBuilderTask({ context, task })
    const status = normalizeCancelStatus(cancelled.status)
    if (context) {
      upsertActiveCoreviewBuilderTaskState(context, {
        status,
        taskId: cancelled.taskId ?? task.taskId,
        runId: cancelled.runId ?? task.runId,
        cancellable: status === "running",
        currentStep: status === "cancelled" ? "Artifact update cancelled" : task.currentStep,
      })
    }
    if (context) {
      adapter.emitWorkspaceEvent({
        type: status === "cancelled" ? "builder.task_cancelled" : "builder.task_failed",
        context,
        taskId: cancelled.taskId ?? task.taskId,
        runId: cancelled.runId ?? task.runId,
        result: cancelled.blockedReason ?? status,
      })
    }

    return builderResult({
      ok: cancelled.ok,
      action: COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME,
      result: cancelled.ok && status === "cancelled" ? "cancelled" : "failed",
      taskId: cancelled.taskId ?? task.taskId,
      runId: cancelled.runId ?? task.runId,
      blockedReason: cancelled.ok ? null : cancelled.blockedReason ?? "builder_cancel_failed",
      userFacingMessage: cancelled.userFacingMessage ?? (
        cancelled.ok ? "The artifact update was cancelled." : "Sophia could not cancel the update."
      ),
      context,
      status: {
        ...task,
        phase: status,
        cancellable: status === "running",
      },
    })
  }

  const getBuilderStatus = (
    sourceActor: CoreviewBuilderSourceActor = "user",
  ): CoreviewBuilderActionResult => {
    const context = buildUpdateContext({
      userUpdateRequest: "Check this artifact update.",
      sourceActor,
    })
    const trackedState = context ? reconcileActiveCoreviewBuilderTaskState(context, adapter.getActiveBuilderTask()) : null
    if (!trackedState) {
      return builderResult({
        ok: true,
        action: COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
        result: "no_active_builder_task",
        blockedReason: "no_active_builder_task",
        userFacingMessage: "I don't see an active artifact update right now.",
        context,
        status: idleStatus(),
        latestOutput: null,
      })
    }
    const task = statusFromActiveCoreviewBuilderTaskState(trackedState)
    const latestOutput = adapter.getLatestOutput()
    return builderResult({
      ok: true,
      action: COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
      result: "status",
      taskId: task.taskId,
      runId: task.runId,
      userFacingMessage: task.phase === "starting"
        ? "The update has not started yet. I'll keep the review open."
        : task.phase === "idle"
          ? "I don't see an active artifact update right now."
          : "Artifact update status is available.",
      context,
      status: task,
      latestOutput,
    })
  }

  const handleToolCall = async (
    call: CoreviewBuilderToolCallInput,
  ): Promise<CoreviewBuilderActionResult> => {
    if (call.name === COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME) {
      return withDirectEditInterceptTelemetry(
        call.args,
        await requestArtifactUpdate(coreviewRequestArtifactUpdateInputFromArgs(call.args)),
      )
    }
    if (call.name === COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME) {
      return cancelBuilderTask(sourceActorFromArgs(call.args) ?? "sophia")
    }
    return getBuilderStatus(sourceActorFromArgs(call.args) ?? "sophia")
  }

  return {
    requestArtifactUpdate,
    cancelBuilderTask,
    getBuilderStatus,
    buildUpdateContext,
    handleToolCall,
  }
}

export type CoreviewBuilderToolBridgeHandler = (
  call: CoreviewBuilderToolCallInput
) => Promise<CoreviewBuilderActionResult> | CoreviewBuilderActionResult

let activeBuilderToolBridge: CoreviewBuilderToolBridgeHandler | null = null

export function registerCoreviewBuilderToolBridge(handler: CoreviewBuilderToolBridgeHandler): () => void {
  activeBuilderToolBridge = handler
  return () => {
    if (activeBuilderToolBridge === handler) {
      activeBuilderToolBridge = null
    }
  }
}

export async function executeCoreviewBuilderToolBridgeCall(
  call: CoreviewBuilderToolCallInput,
): Promise<CoreviewBuilderActionResult> {
  if (!activeBuilderToolBridge) {
    return unavailableBuilderToolResult(call.name)
  }
  return activeBuilderToolBridge(call)
}

export function clearCoreviewBuilderToolBridgeForTests(): void {
  activeBuilderToolBridge = null
}

export function reconcileCoreviewBuilderTaskStateForContext(
  context: CoreviewArtifactUpdateContext,
  task: CoreviewBuilderTaskStatus | null,
): CoreviewActiveBuilderTaskState | null {
  return reconcileActiveCoreviewBuilderTaskState(context, task)
}

export function clearCoreviewBuilderTaskStateForTests(): void {
  activeCoreviewBuilderTasks.clear()
}

export function isCoreviewBuilderToolName(name: string | null | undefined): name is CoreviewBuilderToolName {
  return COREVIEW_BUILDER_TOOL_NAMES.includes(name as CoreviewBuilderToolName)
}

export function coreviewBuilderGeminiFunctionDeclarations(): Record<string, unknown>[] {
  return [
    {
      name: COREVIEW_REQUEST_ARTIFACT_UPDATE_TOOL_NAME,
      description: "Primary user-facing control-plane tool during Review with Sophia for user requests to update, revise, edit, change, rebuild, restyle, or make a new version of the currently selected artifact. Always use this instead of start_builder_task, update_async_task, edit_builder_artifact, or emit_artifact for selected-artifact updates. edit_builder_artifact is only an implementation primitive after Coreview has accepted the update. The browser will preserve the selected artifact path, renderer, stable identity, current view, source href, capability summary, annotations, and session/thread ids.",
      parameters: {
        type: "OBJECT",
        properties: {
          user_update_request: { type: "STRING", description: "Short summary of the user's requested change. Do not include raw artifact text." },
          update_mode: {
            type: "STRING",
            enum: ["create_new", "update_existing", "revise_version", "convert_format", "repair_artifact"],
            description: "Use revise_version for normal updates. Use convert_format only when the user explicitly asks to convert formats, such as Markdown to HTML.",
          },
        },
        required: ["user_update_request"],
      },
    },
    {
      name: COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME,
      description: "Cancel the active Coreview-native builder update for the selected artifact during Review with Sophia. Use this for requests like cancel the builder task, stop this update, or abort the build.",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "Short safe reason for cancellation." },
        },
        required: [],
      },
    },
    {
      name: COREVIEW_GET_BUILDER_STATUS_TOOL_NAME,
      description: "Get safe status for the active Coreview-native builder update without raw artifact text or frames.",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "Short safe reason for checking status." },
        },
        required: [],
      },
    },
  ]
}

export function coreviewBuilderToolExceptionResult(
  call: CoreviewBuilderToolCallInput,
  _error: unknown,
): CoreviewBuilderActionResult {
  return builderResult({
    ok: false,
    action: call.name,
    result: "failed",
    blockedReason: call.name === COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME
      ? "builder_cancel_failed"
      : "builder_action_unavailable",
    userFacingMessage: "Artifact update action failed.",
  })
}

export function buildCoreviewBuilderUpdatePrompt(context: CoreviewArtifactUpdateContext): string {
  const capabilitySummary = JSON.stringify(context.capabilitySummary)
  const useEditBuilderArtifact = (
    context.updateMode === "revise_version"
    || context.updateMode === "update_existing"
    || context.updateMode === "repair_artifact"
  )
  const lines = [
    "Coreview artifact update request.",
    "",
    `User request: ${context.userUpdateRequest}`,
    `Requested change summary: ${context.requestedChangeSummary}`,
    `Update mode: ${context.updateMode}`,
    `Artifact title: ${context.artifactTitle ?? "Untitled artifact"}`,
    `Artifact path: ${context.artifactPath ?? "unavailable"}`,
    `Renderer: ${context.rendererKind}`,
    `Workspace key: ${context.workspaceKey}`,
    context.artifactStableIdentity ? `Stable artifact identity: ${context.artifactStableIdentity}` : null,
    context.currentPage ? `Current page: ${context.currentPage} of ${context.pageCount ?? context.currentPage}` : null,
    context.viewSignature ? `Current view signature: ${context.viewSignature}` : null,
    context.originalArtifactHref ? `Original artifact href: ${context.originalArtifactHref}` : null,
    `Session id: ${context.sessionId ?? "unavailable"}`,
    `Thread id: ${context.threadId ?? "unavailable"}`,
    `Annotations: ${context.annotationCounts.annotationCount} total, ${context.annotationCounts.commentCount} comments, ${context.annotationCounts.highlightCount} highlights.`,
    `Selected annotation count: ${context.selectedAnnotationIds?.length ?? 0}`,
    `Capability summary: ${capabilitySummary}`,
    "",
    "Builder instructions:",
    "- This is a revise current artifact request, not an unrelated new document request.",
    useEditBuilderArtifact
      ? "- Use edit_builder_artifact with message set to the user's requested change and artifact_path set to the selected Artifact path above."
      : "- Use start_builder_task with this brief because this request is a fresh build or format conversion rather than a same-format source revision.",
    "- Use start_builder_task only when the user explicitly wants a fresh deliverable, a format conversion, or edit_builder_artifact reports no durable source artifact.",
    "- Do not call emit_artifact for this co-review update.",
    "- Update/revise the current artifact identified by the selected artifact path and stable identity.",
    "- Preserve the current artifact when possible.",
    "- Prefer creating a new version instead of silently overwriting the original.",
    "- Keep the original artifact accessible.",
    "- Represent the result as an update or new version of the selected artifact, not a fresh unrelated document.",
    "- Keep the same format if the selected renderer supports it.",
    "- If the selected artifact is HTML, preserve an HTML target and write the updated version as HTML.",
    "- If the selected artifact is Markdown, revise Markdown unless the user explicitly requested conversion.",
    "- If this is a Markdown fallback from an HTML request, do not pretend it is HTML; convert to HTML only when explicitly requested or truthfully report the unsupported/fallback path.",
    "- Use the artifact path and renderer capability summary as the source context.",
    "- Do not include raw artifact text, raw frames, or raw comment text in status/telemetry.",
  ].filter(Boolean)

  return lines.join("\n")
}

export function summarizeRequestedChange(value: string | null | undefined): string {
  const normalized = normalizeUserUpdateRequest(value)
  if (!normalized) {
    return "Update selected artifact"
  }
  return normalized
    .replace(/\s+/gu, " ")
    .replace(/["'`][^"'`]{120,}["'`]/gu, "[long quoted text omitted]")
    .slice(0, 160)
}

function normalizeUserUpdateRequest(value: string | null | undefined): string {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim().slice(0, 800)
    : "Update this artifact."
}

function resolveUpdateMode(
  requestedMode: CoreviewArtifactUpdateMode | null | undefined,
  current: CoreviewCurrentView,
): CoreviewArtifactUpdateMode {
  if (requestedMode) {
    return requestedMode
  }
  return current.capabilities.preferredUpdateMode ?? "revise_version"
}

function updateUnsupportedReason(context: CoreviewArtifactUpdateContext): string | null {
  if (!context.capabilitySummary.supportsArtifactUpdate) {
    return context.capabilitySummary.unsupportedUpdateReason
      ?? "This artifact format cannot be updated from Coreview yet."
  }
  if (
    context.updateMode === "update_existing"
    && !context.capabilitySummary.supportsScopedEdit
    && !context.capabilitySummary.supportsOverwrite
  ) {
    return context.capabilitySummary.unsupportedUpdateReason
      ?? "This artifact can only be rebuilt as a new version right now."
  }
  if (
    context.updateMode === "convert_format"
    && !context.capabilitySummary.requiresConversion
    && !context.capabilitySummary.supportsSourceRead
  ) {
    return "This artifact does not have a supported conversion path from Coreview yet."
  }
  return null
}

function coreviewRequestArtifactUpdateInputFromArgs(
  args: Record<string, unknown>,
): CoreviewRequestArtifactUpdateInput {
  return {
    userUpdateRequest: stringFromAnyKey(
      args,
      "user_update_request",
      "userUpdateRequest",
      "requested_change_summary",
      "requestedChangeSummary",
      "change_summary",
      "changeSummary",
      "request",
      "summary",
    ) ?? "Update this artifact.",
    updateMode: updateModeFromArgs(args),
    sourceActor: sourceActorFromArgs(args) ?? "sophia",
  }
}

function updateModeFromArgs(args: Record<string, unknown>): CoreviewArtifactUpdateMode | null {
  const value = stringFromAnyKey(args, "update_mode", "updateMode")
  return value === "create_new"
    || value === "update_existing"
    || value === "revise_version"
    || value === "convert_format"
    || value === "repair_artifact"
    ? value
    : null
}

function sourceActorFromArgs(args: Record<string, unknown>): CoreviewBuilderSourceActor | null {
  const value = stringFromAnyKey(args, "source_actor", "sourceActor")
  return value === "user" || value === "sophia" || value === "system" ? value : null
}

function withDirectEditInterceptTelemetry(
  args: Record<string, unknown>,
  result: CoreviewBuilderActionResult,
): CoreviewBuilderActionResult {
  const routedFromTool = stringFromAnyKey(args, "routed_from_tool", "routedFromTool")
  if (routedFromTool !== "edit_builder_artifact") {
    return result
  }
  const directCallResult = result.ok
    ? "routed_to_coreview_update"
    : result.blockedReason ?? result.result
  return {
    ...result,
    editBuilderArtifactInterceptedByCoreview: true,
    editBuilderArtifactDirectCallResult: directCallResult,
    coreviewUpdateStateCreatedFromDirectEditTool: result.ok && (
      result.result === "task_started"
      || result.result === "update_requested"
    ),
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

function artifactTitleFromPath(path: string | null | undefined): string | null {
  if (typeof path !== "string" || !path.trim()) {
    return null
  }
  return path.split("/").filter(Boolean).pop() ?? null
}

function normalizeCancelStatus(
  value: CoreviewBuilderCancelAdapterResult["status"],
): CoreviewBuilderTaskStatus["phase"] {
  if (value === "completed") return "completed"
  if (value === "failed" || value === "timed_out" || value === "cancelled" || value === "running") return value
  return value === "error" ? "failed" : "cancelled"
}

function idleStatus(): CoreviewBuilderTaskStatus {
  return {
    phase: "idle",
    taskId: null,
    runId: null,
    cancellable: false,
    currentStep: null,
  }
}

const activeCoreviewBuilderTasks = new Map<string, CoreviewActiveBuilderTaskState>()

function activeCoreviewBuilderTaskKey(input: {
  workspaceKey: string
  artifactStableIdentity: string | null
  artifactPath: string | null
}): string {
  return [
    input.workspaceKey,
    input.artifactStableIdentity ?? input.artifactPath ?? "no-artifact",
  ].join("::")
}

function upsertActiveCoreviewBuilderTaskState(
  context: CoreviewArtifactUpdateContext,
  update: {
    status: CoreviewBuilderTaskStatus["phase"]
    taskId?: string | null
    runId?: string | null
    cancellable?: boolean | null
    currentStep?: string | null
  },
): CoreviewActiveBuilderTaskState {
  const key = activeCoreviewBuilderTaskKey(context)
  const existing = activeCoreviewBuilderTasks.get(key)
  const now = new Date().toISOString()
  const taskId = update.taskId !== undefined ? normalizeTaskIdentity(update.taskId) : existing?.builderTaskId ?? null
  const runId = update.runId !== undefined ? normalizeTaskIdentity(update.runId) : existing?.builderRunId ?? null
  const state: CoreviewActiveBuilderTaskState = {
    workspaceKey: context.workspaceKey,
    artifactStableIdentity: context.artifactStableIdentity,
    artifactPath: context.artifactPath,
    rendererKind: context.rendererKind,
    requestedChangeSummary: context.requestedChangeSummary,
    builderTaskId: taskId,
    builderRunId: runId,
    status: update.status,
    phase: update.status,
    currentStep: update.currentStep !== undefined ? update.currentStep : existing?.currentStep ?? null,
    cancellable: update.cancellable ?? (update.status === "running" && Boolean(taskId)),
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  }
  activeCoreviewBuilderTasks.set(key, state)
  return state
}

function reconcileActiveCoreviewBuilderTaskState(
  context: CoreviewArtifactUpdateContext,
  liveTask: CoreviewBuilderTaskStatus | null,
): CoreviewActiveBuilderTaskState | null {
  const key = activeCoreviewBuilderTaskKey(context)
  const existing = activeCoreviewBuilderTasks.get(key)
  if (!existing) {
    return null
  }
  if (!liveTask) {
    return existing
  }
  return upsertActiveCoreviewBuilderTaskState(context, {
    status: liveTask.phase === "idle" ? existing.status : liveTask.phase,
    taskId: liveTask.taskId ?? existing.builderTaskId,
    runId: liveTask.runId ?? existing.builderRunId,
    cancellable: liveTask.cancellable,
    currentStep: liveTask.currentStep ?? existing.currentStep,
  })
}

function statusFromActiveCoreviewBuilderTaskState(
  state: CoreviewActiveBuilderTaskState,
): CoreviewBuilderTaskStatus {
  return {
    phase: state.phase,
    taskId: state.builderTaskId,
    runId: state.builderRunId,
    cancellable: state.cancellable && state.phase === "running" && Boolean(state.builderTaskId),
    currentStep: state.currentStep,
  }
}

function normalizeTaskIdentity(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function builderResult(
  input: Omit<
    CoreviewBuilderActionResult,
    "preservedMic" | "preservedReview" | "rawArtifactTextExcluded" | "rawFrameExcluded" | "rawCommentTextExcluded"
  >,
): CoreviewBuilderActionResult {
  return {
    ...input,
    updateMode: input.updateMode ?? input.context?.updateMode ?? null,
    rendererKind: input.rendererKind ?? input.context?.rendererKind ?? null,
    requestedChangeSummary: input.requestedChangeSummary ?? input.context?.requestedChangeSummary ?? null,
    preservedMic: true,
    preservedReview: true,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
    rawCommentTextExcluded: true,
  }
}

function unavailableBuilderToolResult(toolName: CoreviewBuilderToolName): CoreviewBuilderActionResult {
  return builderResult({
    ok: false,
    action: toolName,
    result: toolName === COREVIEW_CANCEL_BUILDER_TASK_TOOL_NAME
      ? "no_active_builder_task"
      : "failed",
    blockedReason: "builder_action_unavailable",
    userFacingMessage: "Artifact update actions are unavailable right now.",
  })
}
