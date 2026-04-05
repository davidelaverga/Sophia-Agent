import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { CallingState } from "@stream-io/video-react-sdk"
import { useStreamVoice, type StreamVoiceCredentials } from "../../app/hooks/useStreamVoice"

// --- Stream SDK mocks ---

const mockLeave = vi.fn().mockResolvedValue(undefined)
const mockJoin = vi.fn().mockResolvedValue(undefined)
const mockCameraDisable = vi.fn().mockResolvedValue(undefined)
const mockMicrophoneEnable = vi.fn().mockResolvedValue(undefined)
const mockDisconnectUser = vi.fn().mockResolvedValue(undefined)

let callingStateCallback: ((state: CallingState) => void) | null = null
let remoteParticipantsCallbacks: Array<
  (participants: Array<{ sessionId: string }>) => void
> = []

const mockCall = {
  join: mockJoin,
  leave: mockLeave,
  camera: { disable: mockCameraDisable },
  microphone: { enable: mockMicrophoneEnable },
  bindAudioElement: vi.fn(() => vi.fn()),
  state: {
    callingState$: {
      subscribe: vi.fn((cb: (state: CallingState) => void) => {
        callingStateCallback = cb
        return { unsubscribe: vi.fn() }
      }),
    },
    remoteParticipants$: {
      subscribe: vi.fn(
        (cb: (participants: Array<{ sessionId: string }>) => void) => {
          remoteParticipantsCallbacks.push(cb)
          return { unsubscribe: vi.fn() }
        }
      ),
    },
  },
}

vi.mock("@stream-io/video-react-sdk", async () => {
  const actual = await vi.importActual("@stream-io/video-react-sdk")
  return {
    ...actual,
    StreamVideoClient: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue(mockCall),
      disconnectUser: mockDisconnectUser,
    })),
  }
})

const validCredentials: StreamVoiceCredentials = {
  apiKey: "test-key",
  token: "test-token",
  callType: "default",
  callId: "test-call-123",
}

describe("useStreamVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callingStateCallback = null
    remoteParticipantsCallbacks = []
  })

  it("starts in IDLE state with no client when credentials are null", () => {
    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: null })
    )

    expect(result.current.callingState).toBe(CallingState.IDLE)
    expect(result.current.client).toBeNull()
    expect(result.current.call).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.remoteParticipantSessionIds).toEqual([])
  })

  it("initializes client and call when credentials arrive", () => {
    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    expect(result.current.client).not.toBeNull()
    expect(result.current.call).not.toBeNull()
  })

  it("join() disables camera, joins, then enables the microphone", async () => {
    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    await act(async () => {
      await result.current.join()
    })

    expect(mockCameraDisable).toHaveBeenCalled()
    expect(mockJoin).toHaveBeenCalledWith({ create: true })
    expect(mockMicrophoneEnable).toHaveBeenCalled()

    expect(mockCameraDisable.mock.invocationCallOrder[0]).toBeLessThan(
      mockJoin.mock.invocationCallOrder[0]
    )
    expect(mockJoin.mock.invocationCallOrder[0]).toBeLessThan(
      mockMicrophoneEnable.mock.invocationCallOrder[0]
    )
  })

  it("leave() calls call.leave and resets to IDLE", async () => {
    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    await act(async () => {
      await result.current.leave()
    })

    expect(mockLeave).toHaveBeenCalled()
    expect(result.current.callingState).toBe(CallingState.IDLE)
  })

  it("sets error on join failure", async () => {
    mockJoin.mockRejectedValueOnce(new Error("Connection refused"))

    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    await act(async () => {
      await result.current.join()
    })

    expect(result.current.error).toBe("Connection refused")
    expect(result.current.callingState).toBe(CallingState.IDLE)
  })

  it("prevents double join", async () => {
    // Make join slow-ish
    mockJoin.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50))
    )

    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    await act(async () => {
      // Fire two joins simultaneously
      const p1 = result.current.join()
      const p2 = result.current.join()
      await Promise.all([p1, p2])
    })

    // Only one actual join call made
    expect(mockJoin).toHaveBeenCalledTimes(1)
  })

  it("cleans up client on unmount", () => {
    const { unmount } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    unmount()

    expect(mockLeave).toHaveBeenCalled()
    expect(mockDisconnectUser).toHaveBeenCalled()
  })

  it("tracks remote participant session IDs from call state", () => {
    const { result } = renderHook(() =>
      useStreamVoice({ userId: "user-1", credentials: validCredentials })
    )

    act(() => {
      remoteParticipantsCallbacks.forEach((callback) =>
        callback([{ sessionId: "voice-session-123" }])
      )
    })

    expect(result.current.remoteParticipantSessionIds).toEqual(["voice-session-123"])
  })
})
