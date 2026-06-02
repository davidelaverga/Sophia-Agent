import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ArtifactStage } from "../../../app/components/session/ArtifactStage"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../../app/lib/co-review-transport"

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

function renderStage({
  state = {},
  exactTextAvailable = true,
  canStartReview = true,
  reviewEnabled = true,
  transportStatus = supportedTransportStatus,
}: {
  state?: Partial<CoReviewSessionState>
  exactTextAvailable?: boolean
  canStartReview?: boolean
  reviewEnabled?: boolean
  transportStatus?: typeof supportedTransportStatus
} = {}) {
  const onStartReview = vi.fn()
  const onStopReview = vi.fn()

  const view = render(
    <ArtifactStage
      builderArtifact={builderArtifact}
      threadId="thread-1"
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
    />,
  )

  return { ...view, onStartReview, onStopReview }
}

describe("ArtifactStage", () => {
  it("renders a native artifact shell with open and download actions", () => {
    renderStage()

    expect(screen.getByRole("region", { name: /generated artifact/i })).toBeInTheDocument()
    expect(screen.getAllByText("Launch brief overview")).toHaveLength(2)
    expect(screen.getByText("Document")).toBeInTheDocument()
    expect(screen.getByText("launch-brief.pdf")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief overview")).toHaveAttribute(
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
})
