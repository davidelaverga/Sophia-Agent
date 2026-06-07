import { render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactCanvasViewport } from "../../../app/components/session/ArtifactCanvasViewport"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"
import type { ArtifactAnnotation } from "../../../app/types/artifact-annotations"
import type { BuilderArtifactV1 } from "../../../app/types/builder-artifact"

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
}))

const builderArtifact = {
  artifactTitle: "Launch brief overview",
  artifactType: "document",
  artifactPath: "mnt/user-data/outputs/launch-brief.docx",
  supportingFiles: [],
  decisionsMade: ["Kept the review focused."],
  companionSummary: "Overview card for the completed launch brief.",
  userNextAction: "Open the document for the full deliverable.",
} satisfies BuilderArtifactV1

const pdfArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
} satisfies BuilderArtifactV1

const markdownArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.md",
} satisfies BuilderArtifactV1
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

function mockCanvasApis() {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
  } as unknown as CanvasRenderingContext2D

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
}

function mockPdfDocument({ pageCount = 2 }: { pageCount?: number } = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(pdfBytes.slice(), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }),
  )
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
    scale,
  }))
  const render = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }))
  const getPage = vi.fn(async () => ({
    getViewport,
    render,
  }))
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({
      numPages: pageCount,
      fingerprints: [`viewport-pdf-${pageCount}`],
      getPage,
    }),
    destroy: vi.fn(),
  }))

  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument,
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

  return { getDocument, getPage, getViewport, render }
}

const htmlArtifact = {
  ...builderArtifact,
  artifactType: "webpage",
  artifactPath: "mnt/user-data/outputs/launch-brief.html",
} satisfies BuilderArtifactV1

function extractBridgeScript(srcDoc: string): string {
  const match = /<script>([\s\S]*)<\/script>/u.exec(srcDoc)
  if (!match?.[1]) {
    throw new Error("Expected injected HTML preview bridge script")
  }
  return match[1]
}

function runPreviewBridgeFromSrcDoc(srcDoc: string) {
  const previewDocument = document.implementation.createHTMLDocument("preview")
  previewDocument.open()
  previewDocument.write(srcDoc)
  previewDocument.close()

  const posted: Record<string, unknown>[] = []
  const messageListeners: Array<(event: { data: unknown }) => void> = []
  const previousScrollIntoView = Element.prototype.scrollIntoView
  const scrollIntoView = vi.fn(function scrollIntoViewMock(this: Element) {
    this.setAttribute("data-test-scrolled", "true")
  })
  Element.prototype.scrollIntoView = scrollIntoView

  Object.defineProperty(previewDocument, "scrollingElement", {
    configurable: true,
    value: previewDocument.documentElement,
  })
  Object.defineProperty(previewDocument.documentElement, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  })
  Object.assign(previewDocument.documentElement, {
    scrollTo: vi.fn((options?: ScrollToOptions) => {
      previewDocument.documentElement.scrollTop = Math.max(0, Number(options?.top ?? 0))
    }),
  })

  const open = vi.fn(() => ({ closed: false }))
  const fakeWindow = {
    parent: {
      postMessage: vi.fn((payload: Record<string, unknown>) => {
        posted.push(payload)
      }),
    },
    innerHeight: 520,
    innerWidth: 900,
    scrollY: 0,
    setTimeout: (handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler()
      }
      return 1
    },
    clearTimeout: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") {
        messageListeners.push(listener)
      }
    }),
    open,
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- exercises the exact injected iframe bridge from srcdoc.
  const runScript = new Function("window", "document", extractBridgeScript(srcDoc))
  runScript(fakeWindow, previewDocument)
  const initialPosted = [...posted]
  posted.length = 0

  return {
    document: previewDocument,
    posted,
    initialPosted,
    open,
    scrollIntoView,
    sendParentMessage(data: unknown) {
      messageListeners.forEach((listener) => listener({ data }))
    },
    cleanup() {
      Element.prototype.scrollIntoView = previousScrollIntoView
    },
  }
}

