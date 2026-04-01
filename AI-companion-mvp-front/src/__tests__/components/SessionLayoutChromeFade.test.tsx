import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act } from "@testing-library/react"
import { usePresenceStore } from "../../app/stores/presence-store"
import { useUiStore } from "../../app/stores/ui-store"
import { SessionLayout } from "../../app/components/SessionLayout"

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

// Mock EmotionAtmosphereCanvas (canvas rendering in jsdom)
vi.mock("../../app/components/EmotionAtmosphereCanvas", () => ({
  EmotionAtmosphereCanvas: () => <div data-testid="atmosphere-canvas" />,
}))

// Mock ThemeToggle
vi.mock("../../app/components/ThemeToggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}))

// Mock useFocusTrap
vi.mock("../../app/hooks/useFocusTrap", () => ({
  useFocusTrap: () => ({ containerRef: { current: null } }),
}))

// Mock haptic
vi.mock("../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

const MINIMAL_STORE = {
  sessionId: "test-session",
  threadId: "test-thread",
  userId: "test-user",
  presetType: "open" as const,
  contextMode: "life" as const,
  status: "active" as const,
  voiceMode: true,
  startedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  isActive: true,
  companionInvokesCount: 0,
}

describe("SessionLayout Chrome Fade", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.classList.add("dark")
    usePresenceStore.setState({
      status: "resting",
      isListening: false,
      isSpeaking: false,
      metaStage: "resting",
    })
    useUiStore.setState({
      chromeFaded: false,
      disableChromeFade: false,
      mode: "voice",
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.classList.remove("dark")
  })

  it("header starts at full opacity", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    const header = container.querySelector("header")
    expect(header).toBeTruthy()
    expect(header!.style.opacity).toBe("1")
  })

  it("header fades when presence enters 'listening' after 500ms", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })

    // Not yet faded
    const header = container.querySelector("header")
    expect(header!.style.opacity).toBe("1")

    // After 500ms
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(header!.style.opacity).toBe("0.08")
  })

  it("footer also fades during voice activity", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    act(() => {
      usePresenceStore.setState({ status: "speaking", isSpeaking: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const footer = container.querySelector("footer")
    expect(footer).toBeTruthy()
    expect(footer!.style.opacity).toBe("0.08")
  })

  it("header/footer restore to full opacity on resting", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    // Fade
    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const header = container.querySelector("header")
    expect(header!.style.opacity).toBe("0.08")

    // Restore
    act(() => {
      usePresenceStore.setState({ status: "resting", isListening: false })
    })

    expect(header!.style.opacity).toBe("1")
  })

  it("does not fade when kill switch is enabled", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    act(() => {
      useUiStore.setState({ disableChromeFade: true })
    })

    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const header = container.querySelector("header")
    expect(header!.style.opacity).toBe("1")
  })

  it("tap on empty space unfades chrome", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div data-testid="content">session content</div>
      </SessionLayout>
    )

    // Fade first
    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const header = container.querySelector("header")
    expect(header!.style.opacity).toBe("0.08")

    // Tap on the root div (empty space)
    const rootDiv = container.firstElementChild as HTMLElement
    act(() => {
      rootDiv.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      )
    })

    expect(header!.style.opacity).toBe("1")
  })

  it("does not fade in text mode", () => {
    const { container } = render(
      <SessionLayout store={MINIMAL_STORE}>
        <div>session content</div>
      </SessionLayout>
    )

    act(() => {
      useUiStore.setState({ mode: "text" })
    })

    act(() => {
      usePresenceStore.setState({ status: "speaking", isSpeaking: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const header = container.querySelector("header")
    expect(header!.style.opacity).toBe("1")
  })
})
