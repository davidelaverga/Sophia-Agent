import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactStage } from "../../../app/components/session/ArtifactStage"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../../app/lib/co-review-transport"
import {
  clearCoreviewArtifactTextRegistryForTests,
  readCoreviewArtifactTextSideband,
} from "../../../app/lib/coreview-artifact-text"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

const unsupportedTransportStatus = new AudioWebSocketUnsupportedTransport().status()
const supportedTransportStatus = {
  ...unsupportedTransportStatus,
  visualTransportSupported: true,
  toolsSupportedInCoReview: true,
  stillFramesSupported: true,
  statusText: "ready",
}

const builderArtifact = {
  artifactTitle: "Launch brief overview",
  artifactType: "document",
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
  supportingFiles: ["mnt/user-data/outputs/launch-brief-notes.md"],
  decisionsMade: [
    "Kept the visual review focused on the deliverable.",
    "Left exact table values to trusted text.",
  ],
  companionSummary: "Overview card for the completed launch brief.",
  userNextAction: "Open the PDF for the full deliverable.",
}

const markdownBuilderArtifact = {
  ...builderArtifact,
  artifactPath: "mnt/user-data/outputs/launch-brief.md",
  supportingFiles: [],
  userNextAction: "Review the rendered brief.",
}

function renderStage({
  artifact = builderArtifact,
  artifactLibrary = [],
  artifactId,
  sessionId,
  normalSessionId,
  state = {},
  exactTextAvailable = true,
  canStartReview = true,
  reviewEnabled = true,
  transportStatus = supportedTransportStatus,
  fillAvailable = false,
}: {
  artifact?: typeof builderArtifact
  artifactLibrary?: Array<{
    path: string
    name: string
    sizeBytes?: number
    mimeType?: string
    modifiedAt?: string
  }>
  artifactId?: string | null
  sessionId?: string | null
  normalSessionId?: string | null
  state?: Partial<CoReviewSessionState>
  exactTextAvailable?: boolean
  canStartReview?: boolean
  reviewEnabled?: boolean
  transportStatus?: typeof supportedTransportStatus
  fillAvailable?: boolean
} = {}) {
  const onStartReview = vi.fn()
  const onStopReview = vi.fn()

  const view = render(
    <ArtifactStage
      builderArtifact={artifact}
      builderArtifactLibrary={artifactLibrary}
      threadId="thread-1"
      artifactId={artifactId}
      sessionId={sessionId}
      normalSessionId={normalSessionId}
      reviewState={{
        ...initialCoReviewState(transportStatus.kind),
        ...state,
      }}
      transportStatus={transportStatus}
      exactTextAvailable={exactTextAvailable}
      canStartReview={canStartReview}
      reviewEnabled={reviewEnabled}
      onStartReview={onStartReview}
      onStopReview={onStopReview}
      fillAvailable={fillAvailable}
    />,
  )

  return { ...view, onStartReview, onStopReview }
}

afterEach(() => {
  vi.restoreAllMocks()
  clearCoreviewArtifactTextRegistryForTests()
})

