import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildArtifactViewSignature } from "../../app/lib/artifact-renderers"
import type { CoreviewCurrentView } from "../../app/lib/coreview-actions"
import {
  buildCoreviewCapabilitySummary,
  getCoreviewArtifactCapabilities,
} from "../../app/lib/coreview-artifact-capabilities"
import {
  buildCoreviewBuilderUpdatePrompt,
  clearCoreviewBuilderTaskStateForTests,
  createCoreviewBuilderActionBus,
  resolveCoreviewBuilderActionAvailability,
  type CoreviewBuilderActionAdapter,
  type CoreviewBuilderWorkspaceEventInput,
} from "../../app/lib/coreview-builder-actions"

function createView(options: Partial<CoreviewCurrentView> = {}): CoreviewCurrentView {
  const rendererKind = options.rendererKind ?? "html"
  const artifactPath = Object.prototype.hasOwnProperty.call(options, "artifactPath")
    ? options.artifactPath ?? null
    : "mnt/user-data/outputs/site.html"
  const capabilities = options.capabilities ?? getCoreviewArtifactCapabilities({
    rendererKind,
    artifactPath,
    title: options.artifactTitle ?? "site.html",
    originalDownloadAvailable: Boolean(artifactPath),
    openInNewTabAvailable: Boolean(artifactPath),
  })
  const base: CoreviewCurrentView = {
    artifactId: "artifact-1",
    artifactPath,
    artifactTitle: "site.html",
    artifactStableIdentity: "user:unknown|thread:thread-1|path:mnt/user-data/outputs/site.html|renderer:html",
    rendererKind,
    capabilities,
    supportsPagination: capabilities.supportsPages,
    supportsZoom: capabilities.supportsZoom,
    pageIndex: 0,
    pageCount: 1,
    zoom: 1,
    fitMode: "custom",
    viewSignature: null,
    stale: false,
    refreshInProgress: false,
    canRefresh: true,
    reviewActive: true,
    reviewHasFrame: true,
    exactTextAvailable: true,
    visualFrameFresh: true,
    annotationOverlayCaptured: false,
    annotationCount: 2,
    highlightCount: 1,
    commentCount: 1,
    underlineCount: 0,
    arrowCount: 0,
    drawPathCount: 0,
    rebindStatus: "not_attempted",
    ...options,
  }
  return {
    ...base,
    viewSignature: options.viewSignature ?? buildArtifactViewSignature({
      artifactId: base.artifactId,
      filePath: base.artifactPath,
      rendererKind: base.rendererKind,
      pageIndex: base.pageIndex,
      pageCount: base.pageCount,
      zoom: base.zoom,
      fitMode: base.fitMode,
    }),
  }
}

