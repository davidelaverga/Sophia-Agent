import { act, render, screen, fireEvent } from "@testing-library/react"
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

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

describe("SettingsDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pushMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not render when closed", () => {
    const { container } = render(
      <SettingsDrawer isOpen={false} onClose={() => {}} />
    )
    expect(container.innerHTML).toBe("")
  })

  it("renders the current settings action when open", () => {
    render(
      <SettingsDrawer isOpen={true} onClose={() => {}} />
    )

    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("Voice, account, memory, and conversation preferences.")).toBeTruthy()
    expect(screen.queryByText("History")).toBeNull()
  })

  it("navigates to /settings on settings click", () => {
    const onClose = vi.fn()
    render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    fireEvent.click(screen.getByText("Settings"))
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(onClose).toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith("/settings")
  })

  it("closes on backdrop click", () => {
    const onClose = vi.fn()
    const { container } = render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    // Click the backdrop (first child of the fixed overlay)
    const backdrop = container.querySelector(".cosmic-modal-backdrop")
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop as HTMLElement)
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(onClose).toHaveBeenCalled()
  })

  it("closes on close button click", () => {
    const onClose = vi.fn()
    render(
      <SettingsDrawer isOpen={true} onClose={onClose} />
    )

    fireEvent.click(screen.getByLabelText("Close"))
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(onClose).toHaveBeenCalled()
  })
})
