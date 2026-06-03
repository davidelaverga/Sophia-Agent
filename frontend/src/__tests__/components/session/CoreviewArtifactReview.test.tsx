import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  CoreviewCompanionArtifactCanvas,
} from "../../../app/components/session/CoreviewCompanionArtifactCanvas"
import { buildCoreviewRealArtifactId } from "../../../app/components/session/CoreviewRealArtifactCanvas"
import { PresenceArtifactPanel } from "../../../app/components/session/PresenceArtifactPanel"
import type { ArtifactFrameSender } from "../../../app/lib/co-review-still-frame-transport"
import { GeminiStillFrameTransport } from "../../../app/lib/co-review-still-frame-transport"
import {
  clearCoreviewArtifactTextRegistryForTests,
  readCoreviewArtifactTextSideband,
} from "../../../app/lib/coreview-artifact-text"
import { loadPdfJs } from "../../../app/lib/pdfjs-loader"
import {
  exportSophiaCaptureBundle,
  registerSophiaCaptureBridge,
} from "../../../app/lib/session-capture"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

vi.mock("../../../app/lib/pdfjs-loader", () => ({
  loadPdfJs: vi.fn(),
}))

const originalToBlob = HTMLCanvasElement.prototype.toBlob
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
const originalCoreviewFlag = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED
const originalStillFrameFlag = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED

let getContextSpy: ReturnType<typeof vi.spyOn> | null = null
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null
let getDisplayMedia: ReturnType<typeof vi.fn>

const BUILDER_ARTIFACT = {
  artifactType: "document",
  artifactTitle: "Launch brief overview",
  artifactPath: "mnt/user-data/outputs/launch-brief.docx",
  supportingFiles: ["mnt/user-data/outputs/launch-brief-notes.md"],
  decisionsMade: [
    "Kept the visual review focused on builder metadata.",
    "Left exact table values to read_artifact_text.",
  ],
  companionSummary: "Overview card for the completed launch brief.",
  userNextAction: "Open the PDF for the full deliverable.",
  confidence: 0.74,
  stepsCompleted: 3,
}

const MARKDOWN_BUILDER_ARTIFACT = {
  ...BUILDER_ARTIFACT,
  artifactPath: "mnt/user-data/outputs/launch-brief.docx",
  supportingFiles: ["mnt/user-data/outputs/launch-brief.md"],
}

const MARKDOWN_LIBRARY = [
  {
    path: "mnt/user-data/outputs/launch-brief.md",
    name: "launch-brief.md",
    mimeType: "text/markdown",
  },
]
const PDF_SELECTED_PATH = "mnt/user-data/outputs/launch-brief.pdf"
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

const SELECTED_MARKDOWN_ARTIFACT = {
  ...MARKDOWN_BUILDER_ARTIFACT,
  artifactTitle: "launch-brief.md",
  artifactPath: "mnt/user-data/outputs/launch-brief.md",
  supportingFiles: ["mnt/user-data/outputs/launch-brief.docx"],
}

const COMPANION_ARTIFACTS: NonNullable<ComponentProps<typeof PresenceArtifactPanel>["artifacts"]> = {
  takeaway: "Focus on the big picture first.",
  reflection_candidate: {
    prompt: "What changed after you named the constraint?",
    why: "It may clarify the next move.",
  },
  memory_candidates: [
    {
      category: "reflective",
      confidence: 0.82,
      memory: "The user notices when planning becomes avoidance.",
    },
  ],
}