function createHarness(options: {
  current?: CoreviewCurrentView
  activeTask?: ReturnType<typeof createActiveTask> | null
  startOk?: boolean
  startTaskId?: string | null
  startRunId?: string | null
  cancelOk?: boolean
  quickPatchResponse?: {
    ok: boolean
    result: "patched" | "unsupported" | "failed"
    revision_artifact_path?: string | null
    revision_path_hash?: string | null
    fallback_reason?: string | null
    preserved_original?: boolean
    raw_html_excluded: true
    raw_artifact_text_excluded: true
  } | null
} = {}) {
  const events: CoreviewBuilderWorkspaceEventInput[] = []
  const start = vi.fn<CoreviewBuilderActionAdapter["startBuilderTask"]>(() => ({
    ok: options.startOk ?? true,
    taskId: Object.prototype.hasOwnProperty.call(options, "startTaskId") ? options.startTaskId ?? null : "task-1",
    runId: Object.prototype.hasOwnProperty.call(options, "startRunId") ? options.startRunId ?? null : "run-1",
    userFacingMessage: "Sophia is updating this artifact.",
  }))
  const cancel = vi.fn<CoreviewBuilderActionAdapter["cancelBuilderTask"]>(() => ({
    ok: options.cancelOk ?? true,
    taskId: options.activeTask?.taskId ?? "task-1",
    runId: options.activeTask?.runId ?? "run-1",
    status: options.cancelOk === false ? "failed" : "cancelled",
    userFacingMessage: options.cancelOk === false ? "Cancel failed." : "The artifact update was cancelled.",
  }))
  const quickPatch = vi.fn<NonNullable<CoreviewBuilderActionAdapter["quickPatchHtmlArtifact"]>>(() => (
    options.quickPatchResponse ?? {
      ok: false,
      result: "unsupported",
      fallback_reason: "unsupported_quick_patch",
      raw_html_excluded: true,
      raw_artifact_text_excluded: true,
    }
  ))
  const bus = createCoreviewBuilderActionBus({
    getCurrentView: () => options.current ?? createView(),
    getWorkspaceKey: () => "user:unknown|thread:thread-1",
    getSessionIds: () => ({
      sessionId: "session-1",
      threadId: "thread-1",
      parentThreadId: "thread-1",
    }),
    getOriginalArtifactHref: () => "/api/threads/thread-1/artifacts/mnt/user-data/outputs/site.html",
    getSelectedAnnotationIds: () => ["annotation-1"],
    getActiveBuilderTask: () => options.activeTask ?? null,
    getLatestOutput: () => ({
      artifactPath: "mnt/user-data/outputs/site-v2.html",
      artifactTitle: "site-v2.html",
    }),
    emitWorkspaceEvent: (event) => {
      events.push(event)
    },
    startBuilderTask: start,
    quickPatchHtmlArtifact: quickPatch,
    cancelBuilderTask: cancel,
  })
  return { bus, events, start, cancel, quickPatch }
}

function createActiveTask() {
  return {
    phase: "running" as const,
    taskId: "task-1",
    runId: "run-1",
    cancellable: true,
    currentStep: "Updating layout",
  }
}

