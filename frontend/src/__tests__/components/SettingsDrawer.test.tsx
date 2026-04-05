import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SettingsDrawer } from "../../app/components/dashboard/SettingsDrawer"

const pushMock = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

vi.mock("../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

vi.mock("../../app/components/ThemeToggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}))

describe("SettingsDrawer", () => {
  beforeEach(() => {
    pushMock.mockClear()
  })

  it("does not render when closed", () => {
    const { container } = render(
      <SettingsDrawer isOpen={false} onClose={() => {}} />
    )
    expect(container.innerHTML).toBe("")
  })

  it("renders settings and history links when open", () => {
    render(
      <SettingsDrawer isOpen={true} onClose={() => {}} />
    )

    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("History")).toBeTruthy()
    expect(screen.getByTestId("theme-toggle")).toBeTruthy()
  })

  it("navigates to /settings on settings click", () => {
    const onClose = vi.fn()
    render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    fireEvent.click(screen.getByText("Settings"))
    expect(onClose).toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith("/settings")
  })

  it("calls onShowHistory on history click", () => {
    const onClose = vi.fn()
    const onShowHistory = vi.fn()
    render(
      <SettingsDrawer isOpen={true} onClose={onClose} onShowHistory={onShowHistory} />
    )

    fireEvent.click(screen.getByText("History"))
    expect(onClose).toHaveBeenCalled()
    expect(onShowHistory).toHaveBeenCalled()
  })

  it("closes on backdrop click", () => {
    const onClose = vi.fn()
    const { container } = render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    // Click the backdrop (first child of the fixed overlay)
    const backdrop = container.querySelector(".bg-black\\/40")
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalled()
  })

  it("closes on close button click", () => {
    const onClose = vi.fn()
    render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    fireEvent.click(screen.getByLabelText("Close"))
    expect(onClose).toHaveBeenCalled()
  })
})
