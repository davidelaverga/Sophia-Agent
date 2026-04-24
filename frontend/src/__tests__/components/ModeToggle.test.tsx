import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { ModeToggle } from "../../app/components/ModeToggle"

// --- Mocks -----------------------------------------------------------------

const mockSetMode = vi.fn()
const mockSetManualOverride = vi.fn()
let mockMode = "voice" as "voice" | "text"

vi.mock("../../app/stores/ui-store", () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ mode: mockMode, setMode: mockSetMode, setManualOverride: mockSetManualOverride }),
}))

let mockCanSwitchToVoice = { canSwitch: true, message: undefined as string | undefined }
let mockCanSwitchToChat = { canSwitch: true, message: undefined as string | undefined }

vi.mock("../../app/hooks/useModeSwitch", () => ({
  useModeSwitch: () => ({
    canSwitchToVoice: mockCanSwitchToVoice,
    canSwitchToChat: mockCanSwitchToChat,
  }),
}))

// --- Tests -----------------------------------------------------------------

describe("ModeToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMode = "voice"
    mockCanSwitchToVoice = { canSwitch: true, message: undefined }
    mockCanSwitchToChat = { canSwitch: true, message: undefined }
  })

  it("renders voice and text tabs", () => {
    render(<ModeToggle />)
    expect(screen.getByRole("tab", { name: /voice/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /text/i })).toBeInTheDocument()
  })

  it("highlights the active tab", () => {
    render(<ModeToggle />)
    const voiceTab = screen.getByRole("tab", { name: /voice/i })
    expect(voiceTab).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /text/i })).toHaveAttribute("aria-selected", "false")
  })

  it("calls setMode when a different tab is clicked", async () => {
    const user = userEvent.setup()
    render(<ModeToggle />)
    await user.click(screen.getByRole("tab", { name: /text/i }))
    expect(mockSetMode).toHaveBeenCalledWith("text")
    expect(mockSetManualOverride).toHaveBeenCalledWith(true)
  })

  it("does not re-trigger when clicking the active tab", async () => {
    const user = userEvent.setup()
    render(<ModeToggle />)
    await user.click(screen.getByRole("tab", { name: /voice/i }))
    expect(mockSetMode).not.toHaveBeenCalled()
  })

  it("disables voice tab when canSwitchToVoice is false", async () => {
    mockMode = "text"
    mockCanSwitchToVoice = { canSwitch: false, message: "Voice is busy" }
    const user = userEvent.setup()
    render(<ModeToggle />)
    const voiceTab = screen.getByRole("tab", { name: /voice/i })
    expect(voiceTab).toBeDisabled()
    await user.click(voiceTab)
    expect(mockSetMode).not.toHaveBeenCalled()
  })

  it("shows tooltip on disabled voice tab", () => {
    mockMode = "text"
    mockCanSwitchToVoice = { canSwitch: false, message: "Voice is busy" }
    render(<ModeToggle />)
    expect(screen.getByRole("tab", { name: /voice/i })).toHaveAttribute("title", "Voice is busy")
  })
})
