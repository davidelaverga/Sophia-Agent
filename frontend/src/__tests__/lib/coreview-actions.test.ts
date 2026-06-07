import { describe, expect, it } from "vitest"

import {
  buildArtifactViewSignature,
} from "../../app/lib/artifact-renderers"
import {
  COREVIEW_ADD_ANNOTATION_TOOL_NAME,
  createCoreviewActionBus,
  coreviewGeminiFunctionDeclarations,
  withCoreviewGeminiToolDeclarations,
  type CoreviewCurrentView,
  type CoreviewRendererAdapter,
  type CoreviewResolvedAnnotationAnchor,
  type CoreviewSetViewAdapterInput,
  type CoreviewSetViewAdapterResult,
  type CoreviewToolBlockedReason,
  type CoreviewToolRefreshResult,
} from "../../app/lib/coreview-actions"
import { getCoreviewArtifactCapabilities } from "../../app/lib/coreview-artifact-capabilities"

function createHarness(options: Partial<CoreviewCurrentView> & {
  refreshOk?: boolean
  waitOk?: boolean
  annotationCommitNoop?: boolean
  htmlSetViewFailure?: CoreviewToolBlockedReason
  rebindCurrent?: Partial<CoreviewCurrentView>
  rebindOk?: boolean
  rebindReason?: string | null
} = {}) {
  const {
    refreshOk = true,
    waitOk = true,
    annotationCommitNoop = false,
    htmlSetViewFailure,
    rebindCurrent,
    rebindOk = true,
    rebindReason = null,
    ...currentOptions
  } = options
  let refreshes = 0
  let focusCalls = 0
  let staleSignature: string | null = null
  let annotations: Array<{ kind: "highlight" | "comment" | "underline" | "arrow" }> = []
  const focusedAnchors: CoreviewResolvedAnnotationAnchor[] = []
  const defaultCapabilities = getCoreviewArtifactCapabilities({
    rendererKind: "pdf",
    artifactPath: "outputs/report.pdf",
    exactTextAvailable: true,
    textExtractionStatus: "success",
    layoutAnchorsAvailable: true,
  })
  let current: CoreviewCurrentView = {
    artifactId: "artifact-1",
    artifactPath: "outputs/report.pdf",
    artifactTitle: "report.pdf",
    rendererKind: "pdf",
    capabilities: defaultCapabilities,
    supportsPagination: defaultCapabilities.supportsPages,
    supportsZoom: defaultCapabilities.supportsZoom,
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
    annotationCount: 0,
    highlightCount: 0,
    commentCount: 0,
    underlineCount: 0,
    arrowCount: 0,
    drawPathCount: 0,
    ...currentOptions,
  }
  current.capabilities = currentOptions.capabilities ?? getCoreviewArtifactCapabilities({
    rendererKind: current.rendererKind,
    artifactPath: current.artifactPath,
    title: current.artifactTitle,
    exactTextAvailable: current.exactTextAvailable,
    textExtractionStatus: current.exactTextAvailable ? "success" : "unavailable",
    layoutAnchorsAvailable: current.rendererKind === "pdf" && current.exactTextAvailable,
  })
  current.supportsPagination = currentOptions.supportsPagination ?? current.capabilities.supportsPages
  current.supportsZoom = currentOptions.supportsZoom ?? current.capabilities.supportsZoom
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
    setView: (view: CoreviewSetViewAdapterInput): CoreviewSetViewAdapterResult | void => {
      const htmlScrollAttempted = current.rendererKind === "html" && (
        typeof view.htmlScrollDelta === "number"
        || Boolean(view.htmlScrollPosition)
      )
      if (htmlScrollAttempted && htmlSetViewFailure) {
        return {
          ok: false,
          blockedReason: htmlSetViewFailure,
          method: "heading",
          scrolled: false,
          htmlNavigationRouterUsed: true,
          htmlNavigationCommandKind: typeof view.htmlScrollDelta === "number" ? "scroll_by" : "scroll_to",
          htmlNavigationTargetSafe: view.htmlScrollPosition ?? null,
          htmlNavigationTargetKind: view.htmlScrollPosition ?? "unknown",
          htmlNavigationResult: htmlSetViewFailure,
          htmlNavigationFailureReason: htmlSetViewFailure,
          htmlNavigationScrollTopBefore: current.scrollTop ?? null,
          htmlNavigationScrollTopAfter: current.scrollTop ?? null,
          htmlNavigationScrolled: false,
          htmlNavigationCommandId: "test-html-command",
          htmlNavigationTimedOut: htmlSetViewFailure === "iframe_not_ready",
          htmlNavigationWaitedForReady: htmlSetViewFailure === "iframe_not_ready",
          htmlNavigationPreventedPdfFallback: true,
          htmlVoiceNavigationUsedSameResolver: true,
        }
      }
      const nextScrollTop = typeof view.htmlScrollDelta === "number"
        ? Math.max(0, (current.scrollTop ?? 0) + view.htmlScrollDelta)
        : view.htmlScrollPosition === "top"
          ? 0
          : view.htmlScrollPosition === "bottom"
            ? Math.max(0, (current.scrollHeight ?? 0) - (current.viewportHeight ?? 0))
            : current.scrollTop
      current = {
        ...current,
        pageIndex: view.pageIndex,
        zoom: view.zoom,
        fitMode: view.fitMode,
        scrollTop: nextScrollTop,
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
    resolveAnnotationAnchor: ({ anchor, pageIndex }) => {
      if (current.rendererKind !== "pdf") {
        return { ok: false, blockedReason: "unsupported_renderer" }
      }
      if (anchor.type === "current_title") {
        return {
          ok: true,
          anchor: {
            anchorType: "current_title",
            pageIndex,
            rect: { x: 0.12, y: 0.08, width: 0.62, height: 0.07 },
            point: null,
          },
        }
      }
      if (anchor.type === "text_quote") {
        return /budget/iu.test(anchor.text)
          ? {
              ok: true,
              anchor: {
                anchorType: "text_quote",
                pageIndex,
                rect: { x: 0.2, y: 0.32, width: 0.38, height: 0.04 },
                point: null,
              },
            }
          : { ok: false, blockedReason: "anchor_not_found" }
      }
      if (anchor.type === "rect") {
        return {
          ok: true,
          anchor: {
            anchorType: "rect",
            pageIndex,
            rect: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
            point: null,
          },
        }
      }
      if (anchor.type === "point") {
        return {
          ok: true,
          anchor: {
            anchorType: "point",
            pageIndex,
            rect: null,
            point: { x: anchor.x, y: anchor.y },
          },
        }
      }
      return { ok: false, blockedReason: "anchor_not_found" }
    },
    addAnnotation: (input) => {
      if (annotationCommitNoop) {
        return {
          ok: true,
          annotationId: `${input.kind}-noop`,
          blockedReason: null,
          annotationCount: current.annotationCount,
          highlightCount: current.highlightCount,
          commentCount: current.commentCount,
          underlineCount: current.underlineCount ?? 0,
          arrowCount: current.arrowCount ?? 0,
          drawPathCount: current.drawPathCount ?? 0,
        }
      }
      annotations = [...annotations, { kind: input.kind }]
      const highlightCount = annotations.filter((annotation) => annotation.kind === "highlight").length
      const commentCount = annotations.filter((annotation) => annotation.kind === "comment").length
      const underlineCount = annotations.filter((annotation) => annotation.kind === "underline").length
      const arrowCount = annotations.filter((annotation) => annotation.kind === "arrow").length
      current = {
        ...current,
        annotationOverlayCaptured: annotations.length > 0,
        annotationCount: annotations.length,
        highlightCount,
        commentCount,
        underlineCount,
        arrowCount,
        drawPathCount: 0,
      }
      return {
        ok: true,
        annotationId: `${input.kind}-${annotations.length}`,
        blockedReason: null,
        annotationCount: annotations.length,
        highlightCount,
        commentCount,
        underlineCount,
        arrowCount,
        drawPathCount: 0,
      }
    },
    focusAnnotationAnchor: (input) => {
      focusCalls += 1
      focusedAnchors.push(input.anchor)
      current = {
        ...current,
        pageIndex: input.pageIndex,
        zoom: input.zoom,
        fitMode: input.fitMode,
        viewSignature: buildArtifactViewSignature({
          artifactId: current.artifactId,
          filePath: current.artifactPath,
          rendererKind: current.rendererKind,
          pageIndex: input.pageIndex,
          pageCount: current.pageCount,
          zoom: input.zoom,
          fitMode: input.fitMode,
        }),
      }
      return {
        ok: true,
        blockedReason: null,
      }
    },
  }
  if (rebindCurrent) {
    adapter.rebindVisibleArtifact = (input) => {
      current = {
        ...current,
        ...rebindCurrent,
        rebindStatus: rebindOk ? "success" : "failed",
      }
      return {
        ok: rebindOk,
        status: rebindOk ? "success" : "failed",
        reason: rebindReason ?? input.reason,
        currentView: current,
      }
    }
  }

  return {
    bus: createCoreviewActionBus(adapter),
    get refreshes() {
      return refreshes
    },
    get staleSignature() {
      return staleSignature
    },
    get focusCalls() {
      return focusCalls
    },
    get focusedAnchors() {
      return focusedAnchors
    },
    get annotations() {
      return annotations
    },
    get current() {
      return current
    },
  }
}

function readFunctionDeclarationNames(setup: Record<string, unknown>): string[] {
  const tools = Array.isArray(setup.tools) ? setup.tools : []
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return []
    const record = tool as Record<string, unknown>
    const declarations = [
      ...(Array.isArray(record.functionDeclarations) ? record.functionDeclarations : []),
      ...(Array.isArray(record.function_declarations) ? record.function_declarations : []),
    ]
    return declarations.flatMap((declaration) => {
      if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return []
      const name = (declaration as Record<string, unknown>).name
      return typeof name === "string" ? [name] : []
    })
  })
}

