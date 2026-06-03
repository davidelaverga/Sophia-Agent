import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { CoReviewControls } from "../../app/components/session/CoReviewControls"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../app/lib/co-review-transport"

const unsupportedTransportStatus = new AudioWebSocketUnsupportedTransport().status()
const liveStillFrameTransportStatus = {
  ...unsupportedTransportStatus,
  visualTransportSupported: true,
  toolsSupportedInCoReview: true,
  stillFramesSupported: true,
  statusText: "still-frame mode",
}

function renderControls(
  state: Partial<CoReviewSessionState> = {},
  featureEnabled = true,
  transportStatusOverride = unsupportedTransportStatus,
) {
  const onStart = vi.fn()
  const onStop = vi.fn()
  render(
    <CoReviewControls
      state={{ ...initialCoReviewState(transportStatusOverride.kind), ...state }}
      transportStatus={transportStatusOverride}
      onStart={onStart}
      onStop={onStop}
      canStart={transportStatusOverride.visualTransportSupported && transportStatusOverride.stillFramesSupported}
      featureEnabled={featureEnabled}
    />,
  )
  return { onStart, onStop }
}

describe("CoReviewControls", () => {
  it("hides the co-review entry when the feature flag is off", () => {
    renderControls({}, false)

    expect(screen.queryByRole("button", { name: /review with sophia/i })).not.toBeInTheDocument()
  })

  it("shows Review with Sophia and Not looking before entry", async () => {
    const user = userEvent.setup()
    const { onStart } = renderControls({}, true, liveStillFrameTransportStatus)

    expect(screen.getByRole("status", { name: /not looking/i })).toBeInTheDocument()
    expect(screen.getByText("Ready for review")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /review with sophia/i }))

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("shows Frame unavailable for unsupported still-frame transport", () => {
    renderControls()

    expect(screen.getByText("Frame unavailable")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /review with sophia/i })).toBeDisabled()
  })

  it("shows Preparing view while the review frame is starting", () => {
    renderControls(
      {
        state: "co_review_starting",
        visualInputStatus: "connecting",
      },
      true,
      liveStillFrameTransportStatus,
    )

    expect(screen.getByText("Preparing view")).toBeInTheDocument()
  })

  it("shows Sophia is looking at this artifact, Frame sent, Exact text available, and visual staleness after a still frame is sent", () => {
    renderControls(
      {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
        frameSentCount: 1,
        initialFrameSent: true,
        exactTextAvailable: true,
        visualFresh: true,
        visualFreshForTurn: true,
      },
      true,
      liveStillFrameTransportStatus,
    )

    expect(screen.getByRole("status", { name: /sophia is looking/i })).toBeInTheDocument()
    expect(screen.getByText("Frame sent")).toBeInTheDocument()
    expect(screen.getByText("Exact text available")).toBeInTheDocument()
    expect(screen.getByText("Visual may be stale")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /refresh view/i })).not.toBeInTheDocument()
  })

  it("Stop Looking exits through the provided handler", async () => {
    const user = userEvent.setup()
    const { onStop } = renderControls(
      { state: "co_review_live", visualInputStatus: "live" },
      true,
      liveStillFrameTransportStatus,
    )

    await user.click(screen.getByRole("button", { name: /stop looking/i }))

    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("reports a visible safe reason for transport errors", () => {
    renderControls({
      state: "co_review_error",
      error: "frame_send_closed_gemini_websocket",
      frameSendFailureCount: 1,
    })

    expect(screen.getByText("Frame unavailable")).toBeInTheDocument()
    expect(screen.getByText("View could not be prepared")).toBeInTheDocument()
    expect(screen.queryByText(/websocket|transport|gemini|coreview|liveframes|fixture|direct video|provider ack/i)).not.toBeInTheDocument()
  })

  it("surfaces a ready state before review when the frame path is available", () => {
    renderControls({}, true, liveStillFrameTransportStatus)

    expect(screen.getByText("Ready for review")).toBeInTheDocument()
  })
})
