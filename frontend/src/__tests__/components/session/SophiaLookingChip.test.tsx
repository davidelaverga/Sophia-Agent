import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { SophiaLookingChip } from "../../../app/components/session/SophiaLookingChip"
import { initialCoReviewState } from "../../../app/lib/co-review-transport"

describe("SophiaLookingChip", () => {
  it("uses Sophia purple as the active looking treatment", () => {
    render(
      <SophiaLookingChip
        frameConfirmed
        state={{
          ...initialCoReviewState("test"),
          state: "co_review_live",
          visualInputStatus: "live",
        }}
      />,
    )

    const chip = screen.getByRole("status", { name: "Sophia is looking at this artifact" })
    expect(chip.className).toContain("sophia-purple")
    expect(chip.className).not.toContain("cosmic-teal")
  })

  it("shows preparing view with the same restrained chip shape", () => {
    render(
      <SophiaLookingChip
        state={{
          ...initialCoReviewState("test"),
          state: "co_review_starting",
        }}
      />,
    )

    const chip = screen.getByRole("status", { name: "Preparing view" })
    expect(chip).toBeInTheDocument()
    expect(chip.className).toContain("sophia-purple")
  })
})
