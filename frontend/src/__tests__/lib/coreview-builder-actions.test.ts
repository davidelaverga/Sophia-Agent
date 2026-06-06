import { describe, expect, it, vi } from "vitest"

import { buildArtifactViewSignature } from "../../app/lib/artifact-renderers"
import type { CoreviewCurrentView } from "../../app/lib/coreview-actions"
import { getCoreviewArtifactCapabilities } from "../../app/lib/coreview-artifact-capabilities"
import {
  buildCoreviewBuilderUpdatePrompt,
  createCoreviewBuilderActionBus,
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
  cancelOk?: boolean
} = {}) {
  const events: CoreviewBuilderWorkspaceEventInput[] = []
  const start = vi.fn(() => ({
    ok: options.startOk ?? true,
    taskId: options.startTaskId ?? "task-1",
    runId: "run-1",
    userFacingMessage: "Sophia is updating this artifact.",
  }))
  const cancel = vi.fn(() => ({
    ok: options.cancelOk ?? true,
    taskId: options.activeTask?.taskId ?? "task-1",
    runId: options.activeTask?.runId ?? "run-1",
    status: options.cancelOk === false ? "failed" : "cancelled",
    userFacingMessage: options.cancelOk === false ? "Cancel failed." : "The artifact update was cancelled.",
  }))
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
    cancelBuilderTask: cancel,
  })
  return { bus, events, start, cancel }
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
    expect(harness.events.map((event) => event.type)).toEqual([
      "builder.update_requested",
      "builder.task_started",
    ])
    expect(JSON.stringify(result)).not.toContain("emit_artifact")
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

  it("cancel emits cancel requested and cancelled events", async () => {
    const harness = createHarness({ activeTask: createActiveTask() })

    const result = await harness.bus.cancelBuilderTask("user")

    expect(result).toMatchObject({
      ok: true,
      action: "coreview_cancel_builder_task",
      result: "cancelled",
      taskId: "task-1",
      runId: "run-1",
    })
    expect(harness.cancel).toHaveBeenCalledTimes(1)
    expect(harness.events.map((event) => event.type)).toEqual([
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

  it("returns status without exposing raw artifact text", () => {
    const harness = createHarness({ activeTask: createActiveTask() })

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

  it("builds a prompt that uses start_builder_task and not emit_artifact", () => {
    const context = createHarness().bus.buildUpdateContext({
      userUpdateRequest: "make a new version",
      updateMode: "revise_version",
    })

    expect(context).not.toBeNull()
    if (!context) throw new Error("expected update context")
    const prompt = buildCoreviewBuilderUpdatePrompt(context)
    expect(prompt).toContain("start_builder_task")
    expect(prompt).toContain("Do not call emit_artifact")
    expect(prompt).toContain("Prefer creating a new version")
  })
})
