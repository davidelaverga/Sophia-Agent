import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { VoiceArtifactStage } from "../../../app/components/session/VoiceArtifactStage"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../../app/lib/co-review-transport"
import type { BuilderArtifactV1 } from "../../../app/types/builder-artifact"

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

const markdownBuilderArtifact = {
  artifactTitle: "Voice launch brief",
  artifactType: "document",
  artifactPath: "mnt/user-data/outputs/voice-launch-brief.md",
  supportingFiles: [],
  decisionsMade: [],
  companionSummary: "A markdown artifact for voice review.",
  userNextAction: "Review it with Sophia.",
} satisfies BuilderArtifactV1

function renderVoiceStage({
  state = {},
  markdown = "# Voice Launch Brief\n\nThis document is ready for review.",
}: {
  state?: Partial<CoReviewSessionState>
  markdown?: string
} = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(markdown, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    }),
  )

  const onStartReview = vi.fn()
  const onStopReview = vi.fn()

  const view = render(
    <div data-testid="voice-shell" className="h-[720px] min-h-0 overflow-hidden">
      <VoiceArtifactStage
        builderArtifact={markdownBuilderArtifact}
        builderArtifactLibrary={[{
          path: "mnt/user-data/outputs/voice-launch-brief.md",
          name: "voice-launch-brief.md",
          mimeType: "text/markdown",
        }]}
        threadId="thread-1"
        sessionId="session-1"
        normalSessionId="normal-1"
        reviewState={{
          ...initialCoReviewState(supportedTransportStatus.kind),
          ...state,
        }}
        transportStatus={supportedTransportStatus}
        exactTextAvailable
        canStartReview
        reviewEnabled
        onStartReview={onStartReview}
        onStopReview={onStopReview}
      />
    </div>,
  )

  return { ...view, onStartReview, onStopReview }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("VoiceArtifactStage", () => {
  it("renders a bounded voice artifact canvas with visible chips and actions", async () => {
    renderVoiceStage({
      state: {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
        exactTextAvailable: true,
      },
    })

    expect(await screen.findByRole("heading", { name: "Voice Launch Brief" })).toBeInTheDocument()

    const voiceStage = screen.getByTestId("voice-artifact-stage")
    const artifactRegion = within(voiceStage).getByRole("region", { name: /generated artifact/i })

    expect(within(voiceStage).getByTestId("artifact-review-room")).toBe(artifactRegion)
    expect(voiceStage.className).toContain("h-full")
    expect(voiceStage.className).toContain("min-h-0")
    expect(voiceStage.className).toContain("overflow-hidden")
    expect(artifactRegion.className).toContain("h-full")
    expect(artifactRegion.className).toContain("min-h-0")
    expect(artifactRegion.className).toContain("flex-1")
    expect(artifactRegion).toHaveAttribute("data-review-state", "active")
    expect(within(artifactRegion).getByTestId("artifact-review-chrome")).toBeInTheDocument()
    expect(within(voiceStage).getByRole("status", { name: "Sophia is looking at this artifact" })).toBeInTheDocument()
    expect(within(voiceStage).getByText("Frame sent")).toBeInTheDocument()
    expect(within(voiceStage).getByText("Exact text available")).toBeInTheDocument()
    expect(within(voiceStage).getAllByText("Page 1 of 1")).toHaveLength(1)
    expect(within(voiceStage).getByTestId("artifact-toolbar")).toBeInTheDocument()
    expect(within(voiceStage).queryByLabelText("Highlight")).not.toBeInTheDocument()
    expect(within(voiceStage).getByLabelText("Open Voice launch brief in new tab")).toBeInTheDocument()
    expect(within(voiceStage).getByLabelText("Download original Voice launch brief")).toBeInTheDocument()
    expect(within(voiceStage).getByRole("button", { name: /stop looking/i })).toBeInTheDocument()
  })

  it("keeps long markdown in the internal canvas scroll region with toolbar outside it", async () => {
    const longMarkdown = [
      "# Voice Launch Brief",
      "",
      ...Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}: detail stays inside the voice artifact viewport.`),
    ].join("\n\n")

    renderVoiceStage({ markdown: longMarkdown })

    expect(await screen.findByRole("heading", { name: "Voice Launch Brief" })).toBeInTheDocument()

    const voiceStage = screen.getByTestId("voice-artifact-stage")
    const viewport = within(voiceStage).getByTestId("artifact-canvas-viewport")
    const canvasBed = within(voiceStage).getByTestId("artifact-canvas-bed")
    const scrollArea = within(voiceStage).getByTestId("artifact-canvas-scroll-area")
    const toolbar = within(voiceStage).getByTestId("artifact-toolbar")
    const preview = within(voiceStage).getByLabelText("Artifact document preview")

    expect(viewport.className).toContain("flex-1")
    expect(viewport.className).toContain("max-h-full")
    expect(canvasBed.className).toContain("flex-1")
    expect(scrollArea.className).toContain("overflow-y-auto")
    expect(scrollArea.className).toContain("overscroll-contain")
    expect(preview.className).toContain("min-h-full")
    expect(scrollArea).not.toContainElement(toolbar)
    expect(within(voiceStage).getAllByText("Page 1 of 1")).toHaveLength(1)
    expect(within(voiceStage).getByLabelText("Open Voice launch brief in new tab")).toBeInTheDocument()
    expect(within(voiceStage).getByLabelText("Download original Voice launch brief")).toBeInTheDocument()
    expect(voiceStage.textContent?.toLowerCase()).not.toMatch(
      /coreview|gemini|websocket|transport|liveframes|fixture|direct video|provider ack/,
    )
  })
})
