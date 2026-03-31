import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { CallingState } from "@stream-io/video-react-sdk"
import { useStreamVoiceSession } from "../../app/hooks/useStreamVoiceSession"

// ---------------------------------------------------------------------------
// Mock: useStreamVoice (Unit 2)
// ---------------------------------------------------------------------------

let mockCallingState = CallingState.IDLE
let mockStreamError: string | null = null
const mockJoin = vi.fn().mockResolvedValue(undefined)
const mockLeave = vi.fn().mockResolvedValue(undefined)
let mockCall: Record<string, unknown> | null = null
const callEventHandlers: Map<string, (e: unknown) => void> = new Map()

vi.mock("../../app/hooks/useStreamVoice", () => ({
  useStreamVoice: () => ({
    client: null,
    call: mockCall,
    callingState: mockCallingState,
    error: mockStreamError,
    join: mockJoin,
    leave: mockLeave,
  }),
}))

// ---------------------------------------------------------------------------
// Mock: stores
// ---------------------------------------------------------------------------

const mockAddMessage = vi.fn()
const mockSetVoiceFailed = vi.fn()

vi.mock("../../app/stores/voice-store", () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      addMessage: mockAddMessage,
      setVoiceFailed: mockSetVoiceFailed,
    }),
}))

vi.mock("../../app/stores/presence-store", () => ({
  usePresenceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setListening: vi.fn(),
      setSpeaking: vi.fn(),
      setMetaStage: vi.fn(),
      settleToRestingSoon: vi.fn(),
      reset: vi.fn(),
    }),
}))

// ---------------------------------------------------------------------------
// Mock: fetch (token endpoint)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallMock() {
  return {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      callEventHandlers.set(event, handler)
      return () => { callEventHandlers.delete(event) }
    },
  }
}

function emitCustomEvent(type: string, data: Record<string, unknown>) {
  const handler = callEventHandlers.get("custom")
  if (handler) {
    handler({ type: "custom", custom: { type, data } })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useStreamVoiceSession", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallingState = CallingState.IDLE
    mockStreamError = null
    mockCall = null
    callEventHandlers.clear()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: "test-key",
          token: "test-token",
          call_type: "audio_room",
          call_id: "test-call-123",
        }),
      text: () => Promise.resolve(""),
    })
  })

  it("starts with idle stage and empty replies", () => {
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    expect(result.current.stage).toBe("idle")
    expect(result.current.partialReply).toBe("")
    expect(result.current.finalReply).toBe("")
    expect(result.current.error).toBeUndefined()
  })

  it("startTalking fetches credentials and transitions to connecting", async () => {
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/connect",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    )
    // Stage should be connecting while waiting for call to be created
    expect(result.current.stage).toBe("connecting")
  })

  it("startTalking transitions to error on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service unavailable"),
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(result.current.stage).toBe("error")
    expect(result.current.error).toContain("503")
    expect(mockSetVoiceFailed).toHaveBeenCalled()
  })

  it("startTalking with no userId sets error", async () => {
    const { result } = renderHook(() => useStreamVoiceSession(undefined))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(result.current.stage).toBe("error")
    expect(result.current.error).toBe("No user ID")
  })

  it("maps CallingState.JOINING to connecting", () => {
    mockCallingState = CallingState.JOINING

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    expect(result.current.stage).toBe("connecting")
  })

  it("maps CallingState.JOINED to listening", () => {
    mockCallingState = CallingState.JOINED

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    expect(result.current.stage).toBe("listening")
  })

  it("forwards stream errors to voice-store", () => {
    mockStreamError = "Connection lost"

    renderHook(() => useStreamVoiceSession("user-1"))

    expect(mockSetVoiceFailed).toHaveBeenCalledWith("Connection lost")
  })

  it("handles sophia.transcript custom event (final)", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onAssistantResponse = vi.fn()
    const { result } = renderHook(() =>
      useStreamVoiceSession("user-1", { onAssistantResponse }),
    )

    act(() => {
      emitCustomEvent("sophia.transcript", { text: "Hello there", is_final: true })
    })

    expect(result.current.finalReply).toBe("Hello there")
    expect(result.current.partialReply).toBe("")
    expect(mockAddMessage).toHaveBeenCalledWith("Hello there")
    expect(onAssistantResponse).toHaveBeenCalledWith("Hello there")
  })

  it("handles sophia.transcript custom event (partial)", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    act(() => {
      emitCustomEvent("sophia.transcript", { text: "Hel", is_final: false })
    })

    expect(result.current.partialReply).toBe("Hel")
  })

  it("handles sophia.artifact custom event", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onArtifacts = vi.fn()
    renderHook(() => useStreamVoiceSession("user-1", { onArtifacts }))

    act(() => {
      emitCustomEvent("sophia.artifact", {
        session_goal: "Test session",
        tone_estimate: 2.5,
      })
    })

    expect(onArtifacts).toHaveBeenCalledWith({
      session_goal: "Test session",
      tone_estimate: 2.5,
    })
  })

  it("handles sophia.turn agent_started → speaking", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    act(() => {
      emitCustomEvent("sophia.turn", { phase: "agent_started" })
    })

    expect(result.current.stage).toBe("speaking")
  })

  it("handles sophia.turn user_ended → thinking", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    act(() => {
      emitCustomEvent("sophia.turn", { phase: "user_ended" })
    })

    expect(result.current.stage).toBe("thinking")
  })

  it("handles sophia.turn agent_ended → listening", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    act(() => {
      emitCustomEvent("sophia.turn", { phase: "agent_ended" })
    })

    expect(result.current.stage).toBe("listening")
  })

  it("stopTalking leaves call and resets to idle", async () => {
    mockCallingState = CallingState.JOINED
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.stopTalking()
    })

    expect(mockLeave).toHaveBeenCalled()
    expect(result.current.stage).toBe("idle")
  })

  it("bargeIn leaves call synchronously and resets to idle", () => {
    mockCallingState = CallingState.JOINED
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    act(() => {
      result.current.bargeIn()
    })

    expect(mockLeave).toHaveBeenCalled()
    expect(result.current.stage).toBe("idle")
  })

  it("resetVoiceState clears all state", async () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    // Simulate some state
    act(() => {
      emitCustomEvent("sophia.transcript", { text: "partial", is_final: false })
    })
    expect(result.current.partialReply).toBe("partial")

    await act(async () => {
      result.current.resetVoiceState()
    })

    expect(result.current.stage).toBe("idle")
    expect(result.current.partialReply).toBe("")
    expect(result.current.finalReply).toBe("")
    expect(result.current.error).toBeUndefined()
  })

  it("hasRetryableVoiceTurn always returns false", () => {
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))
    expect(result.current.hasRetryableVoiceTurn()).toBe(false)
  })

  it("retryLastVoiceTurn always resolves false", async () => {
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))
    const retried = await result.current.retryLastVoiceTurn()
    expect(retried).toBe(false)
  })
})
