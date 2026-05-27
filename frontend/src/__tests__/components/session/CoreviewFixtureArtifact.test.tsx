import { type ComponentProps } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CoreviewFixtureLauncher } from "../../../app/components/session/CoreviewFixtureLauncher"
import { PresenceArtifactPanel } from "../../../app/components/session/PresenceArtifactPanel"
import { COREVIEW_FIXTURE_ARTIFACT_ID } from "../../../app/components/session/CoreviewFixtureArtifact"
import { buildCoreviewRealArtifactId } from "../../../app/components/session/CoreviewRealArtifactCanvas"
import { isCoReviewFixtureEnabled } from "../../../app/lib/co-review-flags"
import { GeminiStillFrameTransport } from "../../../app/lib/co-review-still-frame-transport"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

const originalToBlob = HTMLCanvasElement.prototype.toBlob
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
const originalCoreviewFlag = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED
const originalStillFrameFlag = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED
const originalRealArtifactFlag = process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED

let getContextSpy: ReturnType<typeof vi.spyOn> | null = null
let getDisplayMedia: ReturnType<typeof vi.fn>

const BUILDER_ARTIFACT = {
  artifactType: "document",
  artifactTitle: "Launch brief overview",
  artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
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

function renderFixturePanel({
  showCoReviewFixture,
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
  artifacts = null,
  builderArtifact = null,
}: {
  showCoReviewFixture: boolean
  transport?: GeminiStillFrameTransport
  artifacts?: ComponentProps<typeof PresenceArtifactPanel>["artifacts"]
  builderArtifact?: ComponentProps<typeof PresenceArtifactPanel>["builderArtifact"]
}) {
  render(
    <PresenceArtifactPanel
      artifacts={artifacts}
      builderArtifact={builderArtifact}
      builderArtifactLibrary={[]}
      sessionId="session-1"
      normalSessionId="normal-1"
      threadId="thread-1"
      isVisible={true}
      onDismiss={vi.fn()}
      isVoiceMode={false}
      showCoReviewFixture={showCoReviewFixture}
      coReviewTransport={transport}
    />,
  )
}

function renderRootLauncher({
  isVisible,
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
  isVisible: boolean
  transport?: GeminiStillFrameTransport
}) {
  render(
    <CoreviewFixtureLauncher
      isVisible={isVisible}
      sessionId="session-1"
      normalSessionId="normal-1"
      threadId="thread-1"
      coReviewTransport={transport}
    />,
  )
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

function setRealArtifactFlags(enabled: boolean) {
  process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED = enabled ? "true" : "false"
  process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED = enabled ? "true" : "false"
  process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED = enabled ? "true" : "false"
}

describe("CoreviewFixtureArtifact in the presence panel", () => {
  beforeEach(() => {
    mockCanvasApis()
    getDisplayMedia = vi.fn()
    setRealArtifactFlags(false)
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    })
  })

  afterEach(() => {
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
    process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_REAL_ARTIFACT_ENABLED = originalRealArtifactFlag
  })

  it("keeps the fixture hidden by default", () => {
    expect(isCoReviewFixtureEnabled()).toBe(false)

    renderFixturePanel({ showCoReviewFixture: false })

    expect(screen.queryByTestId("coreview-fixture-artifact")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /review together/i })).not.toBeInTheDocument()
  })

  it("shows the panel fixture when all co-review fixture flags are enabled", async () => {
    const enabled = isCoReviewFixtureEnabled({
      coReview: "true",
      stillFrame: "true",
      fixture: "true",
    })

    renderFixturePanel({ showCoReviewFixture: enabled })

    expect(await screen.findByText(/local co-review fixture/i)).toBeInTheDocument()
    expect(screen.getByLabelText("Q3 Launch Review fixture artifact")).toBeInTheDocument()
  })

  it("renders a canvas with the co-review capture attributes", async () => {
    renderFixturePanel({ showCoReviewFixture: true })

    const canvas = await screen.findByLabelText("Q3 Launch Review fixture artifact")

    expect(canvas).toHaveAttribute("data-artifact-id", COREVIEW_FIXTURE_ARTIFACT_ID)
    expect(canvas).toHaveAttribute("data-coreview-artifact-id", COREVIEW_FIXTURE_ARTIFACT_ID)
    expect(canvas).toHaveAttribute("data-coreview-session-id", "session-1")
    expect(canvas).toHaveAttribute("data-coreview-normal-session-id", "normal-1")
    expect(canvas).toHaveAttribute("data-artifact-canvas", "true")
    expect(canvas).toHaveAttribute("data-coreview-artifact-canvas", "true")
    expect(screen.getByTestId("coreview-fixture-artifact")).toHaveAttribute("data-artifact-region", "true")
    expect(screen.getByTestId("coreview-fixture-artifact")).toHaveAttribute("data-coreview-artifact-region", "true")
  })

  it("renders the guarded builder metadata canvas when the real-artifact flag is enabled", async () => {
    setRealArtifactFlags(true)

    renderFixturePanel({
      showCoReviewFixture: false,
      builderArtifact: BUILDER_ARTIFACT,
    })

    const artifactId = buildCoreviewRealArtifactId(BUILDER_ARTIFACT)
    const canvas = await screen.findByLabelText("Builder artifact metadata overview canvas")

    expect(canvas).toHaveAttribute("data-artifact-id", artifactId)
    expect(canvas).toHaveAttribute("data-coreview-artifact-id", artifactId)
    expect(canvas).toHaveAttribute("data-artifact-canvas", "true")
    expect(canvas).toHaveAttribute("data-coreview-artifact-canvas", "true")
    expect(canvas).toHaveAttribute("data-coreview-offscreen-render", "true")
    expect(screen.getByTestId("coreview-real-artifact-canvas")).toHaveAttribute("data-artifact-region", "true")
    expect(screen.getByRole("button", { name: /review together/i })).toBeInTheDocument()
  })

  it("Review Together uses the guarded real builder artifact canvas without screen capture", async () => {
    setRealArtifactFlags(true)
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn((frame) => ({
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

    renderFixturePanel({
      showCoReviewFixture: false,
      builderArtifact: BUILDER_ARTIFACT,
      transport,
    })

    await user.click(screen.getByRole("button", { name: /review together/i }))

    await waitFor(() => expect(sendArtifactFrame).toHaveBeenCalledTimes(1))
    expect(sendArtifactFrame.mock.calls[0]?.[0]).toMatchObject({
      artifactId: buildCoreviewRealArtifactId(BUILDER_ARTIFACT),
      rawFrameExcluded: true,
    })
    expect(screen.getByRole("status", { name: /looking at this artifact/i })).toBeInTheDocument()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("DOM-only artifacts fail closed with the safe renderer reason", async () => {
    setRealArtifactFlags(true)
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn()
    const transport = new GeminiStillFrameTransport({ sendArtifactFrame })

    renderFixturePanel({
      showCoReviewFixture: false,
      artifacts: {
        takeaway: "Focus on the big picture first.",
      } as ComponentProps<typeof PresenceArtifactPanel>["artifacts"],
      transport,
    })

    await user.click(screen.getByRole("button", { name: /review together/i }))

    await waitFor(() => {
      expect(screen.getByText("still-frame unavailable: dom_artifact_requires_safe_renderer")).toBeInTheDocument()
    })
    expect(sendArtifactFrame).not.toHaveBeenCalled()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("/session page root keeps Open Coreview Fixture hidden when the flag gate is off", () => {
    renderRootLauncher({ isVisible: false })

    expect(screen.queryByRole("button", { name: /open coreview fixture/i })).not.toBeInTheDocument()
  })

  it("/session page root shows Open Coreview Fixture and debug flags when enabled", () => {
    renderRootLauncher({ isVisible: true })

    expect(screen.getByRole("button", { name: /open coreview fixture/i })).toBeInTheDocument()
    expect(screen.getByText("Coreview fixture flag: on")).toBeInTheDocument()
    expect(screen.getByText("Still frame flag: on")).toBeInTheDocument()
  })

  it("clicking the root launcher opens Q3 Launch Review", async () => {
    const user = userEvent.setup()

    renderRootLauncher({ isVisible: true })

    await user.click(screen.getByRole("button", { name: /open coreview fixture/i }))

    expect(await screen.findByRole("dialog", { name: /coreview fixture/i })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Q3 Launch Review" })).toBeInTheDocument()
    expect(screen.getByLabelText("Q3 Launch Review fixture artifact")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review together/i })).toBeInTheDocument()
    expect(screen.getByText(`artifact id`)).toBeInTheDocument()
    expect(screen.getByText(COREVIEW_FIXTURE_ARTIFACT_ID)).toBeInTheDocument()
    expect(screen.getByText("session-1")).toBeInTheDocument()
    expect(screen.getByText("thread-1")).toBeInTheDocument()
    expect(screen.getByText("still_frame")).toBeInTheDocument()
    expect(screen.getByText("tool status")).toBeInTheDocument()
  })

  it("Review Together starts from the root fixture without screen capture", async () => {
    const user = userEvent.setup()
    const sendArtifactFrame = vi.fn((frame) => ({
      ok: true,
      supported: true,
      providerAcceptedFrame: false,
      websocketSendAccepted: true,
      frameBytes: frame.byteLength,
      frameDimensions: frame.dimensions,
      frameSendLatencyMs: 6,
      estimatedVisualCost: null,
      error: null,
      rawFrameExcluded: true as const,
    }))
    const transport = new GeminiStillFrameTransport({ sendArtifactFrame })

    renderRootLauncher({ isVisible: true, transport })

    await user.click(screen.getByRole("button", { name: /open coreview fixture/i }))
    await user.click(await screen.findByRole("button", { name: /review together/i }))

    await waitFor(() => expect(sendArtifactFrame).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("status", { name: /looking at this artifact/i })).toBeInTheDocument()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it("shows a visible closed-websocket error without entering looking state", async () => {
    const user = userEvent.setup()
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

    renderRootLauncher({ isVisible: true, transport })

    await user.click(screen.getByRole("button", { name: /open coreview fixture/i }))

    expect(await screen.findAllByText("still-frame unavailable: gemini_live_websocket_not_open")).toHaveLength(2)
    expect(screen.getByRole("button", { name: /review together/i })).toBeDisabled()
    expect(sendArtifactFrame).not.toHaveBeenCalled()
    expect(screen.queryByRole("status", { name: /looking at this artifact/i })).not.toBeInTheDocument()
  })

  it("shows frame send failure reason in the fixture modal", async () => {
    const user = userEvent.setup()
    const transport = new GeminiStillFrameTransport({
      sendArtifactFrame: vi.fn((frame) => ({
        ok: false,
        supported: true,
        providerAcceptedFrame: false,
        websocketSendAccepted: true,
        websocketReadyStateBefore: 1,
        websocketReadyStateAfter: 3,
        websocketOpenBeforeSend: true,
        websocketOpenAfterSend: false,
        framePayloadSchemaVersion: "realtimeInput.video.v1",
        frameBytes: frame.byteLength,
        frameDimensions: frame.dimensions,
        mimeType: frame.mimeType,
        frameSendLatencyMs: 7,
        estimatedVisualCost: null,
        websocketClosedAfterFrameSend: true,
        error: "frame_send_closed_gemini_websocket",
        rawFrameExcluded: true as const,
      })),
    })

    renderRootLauncher({ isVisible: true, transport })

    await user.click(screen.getByRole("button", { name: /open coreview fixture/i }))
    await user.click(await screen.findByRole("button", { name: /review together/i }))

    expect(await screen.findByText("still-frame unavailable: frame_send_closed_gemini_websocket")).toBeInTheDocument()
    expect(screen.getByText("frame_send_closed_gemini_websocket")).toBeInTheDocument()
    expect(screen.queryByRole("status", { name: /looking at this artifact/i })).not.toBeInTheDocument()
  })

  it("Stop Looking restores the root fixture control and disables future frame sends", async () => {
    const user = userEvent.setup()
    const transport = new GeminiStillFrameTransport({
      sendArtifactFrame: vi.fn((frame) => ({
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
      })),
    })

    renderRootLauncher({ isVisible: true, transport })

    await user.click(screen.getByRole("button", { name: /open coreview fixture/i }))
    await user.click(await screen.findByRole("button", { name: /review together/i }))
    expect(await screen.findByRole("status", { name: /looking at this artifact/i })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /stop looking/i }))

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /looking at this artifact/i })).not.toBeInTheDocument()
    })
    expect(screen.getByRole("button", { name: /review together/i })).toBeInTheDocument()
    await expect(transport.sendFrame?.(new Blob())).rejects.toThrow("co_review_stopped")
  })
})