describe("Coreview action bus", () => {
  it("declares annotation tools with explicit visual annotation routing guidance", () => {
    const declarations = coreviewGeminiFunctionDeclarations()
    const annotationDeclaration = declarations.find((declaration) => (
      declaration.name === COREVIEW_ADD_ANNOTATION_TOOL_NAME
    ))

    expect(JSON.stringify(declarations)).toContain("Do not use coreview_refresh_view as a substitute")
    expect(JSON.stringify(declarations)).toContain("Do not say an annotation was added unless this tool returned ok=true")
    expect(JSON.stringify(annotationDeclaration)).toContain("Highlight it yellow")
    expect(JSON.stringify(annotationDeclaration)).toContain("Leave a comment: change the font")
    expect(JSON.stringify(annotationDeclaration)).toContain("Underline the title")
    expect(JSON.stringify(annotationDeclaration)).toContain("Add an arrow pointing to this")
    expect(JSON.stringify(annotationDeclaration)).toMatch(/highlight|comment|underline|arrow|mark|note/u)
  })

  it("injects review tool declarations without re-exposing artifact creation", () => {
    const setup = withCoreviewGeminiToolDeclarations({
      tools: [{ functionDeclarations: [{ name: "emit_artifact" }] }],
    }, true, { allowArtifactCreation: false })
    const declarationNames = readFunctionDeclarationNames(setup)

    expect(JSON.stringify(setup)).toContain(COREVIEW_ADD_ANNOTATION_TOOL_NAME)
    expect(declarationNames).toContain("coreview_request_artifact_update")
    expect(declarationNames).toContain("coreview_cancel_builder_task")
    expect(declarationNames).toContain("coreview_get_builder_status")
    expect(declarationNames).not.toContain("emit_artifact")
  })

  it("filters generic builder tools when Coreview builder actions are exposed for review", () => {
    const setup = withCoreviewGeminiToolDeclarations({
      tools: [{ functionDeclarations: [
        { name: "emit_artifact" },
        { name: "start_builder_task" },
        { name: "edit_builder_artifact" },
        { name: "check_async_task" },
        { name: "update_async_task" },
      ] }],
    }, true, { allowArtifactCreation: false })

    const declarationNames = readFunctionDeclarationNames(setup)
    expect(declarationNames).toContain("coreview_request_artifact_update")
    expect(declarationNames).not.toContain("emit_artifact")
    expect(declarationNames).not.toContain("start_builder_task")
    expect(declarationNames).not.toContain("edit_builder_artifact")
    expect(declarationNames).not.toContain("check_async_task")
    expect(declarationNames).not.toContain("update_async_task")
  })

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

  it("rebinds the visible artifact before returning current view metadata", () => {
    const harness = createHarness({
      artifactId: null,
      artifactPath: null,
      artifactTitle: null,
      artifactStableIdentity: null,
      rebindCurrent: {
        artifactId: "artifact-1",
        artifactPath: "outputs/report.pdf",
        artifactTitle: "report.pdf",
        artifactStableIdentity: "user:unknown|thread:thread-1|path:outputs/report.pdf|renderer:pdf",
      },
    })

    const result = harness.bus.getCurrentView(undefined, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "get_current_view",
      artifact_id: "artifact-1",
      artifact_path: "outputs/report.pdf",
      artifact_stable_identity: "user:unknown|thread:thread-1|path:outputs/report.pdf|renderer:pdf",
      rebind_attempted: true,
      rebind_result: "success",
      rebind_status: "success",
      rebind_reason: "no_selected_artifact",
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
  })

  it("rebinds the visible artifact before setting the view", async () => {
    const harness = createHarness({
      artifactId: null,
      artifactPath: null,
      artifactTitle: null,
      rebindCurrent: {
        artifactId: "artifact-1",
        artifactPath: "outputs/report.pdf",
        artifactTitle: "report.pdf",
      },
    })

    const result = await harness.bus.setView({ pageNumber: 2 }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "set_view",
      page_number: 2,
      rebind_attempted: true,
      rebind_result: "success",
      rebind_status: "success",
    })
    expect(harness.current.pageIndex).toBe(1)
  })

  it("returns a clear artifact-not-available status for a true rebind mismatch", () => {
    const harness = createHarness({
      rebindCurrent: {},
      rebindOk: false,
      rebindReason: "artifact_not_available_in_current_session",
    })

    const result = harness.bus.getCurrentView({ artifactId: "other-artifact" }, "gemini_tool")

    expect(result).toMatchObject({
      ok: false,
      blocked_reason: "artifact_not_available_in_current_session",
      rebind_attempted: true,
      rebind_result: "failed",
      rebind_status: "failed",
      rebind_reason: "artifact_not_available_in_current_session",
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
  })

  it("blocks page actions on renderers without pagination", async () => {
    const harness = createHarness({
      rendererKind: "markdown",
      supportsPagination: false,
      pageCount: 1,
    })

    const result = await harness.bus.setView({ pageNumber: 2 }, "gemini_tool")

    expect(result.ok).toBe(false)
    expect(result.blocked_reason).toBe("pages_not_supported")
    expect(harness.refreshes).toBe(0)
  })

  it("keeps the page change successful and stale when refresh fails after a view change", async () => {
    const harness = createHarness({ refreshOk: false })

    const result = await harness.bus.setView({ pageNumber: 3 }, "gemini_tool")

    expect(result.ok).toBe(true)
    expect(result.page_number).toBe(3)
    expect(result.refresh_attempted).toBe(true)
    expect(result.refresh_result).toBe("failed")
    expect(result.blocked_reason).toBe("refresh_unavailable")
    expect(result.stale).toBe(true)
    expect(result.visual_frame_fresh).toBe(false)
    expect(result.visual_fresh).toBe(false)
    expect(result.result_summary).toContain("Visual refresh failed")
    expect(harness.staleSignature).toBe(result.view_signature_after)
  })

  it("returns unavailable visual refresh without failing a successful page change", async () => {
    const harness = createHarness({
      canRefresh: false,
      reviewActive: true,
      reviewHasFrame: false,
      visualFrameFresh: false,
    })

    const result = await harness.bus.setView({ pageNumber: 2 }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      page_number: 2,
      refresh_attempted: false,
      refresh_result: "unavailable",
      blocked_reason: "refresh_unavailable",
      visual_frame_fresh: false,
      visual_fresh: false,
    })
    expect(harness.refreshes).toBe(0)
  })

  it("returns current view metadata without raw artifact text or frames", () => {
    const harness = createHarness({ pageIndex: 1, fitMode: "width" })

    const result = harness.bus.getCurrentView(undefined, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "get_current_view",
      page_index: 1,
      page_number: 2,
      page_count: 3,
      fit_mode: "width",
      exact_text_available: true,
      visual_fresh: true,
      visual_frame_fresh: true,
      frame_sent: true,
      current_view_summary: "Current view is page 2 of 3.",
      coreview_workspace_contract_version: 1,
      capability_summary: {
        rendererKind: "pdf",
        renderMode: "canvas",
        supportsPages: true,
        supportsPageRail: true,
        currentPage: 2,
        pageCount: 3,
        supportsTextExtraction: true,
        supportsLayoutAnchors: true,
        supportsAnnotations: true,
        supportsZoom: true,
        supportsPan: true,
        supportsAnnotatedExport: false,
        supportsOCR: false,
        supportsPptxNativeRender: false,
        userFacingTruth: null,
      },
      annotation_overlay_captured: false,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(JSON.stringify(result)).not.toContain("base64")
  })

  it("returns HTML current view as a scroll document", () => {
    const harness = createHarness({
      artifactPath: "outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
      pageIndex: 0,
      pageCount: 1,
      fitMode: "custom",
      scrollTop: 320,
      scrollHeight: 1800,
      documentHeight: 1800,
      viewportHeight: 720,
      viewportWidth: 1180,
      scale: 1,
      htmlBridgeReady: true,
      htmlSectionIndexReady: true,
      htmlSectionIndexEntryCount: 5,
      htmlSectionIndexBuildResult: "success",
      visibleHeadings: ["Coreview", "Features"],
      currentSection: "Coreview",
      visibleTextSummary: "Visible section: Coreview",
      stillFrameAvailable: true,
    })

    const result = harness.bus.getCurrentView(undefined, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "get_current_view",
      renderer_kind: "html",
      page_index: 0,
      page_count: 1,
      scroll_top: 320,
      scroll_height: 1800,
      document_height: 1800,
      viewport_height: 720,
      viewport_width: 1180,
      html_bridge_ready: true,
      html_section_index_ready: true,
      html_section_index_entry_count: 5,
      html_section_index_build_result: "success",
      visible_headings: ["Coreview", "Features"],
      current_section: "Coreview",
      visible_text_summary: "Visible section: Coreview",
      still_frame_available: true,
      current_view_summary: "Current view is an HTML document. Current section is Coreview.",
      capability_summary: {
        rendererKind: "html",
        renderMode: "html",
        supportsPages: false,
        supportsPageRail: false,
        pageCount: 1,
        supportsAnnotations: true,
        supportsZoom: true,
      },
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
  })

  it("keeps failed HTML scroll routed through the HTML resolver without PDF fallback", async () => {
    const harness = createHarness({
      artifactPath: "outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
      pageIndex: 0,
      pageCount: 1,
      fitMode: "custom",
      scrollTop: 120,
      scrollHeight: 1800,
      documentHeight: 1800,
      viewportHeight: 720,
      reviewActive: false,
      reviewHasFrame: false,
      canRefresh: false,
      htmlSetViewFailure: "section_not_found",
    })

    const result = await harness.bus.setView({ htmlScrollPosition: "bottom" }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: false,
      action: "set_view",
      renderer_kind: "html",
      page_index: 0,
      page_count: 1,
      scroll_top: 120,
      blocked_reason: "section_not_found",
      html_scroll_attempted: true,
      html_scroll_result: "section_not_found",
      html_navigation_router_used: true,
      html_navigation_command_kind: "scroll_to",
      html_navigation_target_safe: "bottom",
      html_navigation_target_kind: "bottom",
      html_navigation_result: "section_not_found",
      html_navigation_failure_reason: "section_not_found",
      html_navigation_scroll_top_before: 120,
      html_navigation_scroll_top_after: 120,
      html_navigation_scrolled: false,
      html_navigation_prevented_pdf_fallback: true,
      html_voice_navigation_used_same_resolver: true,
      result_summary: "Sophia could not find that section in the HTML document.",
      refresh_attempted: false,
      refresh_result: "not_requested",
    })
    expect(harness.current.pageIndex).toBe(0)
    expect(harness.current.scrollTop).toBe(120)
    expect(harness.refreshes).toBe(0)
  })

  it("scrolls HTML with set_view without pretending there are pages", async () => {
    const harness = createHarness({
      artifactPath: "outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
      pageIndex: 0,
      pageCount: 1,
      fitMode: "custom",
      scrollTop: 0,
      scrollHeight: 1800,
      documentHeight: 1800,
      viewportHeight: 720,
      reviewActive: false,
      reviewHasFrame: false,
      canRefresh: false,
    })

    const result = await harness.bus.setView({ htmlScrollDelta: 500 }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: true,
      action: "set_view",
      renderer_kind: "html",
      page_index: 0,
      page_count: 1,
      scroll_top: 500,
      html_scroll_attempted: true,
      html_scroll_result: "success",
      result_summary: "Scrolled the HTML document.",
      refresh_attempted: false,
      refresh_result: "not_requested",
    })
  })

  it("lets HTML focus use the iframe resolver when exact text resolution misses", async () => {
    const harness = createHarness({
      artifactPath: "outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
      pageIndex: 0,
      pageCount: 1,
      fitMode: "custom",
      reviewActive: false,
      reviewHasFrame: false,
      canRefresh: false,
    })

    const result = await harness.bus.focusAnchor({
      anchor: { type: "text_quote", text: "Features" },
      pageIndex: 0,
    }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: true,
      action: "focus_anchor",
      renderer_kind: "html",
      focus_anchor_type: "text_quote",
      html_focus_anchor_attempted: true,
      html_focus_anchor_result: "success",
      result_summary: "Focused the HTML section. Visual review is not active.",
    })
    expect(harness.focusCalls).toBe(1)
    expect(harness.focusedAnchors[0]).toMatchObject({
      anchorType: "text_quote",
      text: "Features",
      rect: { x: 0, y: 0, width: 0.01, height: 0.01 },
    })
  })

  it("adds a yellow highlight on the current title and refreshes the same review state", async () => {
    const harness = createHarness()

    const result = await harness.bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      color: "yellow",
      source: "sophia",
    }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "add_annotation",
      annotation_kind: "highlight",
      annotation_anchor_type: "current_title",
      annotation_color: "yellow",
      annotation_page_index: 0,
      annotation_count: 1,
      highlight_count: 1,
      comment_count: 0,
      annotation_action_source: "sophia",
      annotation_overlay_captured: true,
      annotation_commit_attempted: true,
      annotation_commit_result: "success",
      annotation_commit_count_before: 0,
      annotation_commit_count_after: 1,
      annotation_commit_verified: true,
      annotation_created: true,
      preserved_mic: true,
      preserved_review: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(harness.annotations).toHaveLength(1)
    expect(harness.refreshes).toBe(1)
    expect(JSON.stringify(result)).not.toContain("change the font")
  })

  it("adds a comment on the current title without echoing raw comment text", async () => {
    const harness = createHarness()

    const result = await harness.bus.addAnnotation({
      kind: "comment",
      anchor: { type: "current_title" },
      text: "change the font",
      source: "sophia",
    }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "add_annotation",
      annotation_kind: "comment",
      annotation_anchor_type: "current_title",
      annotation_count: 1,
      highlight_count: 0,
      comment_count: 1,
      annotation_action_source: "sophia",
      preserved_mic: true,
      preserved_review: true,
    })
    expect(JSON.stringify(result)).not.toContain("change the font")
  })

  it("adds an underline on the current title through the same annotation bus", async () => {
    const harness = createHarness()

    const result = await harness.bus.addAnnotation({
      kind: "underline",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: true,
      action: "add_annotation",
      command_source: "frontend_fallback",
      annotation_kind: "underline",
      annotation_anchor_type: "current_title",
      annotation_color: "purple",
      annotation_count: 1,
      highlight_count: 0,
      comment_count: 0,
      underline_count: 1,
      arrow_count: 0,
      annotation_action_source: "sophia",
      annotation_commit_verified: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(harness.annotations).toEqual([{ kind: "underline" }])
    expect(harness.current.underlineCount).toBe(1)
  })

  it("adds an arrow through the same annotation bus", async () => {
    const harness = createHarness()

    const result = await harness.bus.addAnnotation({
      kind: "arrow",
      anchor: { type: "point", x: 0.58, y: 0.36 },
      source: "sophia",
    }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: true,
      action: "add_annotation",
      command_source: "frontend_fallback",
      annotation_kind: "arrow",
      annotation_anchor_type: "point",
      annotation_color: "purple",
      annotation_count: 1,
      underline_count: 0,
      arrow_count: 1,
      annotation_action_source: "sophia",
      annotation_commit_verified: true,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(harness.annotations).toEqual([{ kind: "arrow" }])
    expect(harness.current.arrowCount).toBe(1)
  })

  it("returns a safe failure for unsupported annotation kinds", async () => {
    const harness = createHarness()

    const result = await harness.bus.addAnnotation({
      kind: "draw",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")

    expect(result).toMatchObject({
      ok: false,
      action: "add_annotation",
      blocked_reason: "unsupported_annotation_kind",
      unsupported_annotation_kind: "draw",
      annotation_kind: null,
      annotation_count: 0,
      highlight_count: 0,
      comment_count: 0,
      underline_count: 0,
      arrow_count: 0,
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
    expect(harness.annotations).toHaveLength(0)
    expect(result.result_summary).toContain("not available")
  })

  it("keeps an annotation committed when view-ready times out", async () => {
    const harness = createHarness({ waitOk: false })

    const result = await harness.bus.addAnnotation({
      kind: "comment",
      anchor: { type: "current_title" },
      text: "change the font",
      source: "sophia",
    }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: true,
      action: "add_annotation",
      command_source: "frontend_fallback",
      blocked_reason: "view_ready_timeout",
      refresh_attempted: false,
      refresh_result: "view_ready_timeout",
      annotation_kind: "comment",
      annotation_count: 1,
      comment_count: 1,
      annotation_commit_attempted: true,
      annotation_commit_result: "partial_success",
      annotation_commit_count_before: 0,
      annotation_commit_count_after: 1,
      annotation_commit_verified: true,
      annotation_created: true,
      annotation_view_ready_timed_out: true,
      annotation_partial_success: true,
      preserved_review: true,
    })
    expect(harness.annotations).toHaveLength(1)
    expect(harness.current.annotationCount).toBe(1)
    expect(harness.current.commentCount).toBe(1)
    expect(harness.refreshes).toBe(0)
    expect(harness.current.stale).toBe(true)
    expect(result.result_summary).toContain("annotation remains visible")
    expect(JSON.stringify(result)).not.toContain("change the font")
  })

  it("does not report annotation success unless the committed count increases", async () => {
    const harness = createHarness({ annotationCommitNoop: true })

    const result = await harness.bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      color: "yellow",
      source: "sophia",
    }, "frontend_fallback")

    expect(result).toMatchObject({
      ok: false,
      action: "add_annotation",
      command_source: "frontend_fallback",
      blocked_reason: "annotation_commit_failed",
      refresh_attempted: false,
      refresh_result: "not_requested",
      annotation_count: 0,
      highlight_count: 0,
      annotation_commit_attempted: true,
      annotation_commit_result: "annotation_commit_failed",
      annotation_commit_count_before: 0,
      annotation_commit_count_after: 0,
      annotation_commit_verified: false,
      annotation_created: false,
    })
    expect(harness.annotations).toHaveLength(0)
    expect(harness.current.annotationCount).toBe(0)
    expect(harness.refreshes).toBe(0)
  })

  it("blocks invalid pages and missing text anchors safely for annotations", async () => {
    const harness = createHarness()

    await expect(harness.bus.addAnnotation({
      kind: "highlight",
      pageNumber: 9,
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "requested_page_out_of_bounds",
    })

    await expect(harness.bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "text_quote", text: "missing" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "anchor_not_found",
      raw_artifact_text_excluded: true,
      raw_frame_excluded: true,
    })
  })

  it("focuses the current title with bounded custom zoom", async () => {
    const harness = createHarness()

    const result = await harness.bus.focusAnchor({
      anchor: { type: "current_title" },
      zoomDelta: 1.5,
    }, "gemini_tool")

    expect(result).toMatchObject({
      ok: true,
      action: "focus_anchor",
      page_index: 0,
      zoom: 1.5,
      fit_mode: "custom",
      focus_anchor_type: "current_title",
      focused_rect: {
        x: 0.12,
        y: 0.08,
        width: 0.62,
        height: 0.07,
      },
      preserved_mic: true,
      preserved_review: true,
      raw_frame_excluded: true,
    })
    expect(harness.focusCalls).toBe(1)
    expect(harness.refreshes).toBe(1)
  })

  it("blocks annotation tools when no artifact is selected or annotations are unsupported", async () => {
    await expect(createHarness({ artifactId: null }).bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "no_selected_artifact",
    })

    await expect(createHarness({ rendererKind: "markdown" }).bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "annotations_not_supported",
    })

    await expect(createHarness({ rendererKind: "unsupported" }).bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "unsupported_renderer",
    })

    await expect(createHarness({
      rendererKind: "download_only",
      artifactPath: "outputs/deck.pptx",
      artifactTitle: "deck.pptx",
    }).bus.addAnnotation({
      kind: "highlight",
      anchor: { type: "current_title" },
      source: "sophia",
    }, "gemini_tool")).resolves.toMatchObject({
      ok: false,
      blocked_reason: "annotations_not_supported",
      capability_summary: {
        renderMode: "metadata",
        supportsAnnotations: false,
        supportsPptxNativeRender: false,
        fallbackReason: "pptx_native_renderer_unavailable",
      },
    })
  })

  it("blocks focus anchors when layout anchors are unsupported", async () => {
    const result = await createHarness({ rendererKind: "markdown" }).bus.focusAnchor({
      anchor: { type: "current_title" },
    }, "gemini_tool")

    expect(result).toMatchObject({
      ok: false,
      blocked_reason: "layout_anchor_not_supported",
    })
  })
})
