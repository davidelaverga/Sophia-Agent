import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ReviewWithSophiaButton } from "../../../app/components/session/ReviewWithSophiaButton"
import { initialCoReviewState } from "../../../app/lib/co-review-transport"

describe("ReviewWithSophiaButton", () => {
  it("starts artifact review from the primary CTA", async () => {
    const user = userEvent.setup()
    const onStart = vi.fn()

    render(
      <ReviewWithSophiaButton
        state={initialCoReviewState("test")}
        onStart={onStart}
        onStop={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Review with Sophia" }))

    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("routes to voice start when visual review requires voice", async () => {
    const user = userEvent.setup()
    const onStartVoiceReview = vi.fn()
    const onStart = vi.fn()

    render(
      <ReviewWithSophiaButton
        state={initialCoReviewState("test")}
        canStart={false}
        startVoiceRequired
        onStartVoiceReview={onStartVoiceReview}
        onStart={onStart}
        onStop={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Start voice & review" }))

    expect(onStartVoiceReview).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  it("stops looking when review is active", async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()

    render(
      <ReviewWithSophiaButton
        state={{
          ...initialCoReviewState("test"),
          state: "co_review_live",
        }}
        onStart={vi.fn()}
        onStop={onStop}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Stop Looking" }))

    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
