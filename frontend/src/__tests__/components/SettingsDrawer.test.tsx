import { render, screen, fireEvent, act } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
    pushMock.mockClear()
    vi.useFakeTimers()
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

  it("renders settings link and title when open", () => {
    render(<SettingsDrawer isOpen={true} onClose={() => {}} />)
    expect(screen.getByText("Settings")).toBeTruthy()
    expect(screen.getByText("Field controls")).toBeTruthy()
  })

  it("navigates to /settings on settings click", () => {
    const onClose = vi.fn()
    render(<SettingsDrawer isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByText("Settings"))
    act(() => { vi.advanceTimersByTime(240) })
    expect(onClose).toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith("/settings")
  })

  it("closes on backdrop click", () => {
    const onClose = vi.fn()
    const { container } = render(<SettingsDrawer isOpen={true} onClose={onClose} />)
    const backdrop = container.querySelector<HTMLElement>(".cosmic-modal-backdrop")
    expect(backdrop).toBeTruthy()
    if (!backdrop) {
      throw new Error('Expected settings drawer backdrop to render')
    }
    fireEvent.click(backdrop)
    act(() => { vi.advanceTimersByTime(240) })
    expect(onClose).toHaveBeenCalled()
  })

  it("closes on close button click", () => {
    const onClose = vi.fn()
    render(<SettingsDrawer isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText("Close"))
    act(() => { vi.advanceTimersByTime(240) })
    expect(onClose).toHaveBeenCalled()
  })
})