describe("Coreview builder action bus", () => {
  beforeEach(() => {
    clearCoreviewBuilderTaskStateForTests()
  })

  it("enables builder actions for selected HTML artifacts with review tool support", () => {
    const view = createView({
      rendererKind: "html",
      annotationCount: 0,
      highlightCount: 0,
      commentCount: 0,
    })

    const availability = resolveCoreviewBuilderActionAvailability({
      coreviewEnabled: true,
      artifactSelected: true,
      artifactPath: view.artifactPath,
      rendererKind: view.rendererKind,
      capabilitySummary: buildCoreviewCapabilitySummary({
        capabilities: view.capabilities,
        rendererKind: view.rendererKind,
        pageIndex: view.pageIndex,
        pageCount: view.pageCount,
      }),
      requestArtifactUpdateWired: true,
      cancelBuilderTaskWired: true,
    })

    expect(view.capabilities.supportsAnnotations).toBe(true)
    expect(view.capabilities.supportsZoom).toBe(true)
    expect(availability).toMatchObject({
      enabled: true,
      blockedReason: null,
      supportsArtifactUpdate: true,
      supportsVersionedRebuild: true,
    })
  })

  it("enables Markdown revisions when a readable source path exists", () => {
    const view = createView({
      rendererKind: "markdown",
      artifactPath: "mnt/user-data/outputs/notes.md",
      artifactTitle: "notes.md",
    })

    const availability = resolveCoreviewBuilderActionAvailability({
      coreviewEnabled: true,
      artifactSelected: true,
      artifactPath: view.artifactPath,
      rendererKind: view.rendererKind,
      capabilitySummary: buildCoreviewCapabilitySummary({
        capabilities: view.capabilities,
        rendererKind: view.rendererKind,
        pageIndex: view.pageIndex,
        pageCount: view.pageCount,
      }),
      requestArtifactUpdateWired: true,
      cancelBuilderTaskWired: true,
    })

    expect(availability).toMatchObject({
      enabled: true,
      blockedReason: null,
      supportsArtifactUpdate: true,
      supportsVersionedRebuild: true,
    })
  })

  it("truthfully disables unsupported PDF native updates", () => {
    const view = createView({
      rendererKind: "pdf",
      artifactPath: "mnt/user-data/outputs/report.pdf",
      artifactTitle: "report.pdf",
    })

    const availability = resolveCoreviewBuilderActionAvailability({
      coreviewEnabled: true,
      artifactSelected: true,
      artifactPath: view.artifactPath,
      rendererKind: view.rendererKind,
      capabilitySummary: buildCoreviewCapabilitySummary({
        capabilities: view.capabilities,
        rendererKind: view.rendererKind,
        pageIndex: view.pageIndex,
        pageCount: view.pageCount,
      }),
      requestArtifactUpdateWired: true,
      cancelBuilderTaskWired: true,
    })

    expect(availability.enabled).toBe(false)
    expect(availability.blockedReason).toBe("unsupported_renderer")
    expect(availability.unsupportedUpdateReason).toContain("PDF native editing")
    expect(availability.supportsArtifactUpdate).toBe(false)
  })

  it("coreview_request_artifact_update succeeds with selected artifact context", async () => {
    const harness = createHarness()

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_request_artifact_update",
      result: "task_started",
      taskId: "task-1",
      runId: "run-1",
      updateMode: "revise_version",
      preservedMic: true,
      preservedReview: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    })
    expect(result.context).toMatchObject({
      workspaceKey: "user:unknown|thread:thread-1",
      artifactPath: "mnt/user-data/outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
      currentPage: null,
      pageCount: null,
      annotationCounts: {
        annotationCount: 2,
        commentCount: 1,
      },
      userUpdateRequest: "make the cards more premium",
      requestedChangeSummary: "make the cards more premium",
    })
    expect(harness.start).toHaveBeenCalledTimes(1)
    expect(harness.start.mock.calls[0]?.[0].prompt).toContain("revise current artifact")
    expect(harness.start.mock.calls[0]?.[0].prompt).toContain("Artifact path: mnt/user-data/outputs/site.html")
    expect(harness.start.mock.calls[0]?.[0].prompt).toContain("Stable artifact identity")
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
      "builder.task_started",
    ])
    expect(JSON.stringify(result)).not.toContain("emit_artifact")
  })

  it("uses quick HTML patch for simple title edits without starting the full builder", async () => {
    const harness = createHarness({
      quickPatchResponse: {
        ok: true,
        result: "patched",
        revision_artifact_path: "mnt/user-data/outputs/site-quick-1234abcd.html",
        revision_path_hash: "path-hash",
        preserved_original: true,
        raw_html_excluded: true,
        raw_artifact_text_excluded: true,
      },
    })

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "Change the main title to Sophia Workspace Version Two",
    })

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_request_artifact_update",
      result: "quick_patch_applied",
      latestOutput: {
        artifactPath: "mnt/user-data/outputs/site-quick-1234abcd.html",
        artifactTitle: "site-quick-1234abcd.html",
      },
      htmlQuickPatch: {
        eligible: true,
        attempted: true,
        result: "patched",
        kind: "title",
        usedFullBuilder: false,
        preservedOriginal: true,
        revisionPathHash: "path-hash",
      },
    })
    expect(harness.quickPatch).toHaveBeenCalledTimes(1)
    expect(harness.quickPatch.mock.calls[0]?.[0].classification).toMatchObject({
      supported: true,
      quickEditKind: "title",
      targetFields: {
        titleText: "Sophia Workspace Version Two",
      },
    })
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
    ])
  })

  it("falls back to full builder when a quick HTML patch is unsupported", async () => {
    const harness = createHarness({
      quickPatchResponse: {
        ok: false,
        result: "unsupported",
        fallback_reason: "card_css_target_not_found",
        raw_html_excluded: true,
        raw_artifact_text_excluded: true,
      },
    })

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "Make the cards darker",
    })

    expect(result).toMatchObject({
      ok: true,
      result: "task_started",
      htmlQuickPatch: {
        eligible: true,
        attempted: true,
        result: "unsupported",
        kind: "cards_darker",
        fallbackReason: "card_css_target_not_found",
        usedFullBuilder: true,
      },
    })
    expect(harness.quickPatch).toHaveBeenCalledTimes(1)
    expect(harness.start).toHaveBeenCalledTimes(1)
    expect(harness.start.mock.calls[0]?.[0].prompt).toContain("Use edit_builder_artifact")
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
      "builder.task_started",
    ])
  })

  it("stores active Coreview builder task state after requesting an update", async () => {
    const harness = createHarness()

    await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })

    const status = harness.bus.getBuilderStatus("user")
    expect(status).toMatchObject({
      ok: true,
      action: "coreview_get_builder_status",
      result: "status",
      taskId: "task-1",
      runId: "run-1",
      status: {
        phase: "running",
        taskId: "task-1",
        runId: "run-1",
      },
    })
  })

  it("creates Coreview active update state when a direct edit tool is routed through the request handler", async () => {
    const harness = createHarness()

    const result = await harness.bus.handleToolCall({
      id: "direct-edit-1",
      name: "coreview_request_artifact_update",
      args: {
        user_update_request: "change the title card",
        update_mode: "revise_version",
        routed_from_tool: "edit_builder_artifact",
      },
    })
    const status = harness.bus.getBuilderStatus("user")

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_request_artifact_update",
      result: "task_started",
      updateMode: "revise_version",
      editBuilderArtifactInterceptedByCoreview: true,
      editBuilderArtifactDirectCallResult: "routed_to_coreview_update",
      coreviewUpdateStateCreatedFromDirectEditTool: true,
    })
    expect(status).toMatchObject({
      ok: true,
      result: "status",
      status: {
        phase: "running",
        currentStep: "Applying update...",
      },
    })
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
      "builder.task_started",
    ])
  })

  it("returns starting status after request when the builder task id is not known yet", async () => {
    const harness = createHarness({ startTaskId: null, startRunId: null })

    const request = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })
    const status = harness.bus.getBuilderStatus("user")

    expect(request).toMatchObject({
      ok: true,
      result: "update_requested",
      taskId: null,
      runId: null,
    })
    expect(status).toMatchObject({
      ok: true,
      action: "coreview_get_builder_status",
      result: "status",
      status: {
        phase: "starting",
        taskId: null,
        runId: null,
        cancellable: false,
      },
      userFacingMessage: "The update has not started yet. I'll keep the review open.",
    })
    expect(JSON.stringify(status)).not.toContain("builder-thread-id")
  })

  it("reconciles pending Coreview builder state when builder ids arrive from canvas state", async () => {
    const pendingHarness = createHarness({ startTaskId: null, startRunId: null })
    await pendingHarness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })
    const reconciledHarness = createHarness({ activeTask: createActiveTask(), startTaskId: null, startRunId: null })

    const status = reconciledHarness.bus.getBuilderStatus("user")

    expect(status).toMatchObject({
      ok: true,
      result: "status",
      taskId: "task-1",
      runId: "run-1",
      status: {
        phase: "running",
        taskId: "task-1",
        runId: "run-1",
      },
    })
  })

  it("coreview_request_artifact_update fails safely with no selected artifact", async () => {
    const harness = createHarness({
      current: createView({ artifactId: null, artifactPath: null }),
    })

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "update this artifact",
    })

    expect(result).toMatchObject({
      ok: false,
      result: "failed",
      blockedReason: "no_selected_artifact",
      preservedMic: true,
      preservedReview: true,
    })
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.events).toHaveLength(0)
  })

  it("blocks unsupported renderer/update mode truthfully", async () => {
    const harness = createHarness({
      current: createView({
        rendererKind: "pdf",
        artifactPath: "mnt/user-data/outputs/report.pdf",
        artifactTitle: "report.pdf",
      }),
    })

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "change the title",
    })

    expect(result).toMatchObject({
      ok: false,
      action: "coreview_request_artifact_update",
      result: "unsupported",
    })
    expect(result.blockedReason).toContain("PDF native editing")
    expect(harness.start).not.toHaveBeenCalled()
    expect(harness.events).toHaveLength(0)
  })

  it("cancel uses active Coreview builder task state from the update request", async () => {
    const harness = createHarness()

    await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })

    const result = await harness.bus.cancelBuilderTask("user")

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_cancel_builder_task",
      result: "cancelled",
      taskId: "task-1",
      runId: "run-1",
    })
    expect(harness.cancel).toHaveBeenCalledTimes(1)
    expect(harness.cancel.mock.calls[0]?.[0].task).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
    })
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
      "builder.task_started",
      "builder.task_cancel_requested",
      "builder.task_cancelled",
    ])
  })

  it("cancel with no active task returns no_active_builder_task", async () => {
    const harness = createHarness()

    const result = await harness.bus.cancelBuilderTask("user")

    expect(result).toMatchObject({
      ok: false,
      action: "coreview_cancel_builder_task",
      result: "no_active_builder_task",
      blockedReason: "no_active_builder_task",
    })
    expect(harness.cancel).not.toHaveBeenCalled()
    expect(harness.events).toHaveLength(0)
  })

  it("coreview_get_builder_status with no active task returns no_active_builder_task", () => {
    const harness = createHarness()

    const result = harness.bus.getBuilderStatus("user")

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_get_builder_status",
      result: "no_active_builder_task",
      blockedReason: "no_active_builder_task",
      userFacingMessage: "I don't see an active artifact update right now.",
      status: {
        phase: "idle",
        taskId: null,
        runId: null,
        cancellable: false,
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/task id|tracking that specific task|listing all/i)
  })

  it("returns status without exposing raw artifact text", async () => {
    const harness = createHarness({ activeTask: createActiveTask() })

    await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards more premium",
    })
    const result = harness.bus.getBuilderStatus("user")

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_get_builder_status",
      result: "status",
      status: {
        phase: "running",
        cancellable: true,
        currentStep: "Updating layout",
      },
      latestOutput: {
        artifactPath: "mnt/user-data/outputs/site-v2.html",
      },
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    })
  })

  it("builds a prompt that uses edit_builder_artifact and not emit_artifact", () => {
    const context = createHarness().bus.buildUpdateContext({
      userUpdateRequest: "make a new version",
      updateMode: "revise_version",
    })

    expect(context).not.toBeNull()
    if (!context) throw new Error("expected update context")
    const prompt = buildCoreviewBuilderUpdatePrompt(context)
    expect(prompt).toContain("edit_builder_artifact")
    expect(prompt).toContain("Use start_builder_task only")
    expect(prompt).toContain("revise current artifact")
    expect(prompt).toContain("Do not call emit_artifact")
    expect(prompt).toContain("Prefer creating a new version")
    expect(prompt).toContain("If the selected artifact is HTML")
    expect(prompt).toContain("If the selected artifact is Markdown")
  })

  it("allows explicit Markdown-to-HTML conversion requests through versioned rebuild", async () => {
    const current = createView({
      rendererKind: "markdown",
      artifactPath: "mnt/user-data/outputs/site-fallback.md",
      artifactTitle: "site-fallback.md",
      artifactStableIdentity: "user:unknown|thread:thread-1|path:mnt/user-data/outputs/site-fallback.md|renderer:markdown",
    })
    const harness = createHarness({ current })

    const result = await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "rebuild this as HTML",
      updateMode: "convert_format",
    })

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_request_artifact_update",
      result: "task_started",
      updateMode: "convert_format",
      rendererKind: "markdown",
    })
    expect(harness.start).toHaveBeenCalledTimes(1)
    const request = harness.start.mock.calls[0]?.[0]
    expect(request?.context).toMatchObject({
      artifactPath: "mnt/user-data/outputs/site-fallback.md",
      rendererKind: "markdown",
      updateMode: "convert_format",
    })
    expect(request?.prompt).toContain("Renderer: markdown")
    expect(request?.prompt).toContain("do not pretend it is HTML")
  })

  it("preserves an HTML target when the selected artifact renderer is HTML", async () => {
    const harness = createHarness({
      current: createView({
        rendererKind: "html",
        artifactPath: "mnt/user-data/outputs/current-site.html",
        artifactTitle: "current-site.html",
        artifactStableIdentity: "user:unknown|thread:thread-1|path:mnt/user-data/outputs/current-site.html|renderer:html",
      }),
    })

    await harness.bus.requestArtifactUpdate({
      userUpdateRequest: "make the cards darker",
    })

    const request = harness.start.mock.calls[0]?.[0]
    expect(request?.context).toMatchObject({
      artifactPath: "mnt/user-data/outputs/current-site.html",
      rendererKind: "html",
    })
    expect(request?.prompt).toContain("If the selected artifact is HTML, preserve an HTML target")
  })
})
