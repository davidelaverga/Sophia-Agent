import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { CallingState } from "@stream-io/video-react-sdk"
import { useStreamVoiceSession } from "../../app/hooks/useStreamVoiceSession"
import type { ContextMode, PresetType } from "../../app/lib/session-types"

// ---------------------------------------------------------------------------
// Mock: useStreamVoice (Unit 2)
// ---------------------------------------------------------------------------

let mockCallingState = CallingState.IDLE
let mockStreamError: string | null = null
let mockRemoteParticipantSessionIds: string[] = []
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
    remoteParticipantSessionIds: mockRemoteParticipantSessionIds,
    join: mockJoin,
    leave: mockLeave,
  }),
}))

// ---------------------------------------------------------------------------
// Mock: stores
// ---------------------------------------------------------------------------

const mockAddMessage = vi.fn()
const mockSetVoiceFailed = vi.fn()
let mockSessionContextMode: ContextMode = "gaming"
let mockSessionPresetType: PresetType | null = "vent"

vi.mock("../../app/stores/session-store", () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      session: {
        contextMode: mockSessionContextMode,
        presetType: mockSessionPresetType,
      },
    }),
}))

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
    mockRemoteParticipantSessionIds = []
    mockCall = null
    mockSessionContextMode = "gaming"
    mockSessionPresetType = "vent"
    callEventHandlers.clear()
    vi.useRealTimers()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: "test-key",
          token: "test-token",
          call_type: "audio_room",
          call_id: "test-call-123",
          session_id: "voice-session-123",
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
        body: JSON.stringify({
          platform: "voice",
          context_mode: "gaming",
          ritual: "vent",
        }),
      }),
    )
    // Stage should be connecting while waiting for call to be created
    expect(result.current.stage).toBe("connecting")
  })

  it("sends a null ritual for open or chat sessions", async () => {
    mockSessionContextMode = "life"
    mockSessionPresetType = "open"

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/connect",
      expect.objectContaining({
        body: JSON.stringify({
          platform: "voice",
          context_mode: "life",
          ritual: null,
        }),
      }),
    )
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

  it("startTalking transitions to error when connect returns no session_id", async () => {
    mockCall = makeCallMock()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: "test-key",
          token: "test-token",
          call_type: "audio_room",
          call_id: "test-call-123",
          session_id: null,
        }),
      text: () => Promise.resolve(""),
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(result.current.stage).toBe("error")
    expect(result.current.error).toBe("Sophia voice is unavailable right now. Try again.")
    expect(mockSetVoiceFailed).toHaveBeenCalledWith("Sophia voice is unavailable right now. Try again.")
    expect(mockJoin).not.toHaveBeenCalled()
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

  it("keeps CallingState.JOINED in connecting until Sophia joins the call", async () => {
    mockCall = makeCallMock()

    const { result, rerender } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    mockCallingState = CallingState.JOINED
    rerender()

    expect(result.current.stage).toBe("connecting")
  })

  it("transitions to listening when the expected Sophia session joins the call", async () => {
    mockCall = makeCallMock()

    const { result, rerender } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    mockCallingState = CallingState.JOINED
    rerender()
    expect(result.current.stage).toBe("connecting")

    mockRemoteParticipantSessionIds = ["voice-session-123"]
    rerender()

    expect(result.current.stage).toBe("listening")
  })

  it("does not treat Sophia custom events as startup readiness before the expected participant joins", async () => {
    mockCall = makeCallMock()

    const { result, rerender } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    mockCallingState = CallingState.JOINED
    rerender()
    expect(result.current.stage).toBe("connecting")

    act(() => {
      emitCustomEvent("sophia.user_transcript", {
        text: "hello from user",
        utterance_id: "utterance-1",
      })
    })

    expect(result.current.stage).toBe("connecting")
  })

  it("times out startup when Sophia never joins the call", async () => {
    vi.useFakeTimers()
    mockCall = makeCallMock()

    const { result, rerender } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    mockCallingState = CallingState.JOINED
    rerender()
    expect(result.current.stage).toBe("connecting")

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(result.current.stage).toBe("error")
    expect(result.current.error).toBe("Sophia voice is unavailable right now. Try again.")
    expect(mockSetVoiceFailed).toHaveBeenCalledWith("Sophia voice is unavailable right now. Try again.")
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

  it("handles sophia.user_transcript custom event", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onUserTranscript = vi.fn()
    const { result } = renderHook(() =>
      useStreamVoiceSession("user-1", { onUserTranscript }),
    )

    act(() => {
      emitCustomEvent("sophia.user_transcript", {
        text: "hello from user",
        utterance_id: "utterance-1",
      })
    })

    expect(onUserTranscript).toHaveBeenCalledWith("hello from user")
    expect(result.current.finalReply).toBe("")
    expect(mockAddMessage).not.toHaveBeenCalled()
  })

  it("ignores duplicate sophia.user_transcript events for the same utterance_id", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onUserTranscript = vi.fn()
    renderHook(() =>
      useStreamVoiceSession("user-1", { onUserTranscript }),
    )

    act(() => {
      emitCustomEvent("sophia.user_transcript", {
        text: "hello from user",
        utterance_id: "utterance-1",
      })
      emitCustomEvent("sophia.user_transcript", {
        text: "hello from user",
        utterance_id: "utterance-1",
      })
    })

    expect(onUserTranscript).toHaveBeenCalledTimes(1)
    expect(onUserTranscript).toHaveBeenCalledWith("hello from user")
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

  it("handles sophia.turn agent_ended → listening", async () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

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