describe("ArtifactStage", () => {
  it("renders a native artifact shell with open and download actions", () => {
    renderStage()

    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    expect(artifactRegion).toBeInTheDocument()
    expect(artifactRegion.className).toContain("w-full")
    expect(artifactRegion.className).toContain("min-h-0")
    expect(artifactRegion.className).not.toMatch(/\bfixed\b|\binset-0\b/)
    expect(screen.getAllByText("Launch brief overview")).toHaveLength(2)
    expect(screen.getByText("Document")).toBeInTheDocument()
    expect(screen.getByText("launch-brief.pdf")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf",
    )
    expect(screen.getByLabelText("Download Launch brief overview")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf?download=true",
    )
  })

  it("makes Review with Sophia prominent and calls the existing start handler", async () => {
    const user = userEvent.setup()
    const { onStartReview } = renderStage()

    await user.click(screen.getByRole("button", { name: /review with sophia/i }))

    expect(onStartReview).toHaveBeenCalledTimes(1)
  })

  it("shows Looking, Frame sent, stale state, and exact text availability from existing review state", () => {
    renderStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
        exactTextAvailable: true,
      },
    })

    expect(screen.getByRole("status", { name: /looking/i })).toBeInTheDocument()
    expect(screen.getByText("Frame sent")).toBeInTheDocument()
    expect(screen.getByText("View may be stale")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("shows Not Looking and exact text availability before review", () => {
    renderStage()

    expect(screen.getByRole("status", { name: /not looking/i })).toBeInTheDocument()
    expect(screen.getByText("Ready for review")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("can show unavailable exact text when the artifact has no trusted text", () => {
    renderStage({ exactTextAvailable: false })

    expect(screen.getByText("Exact text unavailable")).toBeInTheDocument()
  })

  it("surfaces frame unavailable without exposing implementation terminology", () => {
    const { container } = renderStage({
      state: {
        state: "co_review_error",
        error: "frame_send_closed_gemini_websocket",
        frameSendFailureCount: 1,
      },
      canStartReview: false,
      transportStatus: unsupportedTransportStatus,
    })

    expect(screen.getAllByText("Frame unavailable").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    const renderedText = within(artifactRegion).queryByText(/coreview|gemini|websocket|transport|liveframes|fixture/i)
    expect(renderedText).not.toBeInTheDocument()
    expect(container.textContent?.toLowerCase()).not.toContain("still-frame")
  })

  it("uses Stop Looking while review is active", async () => {
    const user = userEvent.setup()
    const { onStopReview } = renderStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
      },
    })

    await user.click(screen.getByRole("button", { name: /stop looking/i }))

    expect(onStopReview).toHaveBeenCalledTimes(1)
  })

  it("hides review controls when review is disabled", () => {
    renderStage({ reviewEnabled: false })

    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/exact text/i)).not.toBeInTheDocument()
  })

  it("fetches and renders a markdown artifact as a document preview", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nThe artifact is **ready** for review.", {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    expect(screen.getByText(/The artifact is/i)).toBeInTheDocument()
    expect(screen.getByText("ready")).toBeInTheDocument()
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
      }),
    )
  })

  it("renders markdown from content type metadata even when the extension is not enough", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("## Metadata Preview\n\nA markdown response from the artifact route.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderStage({
      artifact: {
        ...builderArtifact,
        artifactPath: "mnt/user-data/outputs/launch-brief",
      },
      artifactLibrary: [{
        path: "mnt/user-data/outputs/launch-brief",
        name: "launch-brief",
        mimeType: "text/markdown",
      }],
    })

    expect(await screen.findByRole("heading", { name: "Metadata Preview" })).toBeInTheDocument()
  })

  it("escapes markdown HTML instead of mounting untrusted elements", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Safe\n\n<script>alert(\"x\")</script>", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )
    const { container } = renderStage({ artifact: markdownBuilderArtifact })

    expect(await screen.findByRole("heading", { name: "Safe" })).toBeInTheDocument()
    expect(screen.getByText("<script>alert(\"x\")</script>")).toBeInTheDocument()
    expect(container.querySelector("script")).toBeNull()
  })

  it("shows a loading state while markdown preview content is being fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    const viewport = await screen.findByTestId("artifact-canvas-viewport")
    expect(viewport).toContainElement(screen.getByTestId("artifact-canvas-scroll-area"))
    const previewRegion = await screen.findByLabelText("Artifact document preview")
    expect(within(previewRegion).getByText("Preparing document view")).toBeInTheDocument()
    expect(screen.queryByText("Loading preview")).not.toBeInTheDocument()
  })

  it("scrolls long markdown inside the canvas while toolbar and review actions remain outside it", async () => {
    const longMarkdown = [
      "# Launch Brief",
      "",
      ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}: more detail for the in-session canvas.`),
    ].join("\n\n")
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(longMarkdown, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    )

    renderStage({ artifact: markdownBuilderArtifact, fillAvailable: true })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    const toolbar = screen.getByTestId("artifact-toolbar")
    const viewport = screen.getByTestId("artifact-canvas-viewport")
    const scrollArea = screen.getByTestId("artifact-canvas-scroll-area")

    expect(viewport.className).toContain("flex-1")
    expect(scrollArea.className).toContain("overflow-y-auto")
    expect(toolbar).not.toBe(scrollArea)
    expect(scrollArea).not.toContainElement(toolbar)
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toBeInTheDocument()
    expect(screen.getByLabelText("Download Launch brief overview")).toBeInTheDocument()
  })

  it("shows preview unavailable on fetch failure while keeping Open and Download available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("missing", { status: 404 }))

    renderStage({ artifact: markdownBuilderArtifact })

    const previewRegion = await screen.findByLabelText("Artifact document preview")
    expect(within(previewRegion).getByText("Preview unavailable")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview in new tab")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
    )
    expect(screen.getByLabelText("Download Launch brief overview")).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true",
    )
  })

  it("keeps Review with Sophia visible for markdown previews without debug terminology", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nA clean document preview.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    const { container } = renderStage({ artifact: markdownBuilderArtifact })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
    expect(container.textContent?.toLowerCase()).not.toMatch(
      /coreview|gemini|websocket|transport|liveframes|fixture/,
    )
  })

  it("registers fetched markdown as trusted builder file text when an artifact id is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Exact Title\n\nBudget delta: 17.4%", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderStage({
      artifact: markdownBuilderArtifact,
      artifactId: "coreview-real-artifact-launch-brief",
      sessionId: "session-1",
      normalSessionId: "normal-1",
    })

    expect(await screen.findByRole("heading", { name: "Exact Title" })).toBeInTheDocument()
    const response = readCoreviewArtifactTextSideband({
      artifactId: "coreview-real-artifact-launch-brief",
      sessionId: "session-1",
      threadId: "thread-1",
    })

    expect(response).toMatchObject({
      ok: true,
      source: "builder_file",
      text: "# Exact Title\n\nBudget delta: 17.4%",
    })
  })

  it("does not fetch non-markdown artifacts and keeps the existing shell fallback", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    renderStage()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText("Primary file")).toBeInTheDocument()
    expect(screen.getByText("launch-brief.pdf")).toBeInTheDocument()
  })
})