function renderPanel({
  artifacts = null,
  builderArtifact = null,
  builderArtifactLibrary = [],
  selectedBuilderArtifactPath,
  isVoiceMode = false,
  pendingBuilderArtifactReview = false,
  onStartVoiceBuilderArtifactReview,
  onPendingBuilderArtifactReviewConsumed,
  transport = new GeminiStillFrameTransport({
    sendArtifactFrame: vi.fn((frame) => ({
      ok: true,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: true,
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      frameSendLatencyMs: 4,
      estimatedVisualCost: null,
      error: null,
      rawFrameExcluded: true as const,
    })),
  }),
}: {
  artifacts?: ComponentProps<typeof PresenceArtifactPanel>["artifacts"]
  builderArtifact?: ComponentProps<typeof PresenceArtifactPanel>["builderArtifact"]
  builderArtifactLibrary?: NonNullable<ComponentProps<typeof PresenceArtifactPanel>["builderArtifactLibrary"]>
  selectedBuilderArtifactPath?: ComponentProps<typeof PresenceArtifactPanel>["selectedBuilderArtifactPath"]
  isVoiceMode?: boolean
  pendingBuilderArtifactReview?: ComponentProps<typeof PresenceArtifactPanel>["pendingBuilderArtifactReview"]
  onStartVoiceBuilderArtifactReview?: ComponentProps<typeof PresenceArtifactPanel>["onStartVoiceBuilderArtifactReview"]
  onPendingBuilderArtifactReviewConsumed?: ComponentProps<typeof PresenceArtifactPanel>["onPendingBuilderArtifactReviewConsumed"]
  transport?: GeminiStillFrameTransport
}) {
  render(
    <PresenceArtifactPanel
      artifacts={artifacts}
      builderArtifact={builderArtifact}
      builderArtifactLibrary={builderArtifactLibrary}
      selectedBuilderArtifactPath={selectedBuilderArtifactPath}
      sessionId="session-1"
      normalSessionId="normal-1"
      threadId="thread-1"
      isVisible={true}
      onDismiss={vi.fn()}
      isVoiceMode={isVoiceMode}
      coReviewTransport={transport}
      pendingBuilderArtifactReview={pendingBuilderArtifactReview}
      onStartVoiceBuilderArtifactReview={onStartVoiceBuilderArtifactReview}
      onPendingBuilderArtifactReviewConsumed={onPendingBuilderArtifactReviewConsumed}
    />,
  )
}

function closedVoiceFrameTransport(sendArtifactFrame = vi.fn()) {
  return new GeminiStillFrameTransport({
    getStatus: () => ({
      websocketReadyState: null,
      websocketState: "closed",
      websocketOpen: false,
      websocketCloseCode: null,
      websocketCloseReasonSafe: null,
      websocketCloseWasClean: null,
      websocketCloseAt: null,
      error: "voice_not_started",
    }),
    sendArtifactFrame,
  })
}

function mockCanvasApis() {
  const gradient = { addColorStop: vi.fn() }
  const context = {
    arcTo: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
    moveTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: "",
    font: "",
    strokeStyle: "",
  } as unknown as CanvasRenderingContext2D

  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)

  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback, mimeType?: string) {
      callback(new Blob([new Uint8Array(64)], { type: mimeType || "image/jpeg" }))
    },
  })
}

function mockPdfPreviewLoading() {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(pdfBytes.slice(), {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }),
  )
  const getDocument = vi.fn(() => ({
    promise: new Promise(() => undefined),
    destroy: vi.fn(),
  }))
  vi.mocked(loadPdfJs).mockResolvedValue({
    getDocument,
  } as unknown as Awaited<ReturnType<typeof loadPdfJs>>)

  return { getDocument }
}

function setCoreviewFlags(enabled: boolean) {
  process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED = enabled ? "true" : "false"
  process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED = enabled ? "true" : "false"
}

