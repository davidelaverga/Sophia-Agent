import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ArtifactReviewStatus } from "../../../app/components/session/ArtifactReviewStatus"
import {
  AudioWebSocketUnsupportedTransport,
  initialCoReviewState,
} from "../../../app/lib/co-review-transport"

const unsupportedTransportStatus = new AudioWebSocketUnsupportedTransport().status()
const supportedTransportStatus = {
  ...unsupportedTransportStatus,
  visualTransportSupported: true,
  toolsSupportedInCoReview: true,
  stillFramesSupported: true,
  statusText: "ready",
}

describe("ArtifactReviewStatus", () => {
  it("uses purple for Sophia attention and teal for secondary confirmations", () => {
    render(
      <ArtifactReviewStatus
        state={{
          ...initialCoReviewState(supportedTransportStatus.kind),
          state: "co_review_live",
          visualInputStatus: "live",
          videoOrFrameMode: "still_frame",
          frameSentCount: 1,
          exactTextAvailable: true,
        }}
        transportStatus={supportedTransportStatus}
        exactTextAvailable
      />,
    )

    const lookingChip = screen.getByRole("status", { name: "Sophia is looking at this artifact" })
    const frameSent = screen.getByText("Frame sent").parentElement
    const exactText = screen.getByText("Exact text available").parentElement

    expect(lookingChip.className).toContain("sophia-purple")
    expect(frameSent?.className).toContain("cosmic-teal")
    expect(exactText?.className).toContain("cosmic-teal")
  })

  it("keeps voice-start and inactive visual review copy user-facing", () => {
    const { rerender, container } = render(
      <ArtifactReviewStatus
        state={initialCoReviewState(supportedTransportStatus.kind)}
        transportStatus={{
          ...supportedTransportStatus,
          visualTransportSupported: false,
          statusText: "websocket transport unavailable",
        }}
        exactTextAvailable
        canStart={false}
        visualReviewRequiresVoice
      />,
    )

    expect(screen.getByText("Start voice to review visually")).toBeInTheDocument()
    expect(container.textContent?.toLowerCase()).not.toMatch(/coreview|gemini|transport|websocket|liveframes|fixture|direct video/)

    rerender(
      <ArtifactReviewStatus
        state={initialCoReviewState(supportedTransportStatus.kind)}
        transportStatus={supportedTransportStatus}
        exactTextAvailable
        canStart={false}
        visualSourceUnavailableReason="capture_target_missing"
      />,
    )

    expect(screen.getByText("Visual review not active")).toBeInTheDocument()
  })
})
