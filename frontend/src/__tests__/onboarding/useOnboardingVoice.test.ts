import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  setVoiceOverEnabled: vi.fn(),
  connect: vi.fn(),
  sendText: vi.fn(),
  disconnect: vi.fn(),
  initAudioContext: vi.fn(),
  enqueuePcmChunk: vi.fn(),
  flushPlaybackQueue: vi.fn(),
  forcePrebufferOverride: vi.fn(),
  markStreamEnded: vi.fn(),
  stopPlayback: vi.fn(),
  connectVoiceSessionFreshSafely: vi.fn(),
  generateVoiceSessionId: vi.fn(() => "session-123"),
  resolveVoiceWsBaseUrl: vi.fn(() => "http://voice.test"),
}))

let voiceOverEnabled = true

vi.mock("../../app/stores/onboarding-store", () => ({
  useOnboardingStore: (selector: (state: {
    preferences: { voiceOverEnabled: boolean }
    setVoiceOverEnabled: typeof mocks.setVoiceOverEnabled
  }) => unknown) => selector({
    preferences: { voiceOverEnabled },
    setVoiceOverEnabled: mocks.setVoiceOverEnabled,
  }),
}))

vi.mock("../../app/onboarding/voice-legacy/useAudioPlayback", () => ({
  useAudioPlayback: () => ({
    initAudioContext: mocks.initAudioContext,
    enqueuePcmChunk: mocks.enqueuePcmChunk,
    flushPlaybackQueue: mocks.flushPlaybackQueue,
    forcePrebufferOverride: mocks.forcePrebufferOverride,
    markStreamEnded: mocks.markStreamEnded,
    stopPlayback: mocks.stopPlayback,
  }),
}))

vi.mock("../../app/onboarding/voice-legacy/useVoiceWebSocket", () => ({
  useVoiceWebSocket: () => ({
    connect: mocks.connect,
    sendText: mocks.sendText,
    disconnect: mocks.disconnect,
  }),
}))

vi.mock("../../app/onboarding/voice-legacy/voice-loop-connection-helpers", () => ({
  connectVoiceSessionFreshSafely: mocks.connectVoiceSessionFreshSafely,
  generateVoiceSessionId: mocks.generateVoiceSessionId,
  resolveVoiceWsBaseUrl: mocks.resolveVoiceWsBaseUrl,
}))

import { useOnboardingVoice } from "../../app/onboarding/ui/useOnboardingVoice"

describe("useOnboardingVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    voiceOverEnabled = true
    mocks.initAudioContext.mockResolvedValue({})
    mocks.connectVoiceSessionFreshSafely.mockResolvedValue({ result: {} })
    mocks.sendText.mockReturnValue(true)
    vi.stubGlobal("WebSocket", class MockWebSocket {})
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    })
  })

  it("returns false before audio is unlocked", async () => {
    const { result } = renderHook(() => useOnboardingVoice(false))

    let spoke = false
    await act(async () => {
      spoke = await result.current.speak("hello")
    })

    expect(spoke).toBe(false)
    expect(mocks.connectVoiceSessionFreshSafely).not.toHaveBeenCalled()
  })

  it("unlocks audio on interaction and sends a SPEAK_TEXT command through the legacy voice path", async () => {
    const { result } = renderHook(() => useOnboardingVoice(false))

    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mocks.initAudioContext).toHaveBeenCalledTimes(1)
    })

    let spoke = false
    await act(async () => {
      spoke = await result.current.speak("  hello there  ")
    })

    expect(spoke).toBe(true)
    expect(mocks.connectVoiceSessionFreshSafely).toHaveBeenCalledWith(expect.objectContaining({
      disconnect: mocks.disconnect,
      connect: mocks.connect,
      baseUrl: "http://voice.test",
      sessionId: "session-123",
      useSingleRetry: true,
    }))
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.sendText.mock.calls[0][0])).toMatchObject({
      type: "SPEAK_TEXT",
      text: "hello there",
    })
  })

  it("stops playback when voice-over is disabled", () => {
    const { result } = renderHook(() => useOnboardingVoice(false))

    act(() => {
      result.current.setVoiceOverEnabled(false)
    })

    expect(mocks.setVoiceOverEnabled).toHaveBeenCalledWith(false)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.flushPlaybackQueue).toHaveBeenCalledTimes(1)
    expect(mocks.stopPlayback).toHaveBeenCalledTimes(1)
  })
})