function clickPreviewElement(element: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(loadPdfJs).mockReset()
})

describe("ArtifactCanvasViewport", () => {
  it("renders a complete canvas bed around the document page", () => {
    render(
      <ArtifactCanvasViewport
        artifact={builderArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.docx",
          name: "launch-brief.docx",
          label: "launch-brief.docx",
          isPrimary: true,
        }]}
        typeLabel="Document"
        reviewSurfaceState="active"
      />,
    )

    const viewport = screen.getByTestId("artifact-canvas-viewport")
    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const documentPage = screen.getByTestId("artifact-document-page")

    expect(viewport).toContainElement(canvasBed)
    expect(canvasBed).toContainElement(scrollArea)
    expect(scrollArea).toContainElement(documentPage)
    expect(canvasBed.className).toContain("sophia-purple")
    expect(scrollArea.className).toContain("[scrollbar-gutter:stable]")
    expect(scrollArea.style.scrollbarColor).toBe("var(--cosmic-border) transparent")
    expect(documentPage.className).toContain("min-h-full")
    expect(documentPage.className).toContain("max-w-[960px]")
  })

  it("keeps PDF loading state inside the canvas bed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pdfBytes.slice(), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    )
    vi.mocked(loadPdfJs).mockResolvedValue({
      getDocument: vi.fn(() => ({
        promise: new Promise(() => undefined),
        destroy: vi.fn(),
      })),
    } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

    render(
      <ArtifactCanvasViewport
        artifact={pdfArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.pdf",
          name: "launch-brief.pdf",
          label: "launch-brief.pdf",
          isPrimary: true,
          mimeType: "application/pdf",
        }]}
        typeLabel="Document"
        previewHref="/artifact.pdf"
      />,
    )

    const canvasBed = await screen.findByTestId("artifact-canvas-bed")
    const previewRegion = await screen.findByLabelText("Artifact PDF preview")

    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    expect(within(previewRegion).getByText("Preparing PDF view")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-preview-state").className).not.toMatch(/\bfixed\b|\binset-0\b/)
  })

  it("keeps the PDF rail fixed while the PDF pan layer owns zoom overflow", async () => {
    mockCanvasApis()
    const pdf = mockPdfDocument({ pageCount: 2 })

    render(
      <ArtifactCanvasViewport
        artifact={pdfArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.pdf",
          name: "launch-brief.pdf",
          label: "launch-brief.pdf",
          isPrimary: true,
          mimeType: "application/pdf",
        }]}
        typeLabel="Document"
        previewHref="/artifact.pdf"
        pageIndex={0}
        pageCount={2}
        zoom={1.6}
        fitMode="custom"
      />,
    )

    const canvas = await screen.findByLabelText("PDF page 1")
    await waitFor(() => expect(canvas).toHaveAttribute("data-artifact-pdf-scale", "1.6"))

    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const documentPage = screen.getByTestId("artifact-document-page")
    const panLayer = screen.getByTestId("artifact-pdf-pan-layer")
    const rail = screen.getByTestId("artifact-page-rail")

    expect(canvasBed.className).toContain("overflow-hidden")
    expect(scrollArea.className).toContain("overflow-hidden")
    expect(scrollArea.className).toContain("min-w-0")
    expect(documentPage.className).toContain("overflow-hidden")
    expect(panLayer.className).toContain("overflow-auto")
    expect(documentPage).toContainElement(rail)
    expect(panLayer).not.toContainElement(rail)
    expect(within(rail).getAllByTestId("artifact-pdf-thumbnail-canvas")).toHaveLength(2)
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2))
  })

  it("keeps markdown loading state inside the canvas bed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    )

    render(
      <ArtifactCanvasViewport
        artifact={markdownArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.md",
          name: "launch-brief.md",
          label: "launch-brief.md",
          isPrimary: true,
          mimeType: "text/markdown",
        }]}
        typeLabel="Document"
        previewHref="/artifact.md"
      />,
    )

    const canvasBed = await screen.findByTestId("artifact-canvas-bed")
    const previewRegion = await screen.findByLabelText("Artifact document preview")

    expect(canvasBed).toContainElement(screen.getByTestId("artifact-preview-state"))
    expect(within(previewRegion).getByText("Preparing document view")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-preview-state").className).not.toMatch(/\bfixed\b|\binset-0\b/)
  })

  it("renders HTML artifacts in a sandboxed iframe preview", async () => {
    mockCanvasApis()
    const onVisualCaptureStatusChange = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><head><title>Deck fallback</title></head><body><h1>Deck fallback</h1><p>Readable slide content.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      />,
    )

    const previewRegion = await screen.findByLabelText("Artifact HTML preview")
    const iframe = await screen.findByTitle("Preview of launch-brief.html")

    expect(previewRegion).toContainElement(iframe)
    expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts",
    )
    expect(iframe).toHaveAttribute("data-html-visible-renderer-interactive", "true")
    expect(iframe).toHaveAttribute("data-html-iframe-pointer-events", "auto")
    expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Deck fallback</h1>"))
    const captureCanvas = await screen.findByLabelText("Generated HTML artifact review canvas")
    expect(captureCanvas).toHaveAttribute("data-artifact-id", "artifact-1")
    expect(captureCanvas).toHaveAttribute("data-coreview-artifact-id", "artifact-1")
    expect(captureCanvas).toHaveAttribute("data-artifact-canvas-source", "selected-html-preview")
    expect(captureCanvas).toHaveAttribute("data-coreview-renderer-kind", "html")
    await waitFor(() => {
      expect(onVisualCaptureStatusChange).toHaveBeenLastCalledWith({
        ready: true,
        reason: null,
        source: "html_preview_canvas",
        exactTextAvailable: true,
        annotationOverlayCaptured: false,
        artifactPath: "mnt/user-data/outputs/launch-brief.html",
        previewHref: "/artifact.html",
      })
    })
  })

  it("sizes the visible HTML preview responsively instead of using capture dimensions", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><main><h1>Full pane page</h1><p>Readable content.</p></main></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        zoom={1.4}
        fitMode="custom"
      />,
    )

    const canvasBed = screen.getByTestId("artifact-canvas-bed")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const previewRegion = await screen.findByLabelText("Artifact HTML preview")
    const zoomFrame = await screen.findByTestId("artifact-html-zoom-frame")
    const iframe = await screen.findByTestId("artifact-html-preview-iframe")

    expect(canvasBed).toContainElement(previewRegion)
    expect(scrollArea.className).toContain("overflow-hidden")
    expect(scrollArea.className).not.toContain("overflow-y-auto")
    expect(previewRegion.className).toContain("flex-1")
    expect(previewRegion.className).not.toContain("max-w-[1120px]")
    expect(previewRegion.className).not.toContain("mx-auto")
    expect(previewRegion).toHaveAttribute("data-html-visible-preview-responsive", "true")
    expect(previewRegion).toHaveAttribute("data-html-visible-preview-uses-capture-dimensions", "false")
    expect(previewRegion).toHaveAttribute("data-html-visible-preview-scroll-mode", "iframe")
    expect(zoomFrame).toHaveAttribute("data-artifact-zoom", "1.4")
    expect(zoomFrame.style.transform).toBe("scale(1.4)")
    expect(zoomFrame.style.width).toBe("71.42857142857143%")
    expect(zoomFrame.style.height).toBe("71.42857142857143%")
    expect(zoomFrame.className).toContain("flex-1")
    expect(iframe.className).toContain("h-full")
    expect(iframe.className).toContain("min-h-0")
    expect(iframe.className).not.toContain("min-h-[560px]")
  })

  it("passes pointer events through the HTML overlay in select mode", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><main><h1>Clickable page</h1><a href='#features'>Features</a><button>Try it</button></main></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        toolMode="select"
      />,
    )

    const iframe = await screen.findByTestId("artifact-html-preview-iframe")
    const layer = await screen.findByTestId("artifact-html-annotation-layer")

    expect(iframe).toHaveAttribute("data-html-visible-renderer-interactive", "true")
    expect(layer).toHaveAttribute("data-html-overlay-pointer-events-mode", "passthrough")
    expect(layer).toHaveAttribute("data-html-annotation-overlay-capturing", "false")
    expect(layer.className).toContain("pointer-events-none")
  })

  it("routes internal HTML links inside the iframe and blocks unsafe navigations", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        [
          "<!doctype html><html><body><main>",
          "<nav><a id='hash-link' href='#features'>Explore Features</a>",
          "<a id='slash-hash-link' href='/#features'>Features hash</a>",
          "<a id='dot-slash-hash-link' href='./#features'>Features dot hash</a>",
          "<a id='path-link' href='/features'>Features path</a>",
          "<a id='relative-link' href='features'>Features relative</a>",
          "<a id='missing-link' href='/missing'>Missing</a>",
          "<a id='external-link' href='https://example.com/docs?secret=hidden'>External docs</a></nav>",
          "<button id='data-scroll-button' data-scroll='coreview'>Coreview</button>",
          "<section id='features'><h2>Features</h2><p>Feature details live here.</p></section>",
          "<section><h2>Coreview</h2><p>Coreview details live here.</p></section>",
          "</main></body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        toolMode="select"
      />,
    )

    const iframe = await screen.findByTestId("artifact-html-preview-iframe")
    const bridge = runPreviewBridgeFromSrcDoc(iframe.getAttribute("srcdoc") ?? "")
    try {
      expect(bridge.initialPosted).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ready",
          htmlBridgeReady: true,
          htmlSectionIndexReady: true,
          htmlSectionIndexEntryCount: expect.any(Number),
          htmlSectionIndexBuildResult: "success",
        }),
      ]))
      for (const id of ["hash-link", "slash-hash-link", "dot-slash-hash-link", "path-link", "relative-link"]) {
        bridge.posted.length = 0
        const event = clickPreviewElement(bridge.document.getElementById(id) as Element)
        const result = bridge.posted.filter((payload) => payload.type === "navigation-result").at(-1)

        expect(event.defaultPrevented).toBe(true)
        expect(result).toMatchObject({
          htmlInternalNavigationResult: "success",
          htmlInternalNavigationTargetKind: "id",
          htmlInternalNavigationPreventedDefault: true,
          htmlInternalNavigationBlockedExternal: false,
          htmlInternalNavigationScrolled: true,
          htmlNavigationPreservedCaptureTarget: true,
          htmlNavigationRouterUsed: true,
          htmlInternalNavigationUsedSameResolver: true,
        })
        expect(bridge.document.getElementById("features")?.getAttribute("data-test-scrolled")).toBe("true")
      }

      bridge.posted.length = 0
      const dataScrollEvent = clickPreviewElement(bridge.document.getElementById("data-scroll-button") as Element)
      const dataScrollResult = bridge.posted.filter((payload) => payload.type === "navigation-result").at(-1)
      expect(dataScrollEvent.defaultPrevented).toBe(true)
      expect(dataScrollResult).toMatchObject({
        htmlInternalNavigationResult: "success",
        htmlInternalNavigationTargetKind: "heading",
        htmlInternalNavigationPreventedDefault: true,
        htmlInternalNavigationScrolled: true,
        htmlNavigationRouterUsed: true,
        htmlInternalNavigationUsedSameResolver: true,
      })

      bridge.posted.length = 0
      const missingEvent = clickPreviewElement(bridge.document.getElementById("missing-link") as Element)
      const missingResult = bridge.posted.filter((payload) => payload.type === "navigation-result").at(-1)
      expect(missingEvent.defaultPrevented).toBe(true)
      expect(missingResult).toMatchObject({
        htmlInternalNavigationResult: "section_not_found",
        htmlInternalNavigationFailureReason: "section_not_found",
        htmlInternalNavigationPreventedDefault: true,
        htmlInternalNavigationScrolled: false,
        htmlNavigationRouterUsed: true,
        htmlInternalNavigationUsedSameResolver: true,
      })

      bridge.posted.length = 0
      const externalEvent = clickPreviewElement(bridge.document.getElementById("external-link") as Element)
      const externalResult = bridge.posted.filter((payload) => payload.type === "navigation-result").at(-1)
      expect(externalEvent.defaultPrevented).toBe(true)
      expect(bridge.open).toHaveBeenCalledWith("https://example.com/docs?secret=hidden", "_blank", "noopener,noreferrer")
      expect(externalResult).toMatchObject({
        target: "external",
        htmlInternalNavigationResult: "opened_external",
        htmlInternalNavigationTargetKind: "external",
        htmlInternalNavigationBlockedExternal: true,
        htmlInternalNavigationScrolled: false,
      })
      expect(JSON.stringify(externalResult)).not.toContain("secret=hidden")
    } finally {
      bridge.cleanup()
    }
  })

  it("uses the same iframe resolver for HTML voice focus commands", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><main><h1>Landing</h1><section><h2>Coreview</h2><p>Review details.</p></section></main></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
      />,
    )

    const iframe = await screen.findByTestId("artifact-html-preview-iframe")
    const bridge = runPreviewBridgeFromSrcDoc(iframe.getAttribute("srcdoc") ?? "")
    try {
      expect(bridge.initialPosted).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ready",
          htmlBridgeReady: true,
          htmlSectionIndexReady: true,
          htmlSectionIndexBuildResult: "success",
        }),
      ]))
      bridge.sendParentMessage({
        source: "coreview-html-preview-parent",
        type: "command",
        command: "focus_text",
        commandId: "voice-focus-1",
        text: "Coreview",
      })
      const commandResult = bridge.posted.find((payload) => payload.type === "command-result")

      expect(commandResult).toMatchObject({
        commandId: "voice-focus-1",
        ok: true,
        method: "heading",
        scrolled: true,
        htmlInternalNavigationTargetKind: "heading",
        htmlNavigationRouterUsed: true,
        htmlNavigationCommandKind: "focus_text",
        htmlNavigationResult: "success",
        htmlVoiceNavigationUsedSameResolver: true,
      })

      bridge.posted.length = 0
      bridge.sendParentMessage({
        source: "coreview-html-preview-parent",
        type: "command",
        command: "scroll_by",
        commandId: "voice-scroll-1",
        deltaY: 240,
      })
      bridge.sendParentMessage({
        source: "coreview-html-preview-parent",
        type: "command",
        command: "scroll_by",
        commandId: "voice-scroll-1",
        deltaY: 240,
      })
      const scrollResults = bridge.posted.filter((payload) => payload.type === "command-result")
      expect(scrollResults).toHaveLength(1)
      expect(scrollResults[0]).toMatchObject({
        commandId: "voice-scroll-1",
        ok: true,
        htmlNavigationRouterUsed: true,
        htmlNavigationCommandKind: "scroll_by",
        htmlNavigationResult: "success",
        htmlVoiceNavigationUsedSameResolver: true,
      })

      bridge.posted.length = 0
      bridge.sendParentMessage({
        source: "coreview-html-preview-parent",
        type: "command",
        command: "focus_text",
        commandId: "voice-focus-missing",
        text: "Missing",
      })
      const missingResult = bridge.posted.find((payload) => payload.type === "command-result")
      expect(missingResult).toMatchObject({
        commandId: "voice-focus-missing",
        ok: false,
        blockedReason: "section_not_found",
        htmlNavigationRouterUsed: true,
        htmlNavigationCommandKind: "focus_text",
        htmlNavigationResult: "section_not_found",
        htmlNavigationFailureReason: "section_not_found",
        htmlVoiceNavigationUsedSameResolver: true,
      })
    } finally {
      bridge.cleanup()
    }
  })

  it("captures pointer events for HTML highlight mode", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<!doctype html><html><body><h1>Annotate me</h1></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        toolMode="highlight"
      />,
    )

    const layer = await screen.findByTestId("artifact-html-annotation-layer")

    expect(layer).toHaveAttribute("data-html-overlay-pointer-events-mode", "capture")
    expect(layer).toHaveAttribute("data-html-annotation-overlay-capturing", "true")
    expect(layer.className).toContain("pointer-events-auto")
  })

  it("keeps the HTML capture target offscreen and out of visible layout", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><h1>Capture target</h1><p>Still-frame source is ready.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
      />,
    )

    await screen.findByTitle("Preview of launch-brief.html")
    const captureRegion = await screen.findByTestId("artifact-html-capture-canvas")
    const captureCanvas = await screen.findByLabelText("Generated HTML artifact review canvas")
    const previewRegion = screen.getByLabelText("Artifact HTML preview")

    expect(previewRegion).not.toContainElement(captureCanvas)
    expect(captureRegion).toHaveAttribute("aria-hidden", "true")
    expect(captureRegion).toHaveAttribute("data-html-offscreen-capture-affects-layout", "false")
    expect(captureRegion.className).toContain("absolute")
    expect(captureRegion.className).toContain("h-px")
    expect(captureRegion.className).toContain("w-px")
    expect(captureRegion.style.left).toBe("-10000px")
    expect(captureRegion.style.top).toBe("0px")
    expect(captureCanvas).toHaveAttribute("width", "960")
    expect(captureCanvas).toHaveAttribute("height", "720")
    expect(captureCanvas).toHaveAttribute("data-artifact-canvas-source", "selected-html-preview")
    expect(captureCanvas).toHaveAttribute("data-coreview-offscreen-render", "true")
  })

  it("applies HTML fit and reset as a clean responsive scale", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<!doctype html><html><body><h1>Fit me</h1><p>Responsive preview.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    const view = render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        zoom={1.5}
        fitMode="custom"
      />,
    )

    const zoomFrame = await screen.findByTestId("artifact-html-zoom-frame")
    expect(zoomFrame).toHaveAttribute("data-artifact-zoom", "1.5")
    expect(zoomFrame.style.transform).toBe("scale(1.5)")

    view.rerender(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        zoom={1.5}
        fitMode="width"
      />,
    )

    await waitFor(() => expect(zoomFrame).toHaveAttribute("data-artifact-zoom", "1"))
    expect(zoomFrame).toHaveAttribute("data-html-fit-mode-applied", "width")
    expect(zoomFrame.style.transform).toBe("scale(1)")
    expect(zoomFrame.style.width).toBe("100%")
    expect(zoomFrame.style.height).toBe("100%")

    view.rerender(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        zoom={1}
        fitMode="custom"
      />,
    )

    await waitFor(() => expect(zoomFrame).toHaveAttribute("data-html-fit-mode-applied", "custom"))
    expect(zoomFrame).toHaveAttribute("data-artifact-zoom", "1")
    expect(zoomFrame.style.transform).toBe("scale(1)")
  })

  it("uses the iframe as the intentional HTML scroll container without outer blank space", async () => {
    mockCanvasApis()
    const longHtml = [
      "<!doctype html><html><body><main><h1>Long page</h1>",
      ...Array.from({ length: 40 }, (_, index) => `<p>Section ${index + 1}: more page content.</p>`),
      "</main></body></html>",
    ].join("")
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(longHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
      />,
    )

    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")
    const previewRegion = await screen.findByLabelText("Artifact HTML preview")
    const zoomFrame = await screen.findByTestId("artifact-html-zoom-frame")
    const annotationHost = await screen.findByTestId("artifact-html-annotation-host")
    const iframe = await screen.findByTestId("artifact-html-preview-iframe")

    expect(scrollArea.className).toContain("overflow-hidden")
    expect(previewRegion.className).toContain("overflow-hidden")
    expect(zoomFrame.className).toContain("overflow-hidden")
    expect(annotationHost.className).toContain("overflow-hidden")
    expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("Section 40"))
    expect(iframe.className).toContain("h-full")
    expect(iframe.className).toContain("flex-1")
    expect(previewRegion).toHaveAttribute("data-html-visible-preview-scroll-mode", "iframe")
  })

  it("registers HTML revision artifacts with version-aware capture identity", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><head><title>Revision</title></head><body><h1>Revision</h1><p>Updated content.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    render(
      <ArtifactCanvasViewport
        artifact={{
          ...htmlArtifact,
          artifactPath: "mnt/user-data/outputs/update-the-html-landing-page-with-one-ch-revision-534f86ab.html",
        }}
        files={[{
          path: "mnt/user-data/outputs/update-the-html-landing-page-with-one-ch-revision-534f86ab.html",
          name: "update-the-html-landing-page-with-one-ch-revision-534f86ab.html",
          label: "Revision",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/revision.html"
        artifactTextRegistration={{
          artifactId: "artifact-revision",
          threadId: "thread-1",
          artifactStableIdentity: "logical-html-artifact",
          artifactLogicalId: "logical-html-artifact",
          artifactVersionId: "logical-html-artifact::v2",
        }}
      />,
    )

    const captureCanvas = await screen.findByLabelText("Generated HTML artifact review canvas")
    expect(captureCanvas).toHaveAttribute("data-artifact-id", "artifact-revision")
    expect(captureCanvas).toHaveAttribute(
      "data-coreview-artifact-path",
      "mnt/user-data/outputs/update-the-html-landing-page-with-one-ch-revision-534f86ab.html",
    )
    expect(captureCanvas).toHaveAttribute("data-coreview-artifact-stable-identity", "logical-html-artifact")
    expect(captureCanvas).toHaveAttribute("data-coreview-artifact-logical-id", "logical-html-artifact")
    expect(captureCanvas).toHaveAttribute("data-coreview-artifact-version-id", "logical-html-artifact::v2")
  })

  it("re-registers the HTML capture target when the selected path changes", async () => {
    mockCanvasApis()
    const onVisualCaptureStatusChange = vi.fn()
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          "<!doctype html><html><body><h1>Original</h1><p>Original content.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          "<!doctype html><html><body><h1>Revision</h1><p>Revised content.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )

    const { rerender } = render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-original",
          threadId: "thread-1",
          artifactStableIdentity: "logical-html-artifact",
          artifactLogicalId: "logical-html-artifact",
          artifactVersionId: "logical-html-artifact::v1",
        }}
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      />,
    )

    await screen.findByLabelText("Generated HTML artifact review canvas")
    rerender(
      <ArtifactCanvasViewport
        artifact={{
          ...htmlArtifact,
          artifactPath: "mnt/user-data/outputs/launch-brief-revision-534f86ab.html",
        }}
        files={[{
          path: "mnt/user-data/outputs/launch-brief-revision-534f86ab.html",
          name: "launch-brief-revision-534f86ab.html",
          label: "Revision",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/revision.html"
        artifactTextRegistration={{
          artifactId: "artifact-revision",
          threadId: "thread-1",
          artifactStableIdentity: "logical-html-artifact",
          artifactLogicalId: "logical-html-artifact",
          artifactVersionId: "logical-html-artifact::v2",
        }}
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      />,
    )

    await waitFor(() => {
      const captureCanvas = screen.getByLabelText("Generated HTML artifact review canvas")
      expect(captureCanvas).toHaveAttribute("data-artifact-id", "artifact-revision")
      expect(captureCanvas).toHaveAttribute("data-coreview-artifact-version-id", "logical-html-artifact::v2")
      expect(onVisualCaptureStatusChange).toHaveBeenLastCalledWith({
        ready: true,
        reason: null,
        source: "html_preview_canvas",
        exactTextAvailable: true,
        annotationOverlayCaptured: false,
        artifactPath: "mnt/user-data/outputs/launch-brief-revision-534f86ab.html",
        previewHref: "/revision.html",
      })
    })
  })

  it("renders HTML zoom and page-zero annotations on the capture layer", async () => {
    mockCanvasApis()
    const onVisualCaptureStatusChange = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><h1>Deck fallback</h1><p>Readable slide content.</p></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    )
    const annotations: ArtifactAnnotation[] = [
      {
        id: "highlight-1",
        kind: "highlight",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
        color: "yellow",
        source: "sophia",
        createdAt: 1,
      },
      {
        id: "underline-1",
        kind: "underline",
        pageIndex: 0,
        rect: { x: 0.15, y: 0.35, width: 0.36, height: 0.03 },
        color: "blue",
        source: "user",
        createdAt: 2,
      },
      {
        id: "comment-1",
        kind: "comment",
        pageIndex: 0,
        point: { x: 0.72, y: 0.42 },
        text: "Private comment text",
        color: "purple",
        source: "sophia",
        createdAt: 3,
      },
    ]

    render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
        zoom={1.25}
        fitMode="custom"
        annotations={annotations}
        selectedAnnotationId="comment-1"
        toolMode="select"
        onVisualCaptureStatusChange={onVisualCaptureStatusChange}
      />,
    )

    const zoomFrame = await screen.findByTestId("artifact-html-zoom-frame")
    expect(zoomFrame).toHaveAttribute("data-artifact-zoom", "1.25")
    expect(zoomFrame).toHaveAttribute("data-artifact-fit-mode", "custom")
    expect(screen.queryByTestId("artifact-page-rail")).not.toBeInTheDocument()
    expect(await screen.findByTestId("artifact-html-annotation-layer")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-html-highlight-annotation")).toHaveAttribute("data-page-index", "0")
    expect(screen.getByTestId("artifact-html-underline-annotation")).toHaveAttribute("data-page-index", "0")
    expect(screen.getByTestId("artifact-html-comment-annotation")).toHaveAttribute("data-page-index", "0")
    expect(screen.getByDisplayValue("Private comment text")).toBeInTheDocument()

    await waitFor(() => {
      expect(onVisualCaptureStatusChange).toHaveBeenLastCalledWith({
        ready: true,
        reason: null,
        source: "html_preview_canvas",
        exactTextAvailable: true,
        annotationOverlayCaptured: true,
        artifactPath: "mnt/user-data/outputs/launch-brief.html",
        previewHref: "/artifact.html",
      })
    })
  })

  it("removes the HTML capture target when the canvas unmounts", async () => {
    mockCanvasApis()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        "<!doctype html><html><body><h1>Deck fallback</h1><p>Readable slide content.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        },
      ),
    )

    const { unmount } = render(
      <ArtifactCanvasViewport
        artifact={htmlArtifact}
        files={[{
          path: "mnt/user-data/outputs/launch-brief.html",
          name: "launch-brief.html",
          label: "launch-brief.html",
          isPrimary: true,
          mimeType: "text/html",
        }]}
        typeLabel="Webpage"
        previewHref="/artifact.html"
        artifactTextRegistration={{
          artifactId: "artifact-1",
          threadId: "thread-1",
        }}
      />,
    )

    await screen.findByLabelText("Generated HTML artifact review canvas")
    unmount()

    expect(document.querySelector("canvas[data-artifact-canvas-source='selected-html-preview']")).toBeNull()
  })
})
