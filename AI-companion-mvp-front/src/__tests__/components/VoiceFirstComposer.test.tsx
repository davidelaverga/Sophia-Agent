import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { VoiceFirstComposer } from "../../app/components/session/VoiceFirstComposer"

// --- Mocks -----------------------------------------------------------------

vi.mock("../../app/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

vi.mock("../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

vi.mock("../../app/hooks/useLongPress", () => ({
  useLongPress: () => ({
    isLongPressing: false,
    longPressHandlers: {
      onPointerDown: vi.fn(),
      onPointerUp: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerCancel: vi.fn(),
    },
  }),
}))

// --- Helpers ---------------------------------------------------------------

function renderComposer(overrides: Partial<Parameters<typeof VoiceFirstComposer>[0]> = {}) {
  const inputRef = createRef<HTMLTextAreaElement>()
  const defaults = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onMicClick: vi.fn(),
    placeholder: "Type a message…",
    inputRef,
  }
  const props = { ...defaults, ...overrides, inputRef: overrides.inputRef ?? inputRef }
  const result = render(<VoiceFirstComposer {...props} />)
  return { ...result, props }
}

// --- Tests -----------------------------------------------------------------

describe("VoiceFirstComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("default mode (textOnly=false)", () => {
    it("renders mic button", () => {
      renderComposer()
      expect(screen.getByRole("button", { name: /tap to speak/i })).toBeInTheDocument()
    })

    it("renders 'or type instead...' toggle", () => {
      renderComposer()
      expect(screen.getByText(/or type instead/i)).toBeInTheDocument()
    })

    it("shows voice status text by default", () => {
      renderComposer()
      expect(screen.getByText(/Sophia — Ready/i)).toBeInTheDocument()
    })

    it("shows 'Sophia is thinking...' when isTyping", () => {
      renderComposer({ isTyping: true })
      expect(screen.getByText(/Sophia is thinking/i)).toBeInTheDocument()
    })

    it("expands text area when toggle clicked", async () => {
      const user = userEvent.setup()
      renderComposer()
      await user.click(screen.getByText(/or type instead/i))
      expect(screen.getByRole("textbox")).toBeInTheDocument()
      expect(screen.getByLabelText(/close typing/i)).toBeInTheDocument()
    })
  })

  describe("text-only mode (textOnly=true)", () => {
    it("hides mic button", () => {
      renderComposer({ textOnly: true })
      expect(screen.queryByRole("button", { name: /tap to speak/i })).not.toBeInTheDocument()
    })

    it("auto-expands text area", () => {
      renderComposer({ textOnly: true })
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })

    it("hides the 'or type instead...' toggle", () => {
      renderComposer({ textOnly: true })
      expect(screen.queryByText(/or type instead/i)).not.toBeInTheDocument()
    })

    it("hides close (X) button", () => {
      renderComposer({ textOnly: true })
      expect(screen.queryByLabelText(/close typing/i)).not.toBeInTheDocument()
    })

    it("hides collapse hint", () => {
      renderComposer({ textOnly: true })
      expect(screen.queryByText(/swipe down/i)).not.toBeInTheDocument()
    })

    it("shows 'Sophia is typing...' when isTyping", () => {
      renderComposer({ textOnly: true, isTyping: true })
      expect(screen.getByText(/Sophia is typing/i)).toBeInTheDocument()
    })

    it("shows 'Sophia — Ready' when not typing", () => {
      renderComposer({ textOnly: true })
      expect(screen.getByText(/Sophia — Ready/i)).toBeInTheDocument()
    })

    it("does not collapse on Enter submit", async () => {
      const user = userEvent.setup()
      const onSubmit = vi.fn()
      renderComposer({ textOnly: true, value: "hello", onSubmit })
      const textarea = screen.getByRole("textbox")
      await user.click(textarea)
      await user.keyboard("{Enter}")
      expect(onSubmit).toHaveBeenCalled()
      // textarea should still be visible (not collapsed)
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })

    it("does not collapse on Escape", async () => {
      const user = userEvent.setup()
      renderComposer({ textOnly: true })
      const textarea = screen.getByRole("textbox")
      await user.click(textarea)
      await user.keyboard("{Escape}")
      expect(screen.getByRole("textbox")).toBeInTheDocument()
    })
  })
})
