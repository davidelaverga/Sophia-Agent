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

function renderControls(state: Partial<CoReviewSessionState> = {}, featureEnabled = true) {
  const onStart = vi.fn()
  const onStop = vi.fn()
  render(
    <CoReviewControls
      state={{ ...initialCoReviewState(transportStatus.kind), ...state }}
      transportStatus={transportStatus}
      onStart={onStart}
      onStop={onStop}
      featureEnabled={featureEnabled}
    />,
  )
  return { onStart, onStop }
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
})