describe("Coreview artifact still-frame review", () => {
  beforeEach(() => {
    mockCanvasApis()
    getDisplayMedia = vi.fn()
    setCoreviewFlags(false)
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })
  })

  afterEach(() => {
    window.__sophiaCapture?.disable()
    window.__sophiaCapture?.clear()
    clearCoreviewArtifactTextRegistryForTests()
    fetchSpy?.mockRestore()
    fetchSpy = null
    vi.mocked(loadPdfJs).mockReset()
    getContextSpy?.mockRestore()
    getContextSpy = null
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: originalToBlob,
    })
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices)
    } else {
      delete (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices
    }
    process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED = originalCoreviewFlag
    process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED = originalStillFrameFlag
  })

  it("keeps artifact review hidden when the two Coreview flags are off", () => {
    renderPanel({ artifacts: COMPANION_ARTIFACTS })

    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
  })

  it("renders a builder artifact in text mode as a wide in-session stage, not a fixed overlay", async () => {
    renderPanel({ builderArtifact: BUILDER_ARTIFACT, isVoiceMode: false })

    const panel = await screen.findByRole("complementary", { name: /session artifacts/i })
    const artifactRegion = await screen.findByRole("region", { name: /generated artifact/i })

    expect(panel.className).toContain("h-full")
    expect(panel.className).toContain("max-w-none")
    expect(panel.className).not.toMatch(/\bfixed\b|\binset-0\b|\bmax-w-4xl\b/)
    expect(artifactRegion.className).toContain("w-full")
    expect(artifactRegion.className).toContain("flex-1")
    expect(within(artifactRegion).getByTestId("artifact-canvas-bed").className).toContain("flex-1")
    expect(within(artifactRegion).getByTestId("artifact-document-page").className).toContain("max-w-[960px]")
  })

  it("isolates a selected builder artifact from companion copy and secondary file rows", async () => {
    renderPanel({
      artifacts: COMPANION_ARTIFACTS,
      builderArtifact: BUILDER_ARTIFACT,
      builderArtifactLibrary: [{
        path: "mnt/user-data/outputs/launch-brief.docx",
        name: "launch-brief.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }],
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.docx",
    })

    const artifactRegion = await screen.findByRole("region", { name: /generated artifact/i })

    expect(artifactRegion).toBeInTheDocument()
    expect(screen.queryByText("Focus on the big picture first.")).not.toBeInTheDocument()
    expect(screen.queryByText("What changed after you named the constraint?")).not.toBeInTheDocument()
    expect(screen.queryByText("The user notices when planning becomes avoidance.")).not.toBeInTheDocument()
    expect(screen.queryByText("Session files")).not.toBeInTheDocument()
    expect(screen.queryByTestId("coreview-companion-artifact-canvas")).not.toBeInTheDocument()
    expect(screen.getAllByRole("region", { name: /generated artifact/i })).toHaveLength(1)
  })

  it("keeps a selected PDF artifact active while library metadata hydrates", async () => {
    const pdf = mockPdfPreviewLoading()

    renderPanel({
      artifacts: COMPANION_ARTIFACTS,
      selectedBuilderArtifactPath: PDF_SELECTED_PATH,
    })

    const artifactRegion = await screen.findByRole("region", { name: /generated artifact/i })

    expect(artifactRegion).toHaveAttribute("data-artifact-renderer-kind", "pdf")
    expect(await within(artifactRegion).findByText("Preparing PDF view")).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.pdf",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin", method: "GET" }),
    )
    expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Uint8Array),
    }))
    expect(screen.queryByText("Focus on the big picture first.")).not.toBeInTheDocument()
    expect(screen.queryByText("What changed after you named the constraint?")).not.toBeInTheDocument()
    expect(screen.queryByTestId("coreview-companion-artifact-canvas")).not.toBeInTheDocument()
  })

  it("records selected builder stage identity with Coreview off without activating companion review", async () => {
    registerSophiaCaptureBridge()
    window.__sophiaCapture?.clear()
    window.__sophiaCapture?.enable()

    renderPanel({
      artifacts: COMPANION_ARTIFACTS,
      builderArtifact: BUILDER_ARTIFACT,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.docx",
    })

    expect(await screen.findByRole("region", { name: /generated artifact/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId("coreview-companion-artifact-canvas")).not.toBeInTheDocument()

    const expectedArtifactId = buildCoreviewRealArtifactId(BUILDER_ARTIFACT)

    await waitFor(() => {
      const selectedStageEvents = exportSophiaCaptureBundle().events.filter(
        (event) => event.category === "artifacts-runtime" && event.name === "select-stage-artifact",
      )
      expect(selectedStageEvents).toHaveLength(1)
      expect(selectedStageEvents[0]?.payload).toMatchObject({
        artifactId: expectedArtifactId,
        coreviewArtifactId: expectedArtifactId,
        artifactPath: "mnt/user-data/outputs/launch-brief.docx",
        artifactKind: "builder_file",
        selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.docx",
        source: "selected_builder_artifact",
        reviewFeatureEnabled: false,
        rawArtifactTextExcluded: true,
        rawFrameExcluded: true,
      })
    })
  })

  it("renders the guarded builder metadata canvas when still-frame review is enabled", async () => {
    setCoreviewFlags(true)

    renderPanel({ builderArtifact: BUILDER_ARTIFACT })

    const artifactId = buildCoreviewRealArtifactId(BUILDER_ARTIFACT)
    const canvas = await screen.findByLabelText("Builder artifact metadata overview canvas")

    expect(canvas).toHaveAttribute("data-artifact-id", artifactId)
    expect(canvas).toHaveAttribute("data-coreview-artifact-id", artifactId)
    expect(canvas).toHaveAttribute("data-artifact-canvas", "true")
    expect(canvas).toHaveAttribute("data-coreview-artifact-canvas", "true")
    expect(canvas).toHaveAttribute("data-coreview-offscreen-render", "true")
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
  })

  it("registers guarded builder metadata text for read_artifact_text", async () => {
    setCoreviewFlags(true)

    renderPanel({ builderArtifact: BUILDER_ARTIFACT })

    const artifactId = buildCoreviewRealArtifactId(BUILDER_ARTIFACT)
    await screen.findByLabelText("Builder artifact metadata overview canvas")

    const response = readCoreviewArtifactTextSideband({
      artifactId,
      sessionId: "session-1",
      threadId: "thread-1",
    })

    expect(response).toMatchObject({
      ok: true,
      artifact_id: artifactId,
      source: "builder_metadata",
      truncated: false,
    })
    if (!response.ok) throw new Error("expected builder metadata text")
    expect(response.text).toContain("Title: Launch brief overview")
    expect(response.text).toContain("Artifact type: Document")
    expect(response.text).toContain("Builder file contents: unsupported")
  })

  it("Review with Sophia sends one builder artifact frame without screen capture", async () => {
    setCoreviewFlags(true)
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn<ArtifactFrameSender["sendArtifactFrame"]>((frame, _context) => ({
      ok: true,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: true,
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      frameSendLatencyMs: 7,
      estimatedVisualCost: null,
      error: null,
      rawFrameExcluded: true as const,
    }))
    const transport = new GeminiStillFrameTransport({ sendArtifactFrame })

    renderPanel({ builderArtifact: BUILDER_ARTIFACT, transport })

    await user.click(await screen.findByRole("button", { name: /review with sophia/i }))

    await waitFor(() => expect(sendArtifactFrame).toHaveBeenCalledTimes(1))
    expect(sendArtifactFrame.mock.calls[0]?.[0]).toMatchObject({
      artifactId: buildCoreviewRealArtifactId(BUILDER_ARTIFACT),
      rawFrameExcluded: true,
    })
    expect(sendArtifactFrame.mock.calls[0]?.[1]).toEqual({ coreviewSendStage: "start" })
    expect(screen.getByRole("status", { name: /looking/i })).toBeInTheDocument()
    expect(screen.getByText("Frame sent")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /refresh view/i })).not.toBeInTheDocument()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it.each([
    { isVoiceMode: false, label: "text mode" },
    { isVoiceMode: true, label: "voice mode" },
  ])("renders the same selected artifact stage in $label", async ({ isVoiceMode }) => {
    setCoreviewFlags(true)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nShared preview source.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
      isVoiceMode,
    })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    const artifactRegion = screen.getByRole("region", { name: /generated artifact/i })
    const reviewSurface = isVoiceMode ? screen.getByTestId("voice-artifact-stage") : artifactRegion
    expect(within(artifactRegion).getAllByText("launch-brief.md").length).toBeGreaterThanOrEqual(1)
    expect(within(reviewSurface).getByRole("button", { name: /review with sophia/i })).toBeInTheDocument()
    expect(within(artifactRegion).getByLabelText(/open launch-brief\.md in new tab/i)).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
    )
    expect(within(artifactRegion).getByLabelText(/download launch-brief\.md/i)).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true",
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
      }),
    )
  })

  it("exposes a capture-ready selected markdown artifact source without frame-unavailable copy", async () => {
    setCoreviewFlags(true)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nShared preview source.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
    })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    const expectedArtifactId = buildCoreviewRealArtifactId(SELECTED_MARKDOWN_ARTIFACT)
    const captureRegion = await screen.findByTestId("artifact-markdown-capture-canvas")
    const captureCanvas = captureRegion.querySelector("canvas")

    expect(captureCanvas).toHaveAttribute("data-artifact-id", expectedArtifactId)
    expect(captureCanvas).toHaveAttribute("data-artifact-canvas-source", "selected-markdown-preview")
    await waitFor(() => expect(screen.getByRole("button", { name: /review with sophia/i })).toBeEnabled())
    expect(screen.queryByText("Frame unavailable")).not.toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
  })

  it("shows start-voice copy for a selected markdown artifact when text mode has no visual sender", async () => {
    setCoreviewFlags(true)
    const user = userEvent.setup()
    const onStartVoiceBuilderArtifactReview = vi.fn()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nExact text is ready before voice starts.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
      isVoiceMode: false,
      transport: closedVoiceFrameTransport(),
      onStartVoiceBuilderArtifactReview,
    })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("Start voice to review visually")).toBeInTheDocument())
    expect(screen.queryByText("Frame unavailable")).not.toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /start voice & review/i }))

    expect(onStartVoiceBuilderArtifactReview).toHaveBeenCalledTimes(1)
  })

  it("renders voice mode through the shared artifact stage without a second artifact surface", async () => {
    setCoreviewFlags(true)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nShared preview source in voice mode.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
      isVoiceMode: true,
    })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    const panel = screen.getByRole("complementary", { name: /session artifacts/i })
    const voiceStage = screen.getByTestId("voice-artifact-stage")
    const artifactRegion = within(voiceStage).getByRole("region", { name: /generated artifact/i })
    const voiceStageWrapper = voiceStage.parentElement
    const builderRoot = voiceStageWrapper?.parentElement

    expect(panel.className).toContain("fixed")
    expect(panel.className).toContain("top-[72px]")
    expect(panel.className).toContain("bottom-[calc(8.75rem+env(safe-area-inset-bottom,0px))]")
    expect(panel.className).toContain("min-h-0")
    expect(panel.className).toContain("overflow-hidden")
    expect(voiceStageWrapper?.className).toContain("h-full")
    expect(voiceStageWrapper?.className).toContain("min-h-0")
    expect(voiceStageWrapper?.className).toContain("overflow-hidden")
    expect(builderRoot?.className).toContain("h-full")
    expect(builderRoot?.className).toContain("min-h-0")
    expect(builderRoot?.className).toContain("overflow-hidden")
    expect(voiceStage.className).toContain("overflow-hidden")
    expect(within(voiceStage).getAllByTestId("artifact-canvas-viewport")).toHaveLength(1)
    expect(within(artifactRegion).getByTestId("artifact-canvas-scroll-area")).toBeInTheDocument()
    expect(within(voiceStage).getAllByText("Page 1 of 1")).toHaveLength(1)
    expect(within(voiceStage).getAllByTestId("artifact-review-status")).toHaveLength(1)
    expect(within(voiceStage).getByLabelText(/open launch-brief\.md in new tab/i)).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md",
    )
    expect(within(voiceStage).getByLabelText(/download launch-brief\.md/i)).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/launch-brief.md?download=true",
    )
    expect(screen.getAllByRole("region", { name: /generated artifact/i })).toHaveLength(1)
    expect(screen.queryByText(/coreview|gemini|websocket|transport|liveframes|fixture|direct video|provider ack/i)).not.toBeInTheDocument()
  })

  it("Review with Sophia sends the selected markdown artifact frame and keeps exact text available", async () => {
    setCoreviewFlags(true)
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn<ArtifactFrameSender["sendArtifactFrame"]>((frame) => ({
      ok: true,
      supported: true,
      providerAcceptedFrame: true,
      websocketSendAccepted: true,
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      frameSendLatencyMs: 6,
      estimatedVisualCost: null,
      error: null,
      rawFrameExcluded: true as const,
    }))
    const transport = new GeminiStillFrameTransport({ sendArtifactFrame })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Exact Launch Title\n\nBudget delta: 17.4%", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
      transport,
    })

    expect(await screen.findByRole("heading", { name: "Exact Launch Title" })).toBeInTheDocument()
    const expectedArtifactId = buildCoreviewRealArtifactId(SELECTED_MARKDOWN_ARTIFACT)
    await waitFor(() => expect(screen.getByRole("button", { name: /review with sophia/i })).toBeEnabled())

    const textResponse = readCoreviewArtifactTextSideband({
      artifactId: expectedArtifactId,
      sessionId: "session-1",
      threadId: "thread-1",
    })
    expect(textResponse).toMatchObject({
      ok: true,
      source: "builder_file",
      text: "# Exact Launch Title\n\nBudget delta: 17.4%",
    })

    await user.click(screen.getByRole("button", { name: /review with sophia/i }))

    await waitFor(() => expect(sendArtifactFrame).toHaveBeenCalledTimes(1))
    expect(sendArtifactFrame.mock.calls[0]?.[0]).toMatchObject({
      artifactId: expectedArtifactId,
      visualSourceKind: "offscreen_render",
      rawFrameExcluded: true,
    })
    expect(sendArtifactFrame.mock.calls[0]?.[1]).toEqual({ coreviewSendStage: "start" })
    expect(screen.getByRole("status", { name: /sophia is looking/i })).toBeInTheDocument()
    expect(screen.getByText("Frame sent")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("shows safe frame-unavailable copy when the selected markdown capture canvas cannot be prepared", async () => {
    setCoreviewFlags(true)
    getContextSpy?.mockReturnValue(null)
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("# Launch Brief\n\nThe text can render even if capture fails.", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      }),
    )

    renderPanel({
      builderArtifact: MARKDOWN_BUILDER_ARTIFACT,
      builderArtifactLibrary: MARKDOWN_LIBRARY,
      selectedBuilderArtifactPath: "mnt/user-data/outputs/launch-brief.md",
    })

    expect(await screen.findByRole("heading", { name: "Launch Brief" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("Visual review not active")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(screen.queryByText(/coreview|gemini|websocket|transport|liveframes|fixture|direct video|provider ack/i)).not.toBeInTheDocument()
  })

  it("renders and registers the companion artifact canvas exact text", async () => {
    setCoreviewFlags(true)

    render(
      <CoreviewCompanionArtifactCanvas
        artifacts={COMPANION_ARTIFACTS}
        sessionId="session-1"
        normalSessionId="normal-1"
        threadId="thread-1"
      />,
    )

    const canvas = await screen.findByLabelText("Companion artifact overview canvas")
    expect(canvas).toHaveAttribute("data-artifact-id", COREVIEW_COMPANION_ARTIFACT_ID)
    expect(canvas).toHaveAttribute("data-coreview-offscreen-render", "true")

    const response = readCoreviewArtifactTextSideband({
      artifactId: COREVIEW_COMPANION_ARTIFACT_ID,
      sessionId: "session-1",
      threadId: "thread-1",
    })
    expect(response).toMatchObject({
      ok: true,
      artifact_id: COREVIEW_COMPANION_ARTIFACT_ID,
      source: "artifact_store",
    })
    if (!response.ok) throw new Error("expected companion artifact text")
    expect(response.text).toContain("Takeaway: Focus on the big picture first.")
    expect(response.text).toContain("Reflection: What changed after you named the constraint?")
  })

  it("Review with Sophia sends one companion artifact frame without OCR or screen capture", async () => {
    setCoreviewFlags(true)
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn((frame) => ({
      ok: true,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: true,
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      frameSendLatencyMs: 5,
      estimatedVisualCost: null,
      error: null,
      rawFrameExcluded: true as const,
    }))
    const transport = new GeminiStillFrameTransport({ sendArtifactFrame })

    renderPanel({ artifacts: COMPANION_ARTIFACTS, transport })

    await user.click(await screen.findByRole("button", { name: /review with sophia/i }))

    await waitFor(() => expect(sendArtifactFrame).toHaveBeenCalledTimes(1))
    expect(sendArtifactFrame.mock.calls[0]?.[0]).toMatchObject({
      artifactId: COREVIEW_COMPANION_ARTIFACT_ID,
      visualSourceKind: "offscreen_render",
      rawFrameExcluded: true,
    })
    expect(screen.getByText("Frame sent")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("shows frame unavailable without sending when the Gemini websocket is closed", async () => {
    setCoreviewFlags(true)
    const sendArtifactFrame = vi.fn()
    const transport = new GeminiStillFrameTransport({
      getStatus: () => ({
        websocketReadyState: 3,
        websocketState: "closed",
        websocketOpen: false,
        websocketCloseCode: 1007,
        websocketCloseReasonSafe: "invalid frame",
        websocketCloseWasClean: false,
        websocketCloseAt: "2026-05-27T00:00:00.000Z",
        error: "gemini_live_websocket_not_open",
      }),
      sendArtifactFrame,
    })

    renderPanel({ artifacts: COMPANION_ARTIFACTS, transport })

    expect(await screen.findByText("Visual review not active")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
    expect(sendArtifactFrame).not.toHaveBeenCalled()
  })
})
