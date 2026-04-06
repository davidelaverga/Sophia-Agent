import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { RitualCard } from "../../app/components/dashboard/RitualCard"
import type { RitualConfig } from "../../app/components/dashboard/types"

// Minimal mock for lucide-react icons
const MockIcon = (props: Record<string, unknown>) => <svg data-testid="icon" {...props} />

vi.mock("../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

const MOCK_RITUAL: RitualConfig = {
  type: "prepare",
  icon: MockIcon as unknown as RitualConfig["icon"],
  labels: {
    gaming: { title: "Pre-game Prep", description: "Set your intention" },
    work: { title: "Pre-work Focus", description: "Get focused" },
    life: { title: "Preparation", description: "Prepare yourself" },
  },
  floatDelay: "0s",
}

describe("RitualCard compact variant", () => {
  it("renders compact pill with icon and title only", () => {
    render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={false}
        hasSelection={false}
        onSelect={() => {}}
        compact
      />
    )

    expect(screen.getByText("Pre-game Prep")).toBeTruthy()
    // Compact should NOT show description
    expect(screen.queryByText("Set your intention")).toBeNull()
  })

  it("renders full card with description when compact=false", () => {
    render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={false}
        hasSelection={false}
        onSelect={() => {}}
      />
    )

    expect(screen.getByText("Pre-game Prep")).toBeTruthy()
    expect(screen.getByText("Set your intention")).toBeTruthy()
  })

  it("compact card fires onSelect on click", () => {
    const onSelect = vi.fn()
    render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={false}
        hasSelection={false}
        onSelect={onSelect}
        compact
      />
    )

    fireEvent.click(screen.getByRole("button"))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it("compact card shows selected indicator when isSelected", () => {
    render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={true}
        hasSelection={true}
        onSelect={() => {}}
        compact
      />
    )

    // Check for selected check icon wrapper
    const button = screen.getByRole("button")
    expect(button.getAttribute("aria-pressed")).toBe("true")
  })

  it("compact card applies reduced opacity when hasSelection but not selected", () => {
    const { container } = render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={false}
        hasSelection={true}
        onSelect={() => {}}
        compact
      />
    )

    // The outer wrapper should have opacity-60
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain("opacity-60")
  })

  it("compact card shows suggested indicator", () => {
    render(
      <RitualCard
        ritual={MOCK_RITUAL}
        context="gaming"
        isSelected={false}
        hasSelection={false}
        onSelect={() => {}}
        compact
        isSuggested
      />
    )

    const button = screen.getByRole("button")
    expect(button.getAttribute("data-onboarding")).toBe("ritual-card-suggested")
  })
})
