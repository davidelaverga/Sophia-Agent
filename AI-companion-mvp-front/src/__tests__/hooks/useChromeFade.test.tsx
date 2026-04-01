import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChromeFade } from "../../app/hooks/useChromeFade"
import { usePresenceStore } from "../../app/stores/presence-store"
import { useUiStore } from "../../app/stores/ui-store"

describe("useChromeFade", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Reset stores
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
    // Default to dark mode
    document.documentElement.classList.add("dark")
  })

  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.classList.remove("dark")
  })

  it("starts with chromeFaded=false and chromeOpacity=1.0", () => {
    const { result } = renderHook(() => useChromeFade())
    expect(result.current.chromeFaded).toBe(false)
    expect(result.current.chromeOpacity).toBe(1.0)
  })

  it("fades after 500ms when presence enters 'listening'", () => {
    const { result } = renderHook(() => useChromeFade())

    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })

    // Not yet faded
    expect(result.current.chromeFaded).toBe(false)

    // Advance 500ms
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(result.current.chromeFaded).toBe(true)
    expect(result.current.chromeOpacity).toBe(0.08) // dark mode
  })

  it("unfades immediately when presence returns to 'resting'", () => {
    const { result } = renderHook(() => useChromeFade())

    // Fade first
    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.chromeFaded).toBe(true)

    // Return to resting
    act(() => {
      usePresenceStore.setState({ status: "resting", isListening: false })
    })

    expect(result.current.chromeFaded).toBe(false)
    expect(result.current.chromeOpacity).toBe(1.0)
  })

  it("does not flicker on rapid listening→resting→listening within 500ms", () => {
    const { result } = renderHook(() => useChromeFade())

    // Start listening
    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })

    // 200ms later, go resting briefly
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      usePresenceStore.setState({ status: "resting", isListening: false })
    })
    expect(result.current.chromeFaded).toBe(false)

    // Then back to listening
    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })

    // 500ms from this new start → should fade
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.chromeFaded).toBe(true)
  })

  it("never fades when disableChromeFade kill switch is true", () => {
    const { result } = renderHook(() => useChromeFade())

    act(() => {
      useUiStore.setState({ disableChromeFade: true })
    })

    act(() => {
      usePresenceStore.setState({ status: "listening", isListening: true })
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current.chromeFaded).toBe(false)
    expect(result.current.chromeOpacity).toBe(1.0)
  })

  it("never fades in text mode", () => {
    const { result } = renderHook(() => useChromeFade())

    act(() => {
      useUiStore.setState({ mode: "text" })
    })

    act(() => {
      usePresenceStore.setState({ status: "speaking", isSpeaking: true })
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current.chromeFaded).toBe(false)
    expect(result.current.chromeOpacity).toBe(1.0)
  })

  it("returns light theme opacity when not in dark mode", () => {
    document.documentElement.classList.remove("dark")
    const { result } = renderHook(() => useChromeFade())

    act(() => {
      usePresenceStore.setState({ status: "thinking", metaStage: "thinking" })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(result.current.chromeFaded).toBe(true)
    expect(result.current.chromeOpacity).toBe(0.12) // light mode
  })

  it("fades for all active presence states", () => {
    for (const status of ["listening", "thinking", "reflecting", "speaking"] as const) {
      // Reset
      act(() => {
        useUiStore.setState({ chromeFaded: false })
        usePresenceStore.setState({ status: "resting", isListening: false, isSpeaking: false, metaStage: "resting" })
      })

      const { result } = renderHook(() => useChromeFade())

      act(() => {
        usePresenceStore.setState({ status })
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(result.current.chromeFaded).toBe(true)
    }
  })
})
