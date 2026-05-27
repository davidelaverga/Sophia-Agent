import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { CoReviewControls } from "../../app/components/session/CoReviewControls"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
  type CoReviewSessionState,
} from "../../app/lib/co-review-transport"

const transportStatus = new AudioWebSocketUnsupportedTransport().status()
const liveStillFrameTransportStatus = {
  ...transportStatus,
  visualTransportSupported: true,
  toolsSupportedInCoReview: true,
  stillFramesSupported: true,
  statusText: "still-frame mode",
}

function renderControls(
  state: Partial<CoReviewSessionState> = {},
  featureEnabled = true,
  options: {
    canRefresh?: boolean
    transportStatusOverride?: typeof transportStatus
  } = {},
) {
  const onStart = vi.fn()
  const onStop = vi.fn()
  const onRefresh = vi.fn()
  const currentTransportStatus = options.transportStatusOverride ?? transportStatus
  render(
    <CoReviewControls
      state={{ ...initialCoReviewState(currentTransportStatus.kind), ...state }}
      transportStatus={currentTransportStatus}
      onStart={onStart}
      onStop={onStop}
      onRefresh={onRefresh}
      canRefresh={options.canRefresh ?? false}
      featureEnabled={featureEnabled}
    />,
  )
  return { onStart, onStop, onRefresh }
}

describe("CoReviewControls", () => {
  it("hides the co-review entry when the feature flag is off", () => {
    renderControls({}, false)

    expect(screen.queryByRole("button", { name: /review together/i })).not.toBeInTheDocument()
  })

  it("shows Review Together with unsupported transport status before entry", async () => {
    const user = userEvent.setup()
    const { onStart } = renderControls()

    await user.click(screen.getByRole("button", { name: /review together/i }))

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(screen.getByText("continuous unsupported")).toBeInTheDocument()
  })

  it("shows the looking indicator only during live co-review", () => {
    renderControls({ state: "co_review_starting" })
    expect(screen.queryByRole("status", { name: /looking at this artifact/i })).not.toBeInTheDocument()

    renderControls({
      state: "co_review_live",
      visualInputStatus: "live",
      videoOrFrameMode: "still_frame",
    })
    expect(screen.getByRole("status", { name: /looking at this artifact/i })).toBeInTheDocument()
    expect(screen.getByText("still-frame mode")).toBeInTheDocument()
  })

  it("keeps Refresh View hidden until co-review is live", () => {
    renderControls({ state: "normal_voice" })

    expect(screen.queryByRole("button", { name: /refresh view/i })).not.toBeInTheDocument()
  })

  it("shows Refresh View while live and dispatches through the provided handler", async () => {
    const user = userEvent.setup()
    const { onRefresh } = renderControls(
      {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
      },
      true,
      {
        canRefresh: true,
        transportStatusOverride: liveStillFrameTransportStatus,
      },
    )

    await user.click(screen.getByRole("button", { name: /refresh view/i }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("disables Refresh View when the websocket is not open", () => {
    renderControls(
      {
        state: "co_review_live",
        visualInputStatus: "live",
        videoOrFrameMode: "still_frame",
      },
      true,
      {
        canRefresh: true,
        transportStatusOverride: {
          ...liveStillFrameTransportStatus,
          visualTransportSupported: false,
          statusText: "still-frame unavailable: gemini_live_websocket_not_open",
        },
      },
    )

    expect(screen.getByRole("button", { name: /refresh view/i })).toBeDisabled()
  })

  it("shows safe Refresh View status text", () => {
    renderControls(
      {
        state: "co_review_live",
        visualInputStatus: "live",
        refreshFrameInProgress: true,
        refreshFrameResult: "refreshing",
      },
      true,
      {
        transportStatusOverride: liveStillFrameTransportStatus,
      },
    )
    expect(screen.getByText("Refreshing…")).toBeInTheDocument()

    renderControls(
      {
        state: "co_review_live",
        visualInputStatus: "live",
        refreshFrameResult: "success",
      },
      true,
      {
        transportStatusOverride: liveStillFrameTransportStatus,
      },
    )
    expect(screen.getByText("Last refreshed just now")).toBeInTheDocument()

    renderControls({
      state: "co_review_error",
      refreshFrameResult: "error",
      refreshErrorSafeReason: "frame_send_closed_gemini_websocket",
    })
    expect(screen.getByText("Refresh failed: frame_send_closed_gemini_websocket")).toBeInTheDocument()
  })

  it("Stop Looking exits through the provided handler", async () => {
    const user = userEvent.setup()
    const { onStop } = renderControls({ state: "co_review_live", visualInputStatus: "live" })

    await user.click(screen.getByRole("button", { name: /stop looking/i }))

    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("reports a visible safe reason for transport errors", () => {
    renderControls({ state: "co_review_error", error: "unsupported" })

    expect(screen.getByText("still-frame unavailable: unsupported")).toBeInTheDocument()
  })

  it("surfaces guarded DOM-only failures verbatim", () => {
    renderControls({ state: "co_review_error", error: "dom_artifact_requires_safe_renderer" })

    expect(screen.getByText("still-frame unavailable: dom_artifact_requires_safe_renderer")).toBeInTheDocument()
  })
})
