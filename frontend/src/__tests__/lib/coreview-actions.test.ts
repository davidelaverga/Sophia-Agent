import { describe, expect, it } from "vitest"

import {
  buildArtifactViewSignature,
  type ArtifactFitMode,
} from "../../app/lib/artifact-renderers"
import {
  createCoreviewActionBus,
  type CoreviewCurrentView,
  type CoreviewRendererAdapter,
  type CoreviewToolRefreshResult,
} from "../../app/lib/coreview-actions"

function createHarness(options: Partial<CoreviewCurrentView> & {
  refreshOk?: boolean
  waitOk?: boolean
} = {}) {
  const refreshOk = options.refreshOk ?? true
  const waitOk = options.waitOk ?? true
  let refreshes = 0
  let staleSignature: string | null = null
  let current: CoreviewCurrentView = {
    artifactId: "artifact-1",
    artifactPath: "outputs/report.pdf",
    artifactTitle: "report.pdf",
    rendererKind: "pdf",
    supportsPagination: true,
    supportsZoom: true,
    pageIndex: 0,
    pageCount: 3,
    zoom: 1,
    fitMode: "page",
    viewSignature: null,
    stale: false,
    refreshInProgress: false,
    canRefresh: true,
    reviewActive: true,
    reviewHasFrame: true,
    exactTextAvailable: true,
    visualFrameFresh: true,
    annotationOverlayCaptured: false,
    ...options,
  }
  current.viewSignature = buildArtifactViewSignature({
    artifactId: current.artifactId,
    filePath: current.artifactPath,
    rendererKind: current.rendererKind,
    pageIndex: current.pageIndex,
    pageCount: current.pageCount,
    zoom: current.zoom,
    fitMode: current.fitMode,
  })

  const adapter: CoreviewRendererAdapter = {
    getCurrentViewState: () => current,
    setView: (view: { pageIndex: number; zoom: number; fitMode: ArtifactFitMode }) => {
      current = {
        ...current,
        pageIndex: view.pageIndex,
        zoom: view.zoom,
        fitMode: view.fitMode,
        viewSignature: buildArtifactViewSignature({
          artifactId: current.artifactId,
          filePath: current.artifactPath,
          rendererKind: current.rendererKind,
          pageIndex: view.pageIndex,
          pageCount: current.pageCount,
          zoom: view.zoom,
          fitMode: view.fitMode,
        }),
      }
    },
    refreshView: () => {
      refreshes += 1
      const refreshResult: CoreviewToolRefreshResult = refreshOk ? "success" : "error"
      return {
        ok: refreshOk,
        refreshResult,
        blockedReason: refreshOk ? null : "refresh_unavailable",
      }
    },
    waitForViewReady: async (_viewSignature) => ({
      ok: waitOk,
      waitMs: waitOk ? 12 : 2500,
      blockedReason: waitOk ? null : "view_ready_timeout",
    }),
    markViewStale: (viewSignature) => {
      staleSignature = viewSignature
      current = { ...current, stale: true, visualFrameFresh: false }
    },
    clearViewStale: (viewSignature) => {
      if (!viewSignature || staleSignature === viewSignature) {
        staleSignature = null
        current = { ...current, stale: false, visualFrameFresh: true }
      }
    },
  }

  return {
    bus: createCoreviewActionBus(adapter),
    get refreshes() {
      return refreshes
    },
    get staleSignature() {
      return staleSignature
    },
    get current() {
      return current
    },
  }
}

describe("Coreview action bus", () => {
  it("sets a PDF page by one-based page number, waits for readiness, and refreshes", async () => {
    const harness = createHarness()

    const result = await harness.bus.setView({ pageNumber: 2, reason: "go to page two" }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "set_view",
      page_index: 1,
      page_number: 2,
      page_count: 3,
      refresh_attempted: true,
      refresh_result: "success",
      blocked_reason: null,
      preserved_mic: true,
      preserved_review: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(harness.refreshes).toBe(1)
    expect(harness.staleSignature).toBeNull()
    expect(result.result_summary).toContain("page 2 of 3")
  })

  it("blocks page navigation when the requested page is out of range", async () => {
    const harness = createHarness()

    const result = await harness.bus.setView({ pageNumber: 9 }, "gemini_tool")

    expect(result.ok).toBe(false)
    expect(result.blocked_reason).toBe("requested_page_out_of_bounds")
    expect(result.refresh_attempted).toBe(false)
    expect(harness.refreshes).toBe(0)
    expect(harness.current.pageIndex).toBe(0)
  })

  it("blocks Coreview actions when no artifact is selected", () => {
    const harness = createHarness({ artifactId: null })

    const result = harness.bus.getCurrentView(undefined, "gemini_tool")

    expect(result.ok).toBe(false)
    expect(result.blocked_reason).toBe("no_selected_artifact")
    expect(result.raw_artifact_text_excluded).toBe(true)
    expect(result.raw_frame_excluded).toBe(true)
  })

  it("blocks page actions on renderers without pagination", async () => {
    const harness = createHarness({
      rendererKind: "markdown",
      supportsPagination: false,
      pageCount: 1,
    })

    const result = await harness.bus.setView({ pageNumber: 2 }, "gemini_tool")

    expect(result.ok).toBe(false)
    expect(result.blocked_reason).toBe("unsupported_pages")
    expect(harness.refreshes).toBe(0)
  })

  it("keeps stale state when refresh fails after a view change", async () => {
    const harness = createHarness({ refreshOk: false })

    const result = await harness.bus.setView({ pageNumber: 3 }, "gemini_tool")

    expect(result.ok).toBe(false)
    expect(result.page_number).toBe(3)
    expect(result.refresh_attempted).toBe(true)
    expect(result.refresh_result).toBe("error")
    expect(result.blocked_reason).toBe("refresh_unavailable")
    expect(result.stale).toBe(true)
    expect(harness.staleSignature).toBe(result.view_signature_after)
  })

  it("returns current view metadata without raw artifact text or frames", () => {
    const harness = createHarness({ pageIndex: 1, fitMode: "width" })

    const result = harness.bus.getCurrentView(undefined, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "get_current_view",
      page_index: 1,
      page_number: 2,
      fit_mode: "width",
      exact_text_available: true,
      annotation_overlay_captured: false,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(JSON.stringify(result)).not.toContain("base64")
  })
})
