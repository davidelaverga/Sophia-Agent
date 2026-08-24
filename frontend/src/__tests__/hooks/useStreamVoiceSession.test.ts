import { CallingState } from "@stream-io/video-react-sdk"
import { renderHook, act, waitFor } from "@testing-library/react"
import { StrictMode, createElement, type ReactNode } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { useStreamVoiceSession } from "../../app/hooks/useStreamVoiceSession"
import type { ContextMode, PresetType } from "../../app/lib/session-types"

const { mockBindSophiaCaptureSyntheticTestContext, mockRecordSophiaCaptureEvent, mockGeminiModuleState } = vi.hoisted(() => ({
  mockBindSophiaCaptureSyntheticTestContext: vi.fn(),
  mockRecordSophiaCaptureEvent: vi.fn(),
  mockGeminiModuleState: { syntheticTest: null as Record<string, unknown> | null },
}))

vi.mock("../../app/lib/session-capture", () => ({
  bindSophiaCaptureSyntheticTestContext: mockBindSophiaCaptureSyntheticTestContext,
  recordSophiaCaptureEvent: mockRecordSophiaCaptureEvent,
}))

// ---------------------------------------------------------------------------
// Mock: useStreamVoice (Unit 2)
// ---------------------------------------------------------------------------

let mockCallingState = CallingState.IDLE
let mockStreamError: string | null = null
let mockRemoteParticipantSessionIds: string[] = []
const mockJoin = vi.fn().mockResolvedValue(undefined)
const mockLeave = vi.fn().mockResolvedValue(undefined)
let mockCall: Record<string, unknown> | null = null
const callEventHandlers = new Map<string, (e: unknown) => void>()

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

const mockGeminiClose = vi.fn().mockResolvedValue(undefined)
const mockGeminiTrack = { enabled: true, stop: vi.fn() }
const mockGeminiConnection = {
  userId: "user-1",
  sessionId: "gemini-prod-session-1",
  streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
  websocketUrl: "wss://gemini.example/live?access_token=test",
  relayUrl: "/api/sophia/voice/gemini/relay",
  publicEventBoundary: "SophiaEventNormalizer",
  transport: "gemini_browser_websocket_ephemeral_token_with_backend_relay",
  setup: { model: "models/gemini-live" },
  setupComplete: true,
  websocket: { readyState: 1, send: vi.fn(), close: vi.fn() },
  localStream: {
    getAudioTracks: () => [mockGeminiTrack],
    getTracks: () => [mockGeminiTrack],
  },
  microphoneAudioSettings: { timestamp: "2026-08-23T10:00:00.000Z", requested: {}, tracks: [] },
  providerConnectionEpoch: 3,
  getProviderConnectionEpoch: () => 3,
  getProviderSocketEpochs: () => [3],
  continuityState: "active",
  langsmithTraceId: "trace-hook-1",
  langsmithTraceStatus: "available",
  langsmithTraceUnavailableReason: null,
  syntheticTest: null,
  syntheticTraceFault: null,
  sendText: vi.fn(),
  sendArtifactFrame: vi.fn(),
  getArtifactFrameTransportStatus: vi.fn(),
  setMicrophoneMuted: vi.fn(),
  flushOutputAudio: vi.fn(),
  close: mockGeminiClose,
}
const mockConnectGeminiBrowserLiveFromBootstrap = vi.fn().mockResolvedValue(mockGeminiConnection)

vi.mock("../../app/lib/gemini-browser-live-websocket-dogfood", () => ({
  connectGeminiBrowserLiveFromBootstrap: (...args: unknown[]) => mockConnectGeminiBrowserLiveFromBootstrap(...args),
  readGeminiConfiguredToolNames: () => [],
  readGeminiSyntheticTestContext: () => mockGeminiModuleState.syntheticTest,
  readGeminiLangSmithTraceContext: (payload: { langsmith_trace_id?: unknown }) => {
    const traceId = typeof payload.langsmith_trace_id === "string"
      ? payload.langsmith_trace_id.trim()
      : ""
    return traceId
      ? {
          langsmithTraceId: traceId,
          langsmithTraceStatus: "available",
          langsmithTraceUnavailableReason: null,
        }
      : {
          langsmithTraceId: null,
          langsmithTraceStatus: "trace_unavailable",
          langsmithTraceUnavailableReason: payload.langsmith_trace_id == null ? "not_provided" : "invalid",
        }
  },
}))

// ---------------------------------------------------------------------------
// Mock: stores
// ---------------------------------------------------------------------------

const mockAddMessage = vi.fn()
const mockSetVoiceFailed = vi.fn()
const mockSetListeningPresence = vi.fn()
const mockSetSpeakingPresence = vi.fn()
const mockSetMetaPresence = vi.fn()
const mockSettlePresence = vi.fn()
const mockResetPresence = vi.fn()
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
      setListening: mockSetListeningPresence,
      setSpeaking: mockSetSpeakingPresence,
      setMetaStage: mockSetMetaPresence,
      settleToRestingSoon: mockSettlePresence,
      reset: mockResetPresence,
    }),
}))

// ---------------------------------------------------------------------------
// Mock: fetch (token endpoint)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// ---------------------------------------------------------------------------
// Mock: EventSource
// ---------------------------------------------------------------------------

type EventSourceHandler = (event: { data?: string; lastEventId?: string }) => void

class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static latest: MockEventSource | null = null
  static instances: MockEventSource[] = []

  readyState = MockEventSource.CONNECTING
  url: string
  private listeners = new Map<string, Set<EventSourceHandler>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.latest = this
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: EventSourceHandler) {
    const handlers = this.listeners.get(type) ?? new Set<EventSourceHandler>()
    handlers.add(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener(type: string, handler: EventSourceHandler) {
    this.listeners.get(type)?.delete(handler)
  }

  close() {
    this.readyState = MockEventSource.CLOSED
  }

  emitOpen() {
    this.readyState = MockEventSource.OPEN
    this.listeners.get("open")?.forEach((handler) => handler({}))
  }

  emit(type: string, payload: Record<string, unknown>, lastEventId = "") {
    this.listeners.get(type)?.forEach((handler) =>
      handler({ data: JSON.stringify(payload), lastEventId }),
    )
  }

  emitError(readyState = MockEventSource.CONNECTING) {
    this.readyState = readyState
    this.listeners.get("error")?.forEach((handler) => handler({}))
  }
}

vi.stubGlobal("EventSource", MockEventSource)

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

function getFetchCalls(url: string, method?: string) {
  return mockFetch.mock.calls.filter(([requestUrl, init]) => {
    if (requestUrl !== url) {
      return false
    }

    if (!method) {
      return true
    }

    return (init as { method?: string } | undefined)?.method === method
  })
}

function makeGeminiBootstrap(sessionId = "gemini-prod-session-1") {
  return {
    runtime: "gemini_live",
    voice_runtime: "gemini_live",
    production_route: true,
    session_id: sessionId,
    websocket_url: "wss://gemini.example/live",
    websocket_auth: "ephemeral_access_token",
    ephemeral_token: { value: `auth_tokens/${sessionId}` },
    setup: { model: "models/gemini-live" },
    stream_url: `/api/sophia/voice/gemini/events?session_id=${sessionId}`,
    event_stream_url: `/api/sophia/voice/gemini/events?session_id=${sessionId}`,
    provider_event_relay_url: "/api/sophia/voice/gemini/relay",
    disconnect_url: "/api/sophia/voice/gemini/disconnect",
    provider_connection_epoch: 3,
    langsmith_trace_id: "trace-hook-1",
    preconnect_ttl_ms: 30_000,
    preconnect_expires_at: "2026-05-25T12:00:30Z",
  }
}

function makeD02SyntheticTest() {
  return {
    synthetic: true,
    principal_id: "voice-lab-user-1",
    test_run_id: "run-v-d02",
    scenario_id: "V-D02",
    scenario_version: "vt00.scenarios.v1",
    voice_lab_run_id_sha256: "a".repeat(64),
    browser_worker_id_sha256: "b".repeat(64),
    browser_lease_epoch: 3,
    browser_context_id_sha256: "c".repeat(64),
    environment: "production",
    retention_hours: 24,
    cleanup_obligation_id: "123e4567-e89b-42d3-a456-426614174000",
    provider_expires_at: "2033-05-18T04:03:20.000Z",
  }
}

function makeD02CleanupAcknowledgement() {
  return {
    browser_provider_close_receipts: [{
      schema: "sophia_gemini_browser_provider_close_v1",
      receipt_id: "123e4567-e89b-42d3-a456-426614174010",
      session_id: "gemini-prod-d02",
      provider_connection_epoch: 3,
      websocket_close_observed: true,
      websocket_close_code: 1000,
      websocket_closed_at: "2026-08-23T12:30:03.000Z",
    }],
    browser_provider_activation_abort_receipts: [],
  }
}

function makeD02CleanupControl() {
  const synthetic = makeD02SyntheticTest()
  return {
    schema: "sophia_voice_lab_d02_browser_worker_product_cleanup_control_v1" as const,
    voice_lab_run_id_sha256: synthetic.voice_lab_run_id_sha256,
    test_run_id: synthetic.test_run_id,
    cleanup_obligation_id: synthetic.cleanup_obligation_id,
    browser_worker_id_sha256: synthetic.browser_worker_id_sha256,
    browser_lease_epoch: synthetic.browser_lease_epoch,
    browser_context_id_sha256: synthetic.browser_context_id_sha256,
    provider_session_id: "gemini-prod-d02",
    frozen_provider_connection_epochs: [3],
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
    MockEventSource.latest = null
    MockEventSource.instances = []
    mockGeminiTrack.enabled = true
    mockGeminiModuleState.syntheticTest = null
    delete window.__sophiaVoiceLabD02WorkerCleanup
    mockGeminiClose.mockClear()
    mockSetListeningPresence.mockClear()
    mockSetSpeakingPresence.mockClear()
    mockSetMetaPresence.mockClear()
    mockSettlePresence.mockClear()
    mockResetPresence.mockClear()
    mockConnectGeminiBrowserLiveFromBootstrap.mockClear()
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValue(mockGeminiConnection)
    mockGeminiModuleState.syntheticTest = null
    vi.useRealTimers()

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          runtime: "legacy_cascade",
          voice_runtime: "legacy_cascade",
          api_key: "test-key",
          token: "test-token",
          call_type: "audio_room",
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
          stream_url: "/api/sophia/user-1/voice/events?call_id=test-call-123&session_id=voice-session-123",
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
    expect(result.current.runtime).toBe("legacy_cascade")
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
    expect(result.current.runtime).toBe("legacy_cascade")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("legacy_cascade")
    if (telemetry.runtime !== "legacy_cascade") throw new Error("Expected legacy telemetry")
    expect(telemetry.callId).toBe("test-call-123")
    expect(telemetry.voiceAgentSessionId).toBe("voice-session-123")
  })

  it("uses Gemini browser Live connector when voice connect returns gemini_live", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runtime: "gemini_live",
        voice_runtime: "gemini_live",
        production_route: true,
        session_id: "gemini-prod-session-1",
        websocket_url: "wss://gemini.example/live",
        websocket_auth: "ephemeral_access_token",
        ephemeral_token: { value: "auth_tokens/test" },
        setup: { model: "models/gemini-live" },
        stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        event_stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        provider_event_relay_url: "/api/sophia/voice/gemini/relay",
        disconnect_url: "/api/sophia/voice/gemini/disconnect",
        provider_connection_epoch: 3,
        langsmith_trace_id: "trace-hook-1",
      }),
      text: () => Promise.resolve(""),
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledTimes(1)
    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sessionId: "gemini-prod-session-1",
        bootstrap: expect.objectContaining({ runtime: "gemini_live" }),
      }),
    )
    expect(mockJoin).not.toHaveBeenCalled()
    expect(result.current.stage).toBe("listening")
    expect(result.current.runtime).toBe("gemini_live")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.sessionId).toBe("gemini-prod-session-1")
    expect(telemetry.setupComplete).toBe(true)
    expect(telemetry.providerConnectionEpoch).toBe(3)
    expect(telemetry.langsmithTraceId).toBe("trace-hook-1")
    expect(telemetry.langsmithTraceStatus).toBe("available")
    expect(telemetry.langsmithTraceUnavailableReason).toBeNull()
    expect(telemetry.publicSseState).toBe("connecting")
    expect(result.current.hasLiveCall).toBe(true)
    await waitFor(() => {
      expect(MockEventSource.latest?.url).toBe(
        "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
      )
    })
    expect(mockRecordSophiaCaptureEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "credentials-received",
      payload: expect.objectContaining({
        providerConnectionEpoch: 3,
        langsmithTraceId: "trace-hook-1",
        langsmithTraceStatus: "available",
      }),
    }))
    expect(mockRecordSophiaCaptureEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "gemini-connection-observability",
      payload: expect.objectContaining({
        providerConnectionEpoch: 3,
        langsmithTraceId: "trace-hook-1",
        langsmithTraceStatus: "available",
      }),
    }))
    expect(window.__sophiaVoiceLabD02WorkerCleanup).toBeUndefined()
  })

  it("awaits exact V-D02 product cleanup through the private browser-worker bridge", async () => {
    const syntheticTest = makeD02SyntheticTest()
    const acknowledgement = makeD02CleanupAcknowledgement()
    const close = vi.fn().mockResolvedValue(acknowledgement)
    const connection = {
      ...mockGeminiConnection,
      sessionId: "gemini-prod-d02",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-d02",
      syntheticTest,
      close,
    }
    mockGeminiModuleState.syntheticTest = syntheticTest
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValue(
      connection as unknown as typeof mockGeminiConnection,
    )
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ...makeGeminiBootstrap("gemini-prod-d02"),
        synthetic_test: syntheticTest,
      }),
      text: () => Promise.resolve(""),
    })

    const { result } = renderHook(() => useStreamVoiceSession("voice-lab-user-1"))
    await act(async () => {
      await result.current.startTalking()
    })
    await waitFor(() => {
      expect(window.__sophiaVoiceLabD02WorkerCleanup).toBeDefined()
    })

    let received: unknown
    await act(async () => {
      received = await window.__sophiaVoiceLabD02WorkerCleanup?.close(
        makeD02CleanupControl(),
      )
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith({ providerConnectionEpochs: [3] })
    expect(received).toEqual(acknowledgement)
  })

  it("rejects a drifted V-D02 browser-worker cleanup binding without closing product state", async () => {
    const syntheticTest = makeD02SyntheticTest()
    const close = vi.fn().mockResolvedValue(makeD02CleanupAcknowledgement())
    const connection = {
      ...mockGeminiConnection,
      sessionId: "gemini-prod-d02",
      syntheticTest,
      close,
    }
    mockGeminiModuleState.syntheticTest = syntheticTest
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValue(
      connection as unknown as typeof mockGeminiConnection,
    )
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ...makeGeminiBootstrap("gemini-prod-d02"),
        synthetic_test: syntheticTest,
      }),
      text: () => Promise.resolve(""),
    })

    const { result } = renderHook(() => useStreamVoiceSession("voice-lab-user-1"))
    await act(async () => {
      await result.current.startTalking()
    })
    await waitFor(() => {
      expect(window.__sophiaVoiceLabD02WorkerCleanup).toBeDefined()
    })
    const driftedControl = {
      ...makeD02CleanupControl(),
      browser_context_id_sha256: "d".repeat(64),
    }

    await expect(
      window.__sophiaVoiceLabD02WorkerCleanup?.close(driftedControl),
    ).rejects.toThrow("binding mismatch")
    expect(close).not.toHaveBeenCalled()
  })

  it("keeps the V-D02 cleanup bridge replayable after an ambiguous first response", async () => {
    const syntheticTest = makeD02SyntheticTest()
    const acknowledgement = makeD02CleanupAcknowledgement()
    const close = vi.fn().mockResolvedValue(acknowledgement)
      .mockRejectedValueOnce(new Error("cleanup acknowledgement response lost"))
      .mockResolvedValueOnce(acknowledgement)
    const connection = {
      ...mockGeminiConnection,
      sessionId: "gemini-prod-d02",
      syntheticTest,
      close,
    }
    mockGeminiModuleState.syntheticTest = syntheticTest
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValue(
      connection as unknown as typeof mockGeminiConnection,
    )
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ...makeGeminiBootstrap("gemini-prod-d02"),
        synthetic_test: syntheticTest,
      }),
      text: () => Promise.resolve(""),
    })

    const { result } = renderHook(() => useStreamVoiceSession("voice-lab-user-1"))
    await act(async () => {
      await result.current.startTalking()
    })
    await waitFor(() => {
      expect(window.__sophiaVoiceLabD02WorkerCleanup).toBeDefined()
    })
    const bridge = window.__sophiaVoiceLabD02WorkerCleanup
    const control = makeD02CleanupControl()

    await expect(bridge?.close(control)).rejects.toThrow("response lost")
    expect(window.__sophiaVoiceLabD02WorkerCleanup).toBe(bridge)
    await expect(bridge?.close(control)).resolves.toEqual(acknowledgement)
    expect(close).toHaveBeenNthCalledWith(1, { providerConnectionEpochs: [3] })
    expect(close).toHaveBeenNthCalledWith(2, { providerConnectionEpochs: [3] })
  })

  it("captures governed trace-fault receipts under the exact app-authenticated run binding", async () => {
    const syntheticTest = {
      synthetic: true,
      principal_id: "voice-lab-user-1",
      test_run_id: "run-v-l01",
      scenario_id: "V-L01",
      scenario_version: "vt00.scenarios.v1",
      environment: "production",
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    }
    mockGeminiModuleState.syntheticTest = syntheticTest
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runtime: "gemini_live",
        voice_runtime: "gemini_live",
        production_route: true,
        session_id: "gemini-prod-v-l01",
        websocket_url: "wss://gemini.example/live",
        ephemeral_token: { value: "auth_tokens/test" },
        setup: { model: "models/gemini-live" },
        stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-v-l01",
        provider_event_relay_url: "/api/sophia/voice/gemini/relay",
        disconnect_url: "/api/sophia/voice/gemini/disconnect",
        synthetic_test: syntheticTest,
        trace_fault: { schema: "sophia_voice_lab_trace_fault_v1" },
      }),
      text: () => Promise.resolve(""),
    })
    const { result } = renderHook(() => useStreamVoiceSession("voice-lab-user-1"))
    await act(async () => {
      await result.current.startTalking()
    })
    const options = mockConnectGeminiBrowserLiveFromBootstrap.mock.calls[0]?.[0] as {
      onSyntheticTraceFaultReceipt?: (receipt: Record<string, unknown>) => void
    }
    const receipt = {
      schema: "sophia_voice_lab_trace_fault_v1",
      fault: "langsmith_unavailable",
      phase: "applied",
      principal_id: syntheticTest.principal_id,
      test_run_id: syntheticTest.test_run_id,
      scenario_id: syntheticTest.scenario_id,
      scenario_version: syntheticTest.scenario_version,
      environment: syntheticTest.environment,
      trace_unavailable: true,
      canonical_behavior_unchanged: true,
    }
    act(() => options.onSyntheticTraceFaultReceipt?.(receipt))

    expect(mockBindSophiaCaptureSyntheticTestContext).toHaveBeenCalledWith(syntheticTest)
    expect(mockRecordSophiaCaptureEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "gemini-trace-fault-receipt",
      payload: expect.objectContaining({
        voiceAgentSessionId: "gemini-prod-v-l01",
        receipt,
      }),
    }))
  })

  it("promotes Gemini barge-in transcript handoffs and ignores duplicate public echoes", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runtime: "gemini_live",
        voice_runtime: "gemini_live",
        production_route: true,
        session_id: "gemini-prod-session-1",
        websocket_url: "wss://gemini.example/live",
        websocket_auth: "ephemeral_access_token",
        ephemeral_token: { value: "auth_tokens/test" },
        setup: { model: "models/gemini-live" },
        stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        event_stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        provider_event_relay_url: "/api/sophia/voice/gemini/relay",
        disconnect_url: "/api/sophia/voice/gemini/disconnect",
      }),
      text: () => Promise.resolve(""),
    })
    const onUserTranscript = vi.fn()
    const { result } = renderHook(() => useStreamVoiceSession("user-1", { onUserTranscript }))

    await act(async () => {
      await result.current.startTalking()
    })

    const options = mockConnectGeminiBrowserLiveFromBootstrap.mock.calls[0]?.[0] as {
      onBargeInTranscriptHandoff?: (diagnostic: Record<string, unknown>) => void
    }
    act(() => {
      options.onBargeInTranscriptHandoff?.({
        timestamp: "2026-05-24T05:28:01.000Z",
        providerReceiveSequence: 84,
        providerReceivedAt: "2026-05-24T05:28:00.900Z",
        relayCorrelationId: "gemini-84",
        text: "Actually pause there",
        transcriptPreview: "Actually pause there",
        transcriptLength: 20,
        captured: true,
        promoted: true,
        ignored: false,
        duplicateSuppressed: false,
        promotionLatencyMs: 100,
        newTurnDispatched: true,
        newTurnDispatchBlockedReason: "none",
        bargeInConfirmationSource: "provider_input_transcription",
        bargeInConfirmationReason: "provider_input_transcription_after_assistant_output_with_text",
        bargeInTranscriptCapturedCount: 1,
        bargeInTranscriptPromotedCount: 1,
        bargeInTranscriptPromotionLatencyMs: 100,
        bargeInTranscriptIgnoredCount: 0,
        bargeInTranscriptDuplicateSuppressedCount: 0,
        lastBargeInTranscriptPreview: "Actually pause there",
        bargeInNewTurnDispatchCount: 1,
        bargeInNewTurnDispatchBlockedReason: "none",
      })
    })

    expect(onUserTranscript).toHaveBeenCalledTimes(1)
    expect(onUserTranscript).toHaveBeenCalledWith("Actually pause there")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.bargeInTranscriptCapturedCount).toBe(1)
    expect(telemetry.bargeInTranscriptPromotedCount).toBe(1)
    expect(telemetry.bargeInNewTurnDispatchCount).toBe(1)

    act(() => {
      emitCustomEvent("sophia.user_transcript", {
        text: "Actually pause there",
        utterance_id: "provider-user-84",
        source_sequence: 84,
        relay_correlation_id: "gemini-84",
      })
    })

    expect(onUserTranscript).toHaveBeenCalledTimes(1)
  })

  it("exposes Gemini runtime callback telemetry to the session UI", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runtime: "gemini_live",
        voice_runtime: "gemini_live",
        production_route: true,
        session_id: "gemini-prod-session-1",
        websocket_url: "wss://gemini.example/live",
        websocket_auth: "ephemeral_access_token",
        ephemeral_token: { value: "auth_tokens/test" },
        setup: { model: "models/gemini-live" },
        stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        event_stream_url: "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1",
        provider_event_relay_url: "/api/sophia/voice/gemini/relay",
        disconnect_url: "/api/sophia/voice/gemini/disconnect",
      }),
      text: () => Promise.resolve(""),
    })
    mockConnectGeminiBrowserLiveFromBootstrap.mockImplementationOnce(async (options: {
      onStage?: (stage: string) => void
      onProviderEvent?: (event: unknown) => void
      onRelayStatus?: (status: "active") => void
      onRelayDiagnostic?: (diagnostic: Record<string, unknown>) => void
      onWebSocketDiagnostic?: (diagnostic: Record<string, unknown>) => void
      onToolLoopDiagnostic?: (diagnostic: {
        timestamp: string
        phase: string
        toolCall: { name: string | null }
        success: boolean | null
      }) => void
      onOutputAudioReceived?: (diagnostic: Record<string, unknown>) => void
      onOutputAudioPlaybackReceipt?: (receipt: Record<string, unknown>) => void
    }) => {
      options.onStage?.("opening_websocket")
      options.onProviderEvent?.({ setupComplete: {} })
      options.onRelayStatus?.("active")
      options.onRelayDiagnostic?.({
        timestamp: "2026-04-07T12:00:00.320Z",
        eventType: "serverContent",
        consecutiveFailures: 0,
        errorText: "",
      })
      options.onWebSocketDiagnostic?.({
        timestamp: "2026-04-07T12:00:00.330Z",
        kind: "close",
        message: "normal close",
      })
      options.onToolLoopDiagnostic?.({
        timestamp: "2026-04-07T12:00:00.340Z",
        phase: "tool_call_received",
        toolCall: { name: "emit_artifact" },
        success: null,
      })
      options.onToolLoopDiagnostic?.({
        timestamp: "2026-04-07T12:00:00.360Z",
        phase: "tool_response_sent",
        toolCall: { name: "emit_artifact" },
        success: true,
      })
      options.onOutputAudioReceived?.({
        timestamp: "2026-04-07T12:00:00.370Z",
        providerConnectionEpoch: 3,
      })
      options.onOutputAudioPlaybackReceipt?.({
        phase: "started",
        providerConnectionEpoch: 3,
        playbackGeneration: 0,
        invalidatedByPlaybackGeneration: null,
      })
      return mockGeminiConnection
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(result.current.runtime).toBe("gemini_live")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.providerEventCount).toBe(1)
    expect(telemetry.relayStatus).toBe("active")
    expect(telemetry.relayDiagnosticCount).toBe(1)
    expect(telemetry.websocketDiagnosticCount).toBe(1)
    expect(telemetry.toolCallCount).toBe(1)
    expect(telemetry.toolResponseCount).toBe(1)
    expect(telemetry.outputAudioEventCount).toBe(1)
    expect(telemetry.outputAudioReceivedCount).toBe(1)
    expect(telemetry.outputAudioPlaybackStartedCount).toBe(1)
    expect(telemetry.lastToolName).toBe("emit_artifact")
    expect(mockRecordSophiaCaptureEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "gemini-output-audio-received",
    }))
    expect(mockRecordSophiaCaptureEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: "gemini-output-audio-playback-started",
    }))
  })

  it("includes session_id and thread_id when the voice session is bound to an active session", async () => {
    const { result } = renderHook(() =>
      useStreamVoiceSession("user-1", {
        sessionId: "session-123",
        threadId: "thread-456",
      }),
    )

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/connect",
      expect.objectContaining({
        body: JSON.stringify({
          platform: "voice",
          context_mode: "gaming",
          ritual: "vent",
          session_id: "session-123",
          thread_id: "thread-456",
        }),
      }),
    )
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
    mockFetch.mockImplementation(async (url, init) => {
      if (
        url === "/api/sophia/user-1/voice/connect"
        && (init as { method?: string } | undefined)?.method === "POST"
      ) {
        return {
          ok: false,
          status: 503,
          text: () => Promise.resolve("Service unavailable"),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
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
    mockFetch.mockImplementation(async (url, init) => {
      if (
        url === "/api/sophia/user-1/voice/connect"
        && (init as { method?: string } | undefined)?.method === "POST"
      ) {
        return {
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
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
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

  it("ignores concurrent startTalking calls while a connect request is already in flight", async () => {
    let resolveFetch: ((value: {
      ok: boolean
      json: () => Promise<Record<string, unknown>>
      text: () => Promise<string>
    }) => void) | null = null

    mockFetch.mockImplementation((url, init) => {
      if (
        url === "/api/sophia/user-1/voice/connect"
        && (init as { method?: string } | undefined)?.method === "POST"
      ) {
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      })
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      const firstStart = result.current.startTalking()
      const secondStart = result.current.startTalking()

      await waitFor(() => {
        expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)
      })

      resolveFetch?.({
        ok: true,
        json: () => Promise.resolve({
          api_key: "test-key",
          token: "test-token",
          call_type: "audio_room",
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
          stream_url: "/api/sophia/user-1/voice/events?call_id=test-call-123&session_id=voice-session-123",
        }),
        text: () => Promise.resolve(""),
      })

      await Promise.all([firstStart, secondStart])
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)
  })

  it("does not treat Strict Mode effect cleanup as a permanent destroy flag", async () => {
    mockCall = makeCallMock()

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children)

    const { result } = renderHook(() => useStreamVoiceSession("user-1"), { wrapper })

    await act(async () => {
      await result.current.startTalking()
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)
    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")[0]).toEqual([
      "/api/sophia/user-1/voice/connect",
      expect.objectContaining({
        method: "POST",
      }),
    ])
  })

  it("prefetches a delayed voice session and reuses it on startTalking", async () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)

    await act(async () => {
      await result.current.startTalking()
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)
    expect(result.current.stage).toBe("connecting")
  })

  it("starts backend warmup as soon as prefetched credentials are ready", async () => {
    vi.useFakeTimers()

    renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/warmup", "POST")).toHaveLength(1)

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/warmup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
        }),
      }),
    )
  })

  it("disconnects an unused prefetched session on unmount", async () => {
    vi.useFakeTimers()

    const { unmount } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    unmount()

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/disconnect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
        }),
      }),
    )
  })

  it("attempts Gemini preconnect automatically while the session is idle", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async (url, _init) => {
      if (url === "/api/sophia/user-1/voice/connect") {
        return {
          ok: true,
          json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-preconnect-1")),
          text: () => Promise.resolve(""),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
    })

    renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/connect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          platform: "voice",
          context_mode: "gaming",
          ritual: "vent",
          preconnect: true,
        }),
      }),
    )
    expect(getFetchCalls("/api/sophia/user-1/voice/warmup", "POST")).toHaveLength(0)
  })

  it("skips background preconnect when voice mode is disabled", async () => {
    vi.useFakeTimers()

    renderHook(() => useStreamVoiceSession("user-1", { preconnectEnabled: false }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(0)
  })

  it("uses a valid Gemini preconnect bootstrap on startTalking", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async (url, _init) => {
      if (url === "/api/sophia/user-1/voice/connect") {
        return {
          ok: true,
          json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-preconnect-1")),
          text: () => Promise.resolve(""),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    await act(async () => {
      await result.current.startTalking()
    })

    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(1)
    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sessionId: "gemini-prod-preconnect-1",
        bootstrap: expect.objectContaining({
          runtime: "gemini_live",
          session_id: "gemini-prod-preconnect-1",
        }),
      }),
    )
    expect(result.current.runtime).toBe("gemini_live")
  })

  it("falls back to normal Gemini connect when background preconnect fails without surfacing an error", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async (url, init) => {
      if (url === "/api/sophia/user-1/voice/connect") {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { preconnect?: boolean }
        if (body.preconnect) {
          return {
            ok: false,
            status: 409,
            text: () => Promise.resolve("unsupported"),
          }
        }

        return {
          ok: true,
          json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-normal-1")),
          text: () => Promise.resolve(""),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.stage).toBe("idle")
    expect(result.current.error).toBeUndefined()

    await act(async () => {
      await result.current.startTalking()
    })

    const connectCalls = getFetchCalls("/api/sophia/user-1/voice/connect", "POST")
    expect(connectCalls).toHaveLength(2)
    expect(JSON.parse(String((connectCalls[1]?.[1] as { body?: string })?.body))).toEqual({
      platform: "voice",
      context_mode: "gaming",
      ritual: "vent",
    })
    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "gemini-prod-normal-1",
      }),
    )
  })

  it("treats active-session Gemini preconnect responses as skipped warmups", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async (url, init) => {
      if (url === "/api/sophia/user-1/voice/connect") {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { preconnect?: boolean }
        if (body.preconnect) {
          return {
            ok: true,
            json: () => Promise.resolve({
              runtime: "gemini_live",
              voice_runtime: "gemini_live",
              production_route: true,
              preconnect: true,
              preconnect_skipped: true,
              preconnect_skipped_reason: "already_active",
              active_voice_session_exists: true,
              session_id: "gemini-prod-active-1",
            }),
            text: () => Promise.resolve(""),
          }
        }

        return {
          ok: true,
          json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-normal-after-skip")),
          text: () => Promise.resolve(""),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(result.current.stage).toBe("idle")
    expect(result.current.error).toBeUndefined()

    await act(async () => {
      await result.current.startTalking()
    })

    const connectCalls = getFetchCalls("/api/sophia/user-1/voice/connect", "POST")
    expect(connectCalls).toHaveLength(2)
    expect(JSON.parse(String((connectCalls[1]?.[1] as { body?: string })?.body))).toEqual({
      platform: "voice",
      context_mode: "gaming",
      ritual: "vent",
    })
    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "gemini-prod-normal-after-skip",
      }),
    )
  })

  it("suppresses duplicate Gemini opening greeting transcripts before user input", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-greeting-1")),
      text: () => Promise.resolve(""),
    })
    const onAssistantResponse = vi.fn()
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValueOnce({
      ...mockGeminiConnection,
      sessionId: "gemini-prod-greeting-1",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-greeting-1",
    })
    const { result } = renderHook(() => useStreamVoiceSession("user-1", { onAssistantResponse }))

    await act(async () => {
      await result.current.startTalking()
    })

    await waitFor(() => {
      expect(MockEventSource.latest?.url).toBe(
        "/api/sophia/voice/gemini/events?session_id=gemini-prod-greeting-1",
      )
    })

    act(() => {
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: {
          text: "Hey Luis, I'm here.",
          is_final: true,
          response_id: "opening-1",
          source_sequence: 1,
          assistant_transcript_source: "provider_output_transcription",
          assistant_transcript_approximate: true,
        },
      })
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: {
          text: "Hey Luis, I'm here again.",
          is_final: true,
          response_id: "opening-2",
          source_sequence: 2,
          assistant_transcript_source: "provider_output_transcription",
          assistant_transcript_approximate: true,
        },
      })
    })

    expect(onAssistantResponse).toHaveBeenCalledTimes(1)
    expect(onAssistantResponse).toHaveBeenCalledWith("Hey Luis, I'm here.")
    expect(result.current.finalReply).toBe("Hey Luis, I'm here.")
  })

  it("replaces assistant annotation success claims when no annotation count changed", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-claim-guard-1")),
      text: () => Promise.resolve(""),
    })
    const onAssistantResponse = vi.fn()
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValueOnce({
      ...mockGeminiConnection,
      sessionId: "gemini-prod-claim-guard-1",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-claim-guard-1",
    })
    const { result } = renderHook(() => useStreamVoiceSession("user-1", { onAssistantResponse }))

    await act(async () => {
      await result.current.startTalking()
    })

    act(() => {
      MockEventSource.latest?.emit("sophia.user_transcript", {
        type: "sophia.user_transcript",
        data: {
          text: "highlight it yellow",
          utterance_id: "claim-guard-user-1",
        },
      })
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: {
          text: "I highlighted it.",
          is_final: true,
          response_id: "claim-guard-assistant-1",
          source_sequence: 1,
          assistant_transcript_source: "provider_output_transcription",
        },
      })
    })

    expect(onAssistantResponse).toHaveBeenCalledWith("I have not added that annotation yet.")
    expect(result.current.finalReply).toBe("I have not added that annotation yet.")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.annotationIntentDetectedCount).toBe(1)
    expect(telemetry.annotationIntentSource).toBe("public_user_transcript")
    expect(telemetry.assistantAnnotationClaimSuppressedCount).toBe(1)
    expect(telemetry.recentAnnotationActionSucceeded).toBe(false)
  })

  it("allows assistant annotation acknowledgements after a Coreview annotation success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-claim-guard-2")),
      text: () => Promise.resolve(""),
    })
    const onAssistantResponse = vi.fn()
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValueOnce({
      ...mockGeminiConnection,
      sessionId: "gemini-prod-claim-guard-2",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-claim-guard-2",
    })
    const { result } = renderHook(() => useStreamVoiceSession("user-1", { onAssistantResponse }))

    await act(async () => {
      await result.current.startTalking()
    })

    const connectOptions = mockConnectGeminiBrowserLiveFromBootstrap.mock.calls.at(-1)?.[0] as {
      onToolLoopDiagnostic?: (diagnostic: Record<string, unknown>) => void
    }

    act(() => {
      MockEventSource.latest?.emit("sophia.user_transcript", {
        type: "sophia.user_transcript",
        data: {
          text: "highlight it yellow",
          utterance_id: "claim-guard-user-2",
        },
      })
      connectOptions.onToolLoopDiagnostic?.({
        timestamp: new Date().toISOString(),
        phase: "tool_response_sent",
        toolCall: { id: "annotation-1", name: "coreview_add_annotation", args: null, argsPreview: "{}" },
        success: true,
        resultSummary: "Added a yellow highlight.",
        backendResponse: {
          ok: true,
          action: "add_annotation",
          command_source: "gemini_tool",
          annotation_kind: "highlight",
          annotation_color: "yellow",
          annotation_page_index: 0,
          annotation_count: 1,
          highlight_count: 1,
          comment_count: 0,
          annotation_overlay_captured: true,
          raw_comment_text_excluded: true,
          raw_artifact_text_excluded: true,
          raw_frame_excluded: true,
        },
      })
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: {
          text: "I highlighted it.",
          is_final: true,
          response_id: "claim-guard-assistant-2",
          source_sequence: 1,
          assistant_transcript_source: "provider_output_transcription",
        },
      })
    })

    expect(onAssistantResponse).toHaveBeenCalledWith("I highlighted it.")
    expect(result.current.finalReply).toBe("I highlighted it.")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.recentAnnotationActionSucceeded).toBe(true)
    expect(telemetry.assistantAnnotationClaimSuppressedCount).toBe(0)
  })

  it("allows assistant annotation acknowledgements after a local fallback annotation success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-claim-guard-3")),
      text: () => Promise.resolve(""),
    })
    const onAssistantResponse = vi.fn()
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValueOnce({
      ...mockGeminiConnection,
      sessionId: "gemini-prod-claim-guard-3",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-claim-guard-3",
    })
    const { result } = renderHook(() => useStreamVoiceSession("user-1", { onAssistantResponse }))

    await act(async () => {
      await result.current.startTalking()
    })

    act(() => {
      MockEventSource.latest?.emit("sophia.user_transcript", {
        type: "sophia.user_transcript",
        data: {
          text: "highlighted in yellow",
          utterance_id: "claim-guard-user-3",
        },
      })
      result.current.markAnnotationActionSucceeded({
        annotationCount: 1,
        highlightCount: 1,
        commentCount: 0,
      })
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: {
          text: "I highlighted it.",
          is_final: true,
          response_id: "claim-guard-assistant-3",
          source_sequence: 1,
          assistant_transcript_source: "provider_output_transcription",
        },
      })
    })

    expect(onAssistantResponse).toHaveBeenCalledWith("I highlighted it.")
    expect(result.current.finalReply).toBe("I highlighted it.")
    const telemetry = result.current.runtimeTelemetry
    expect(telemetry.runtime).toBe("gemini_live")
    if (telemetry.runtime !== "gemini_live") throw new Error("Expected Gemini telemetry")
    expect(telemetry.recentAnnotationActionSucceeded).toBe(true)
    expect(telemetry.annotationCount).toBe(1)
    expect(telemetry.highlightCount).toBe(1)
    expect(telemetry.assistantAnnotationClaimSuppressedCount).toBe(0)
  })

  it("disconnects expired Gemini preconnect and falls back to normal connect", async () => {
    vi.useFakeTimers()
    mockFetch.mockImplementation(async (url, init) => {
      if (url === "/api/sophia/user-1/voice/connect") {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { preconnect?: boolean }
        return {
          ok: true,
          json: () => Promise.resolve(
            body.preconnect
              ? makeGeminiBootstrap("gemini-prod-expired-1")
              : makeGeminiBootstrap("gemini-prod-normal-2"),
          ),
          text: () => Promise.resolve(""),
        }
      }

      return {
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      }
    })

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await vi.advanceTimersByTimeAsync(30_001)
      await result.current.startTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/voice/gemini/disconnect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session_id: "gemini-prod-expired-1" }),
      }),
    )
    expect(getFetchCalls("/api/sophia/user-1/voice/connect", "POST")).toHaveLength(2)
    expect(mockConnectGeminiBrowserLiveFromBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "gemini-prod-normal-2",
      }),
    )
  })

  it("opens an EventSource when connect returns a stream_url", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(MockEventSource.latest?.url).toBe(
      "/api/sophia/user-1/voice/events?call_id=test-call-123&session_id=voice-session-123",
    )
  })

  it("joins the Stream call automatically once credentials create the call instance", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockJoin).toHaveBeenCalledTimes(1)
  })

  it("starts backend warmup immediately after a fresh voice connect", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/warmup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
        }),
      }),
    )
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

  it("transitions to listening when any remote participant joins the one-on-one call", async () => {
    mockCall = makeCallMock()

    const { result, rerender } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    mockCallingState = CallingState.JOINED
    rerender()
    expect(result.current.stage).toBe("connecting")

    mockRemoteParticipantSessionIds = ["unexpected-remote-session"]
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

  it("reconciles growing sophia.user_transcript events across a pause and ignores residue replays", () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onUserTranscript = vi.fn()
    renderHook(() =>
      useStreamVoiceSession("user-1", { onUserTranscript }),
    )

    act(() => {
      emitCustomEvent("sophia.user_transcript", {
        text: "Good good evening, Sofia.",
        utterance_id: "utterance-1",
      })
      emitCustomEvent("sophia.user_transcript", {
        text: "Good good evening, Sofia. How are you?",
        utterance_id: "utterance-2",
      })
      emitCustomEvent("sophia.user_transcript", {
        text: "How are you?",
        utterance_id: "utterance-3",
      })
    })

    expect(onUserTranscript.mock.calls).toEqual([
      ["Good good evening, Sofia."],
      ["Good good evening, Sofia. How are you?"],
    ])

    act(() => {
      emitCustomEvent("sophia.turn", { phase: "agent_ended" })
      emitCustomEvent("sophia.user_transcript", {
        text: "Well, as you know, I enjoy talking to you.",
        utterance_id: "utterance-4",
      })
    })

    expect(onUserTranscript.mock.calls).toEqual([
      ["Good good evening, Sofia."],
      ["Good good evening, Sofia. How are you?"],
      ["Well, as you know, I enjoy talking to you."],
    ])
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
      MockEventSource.latest?.emit("sophia.turn", {
        type: "sophia.turn",
        data: { phase: "agent_ended" },
      })
    })

    expect(result.current.stage).toBe("listening")
  })

  it("handles sophia.transcript SSE events and ignores duplicate custom delivery after SSE opens", async () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onAssistantResponse = vi.fn()
    const { result } = renderHook(() =>
      useStreamVoiceSession("user-1", { onAssistantResponse }),
    )

    await act(async () => {
      await result.current.startTalking()
    })

    act(() => {
      MockEventSource.latest?.emitOpen()
      MockEventSource.latest?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: { text: "Hello from SSE", is_final: true },
      })
      emitCustomEvent("sophia.transcript", { text: "Hello from custom", is_final: true })
    })

    expect(result.current.finalReply).toBe("Hello from SSE")
    expect(mockAddMessage).toHaveBeenCalledTimes(1)
    expect(mockAddMessage).toHaveBeenCalledWith("Hello from SSE")
    expect(onAssistantResponse).toHaveBeenCalledTimes(1)
    expect(onAssistantResponse).toHaveBeenCalledWith("Hello from SSE")
  })

  it("dedupes every public SSE event type by event id across forced reconnects", async () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()

    const onAssistantResponse = vi.fn()
    const onUserTranscript = vi.fn()
    const onArtifacts = vi.fn()
    const onBuilderTask = vi.fn()
    const { result } = renderHook(() => useStreamVoiceSession("user-1", {
      onAssistantResponse,
      onUserTranscript,
      onArtifacts,
      onBuilderTask,
    }))

    await act(async () => {
      await result.current.startTalking()
    })

    const source = MockEventSource.latest
    expect(source).not.toBeNull()

    act(() => {
      source?.emitOpen()
      source?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: { text: "Only once", is_final: true },
      }, "1")
      source?.emit("sophia.transcript", {
        type: "sophia.transcript",
        data: { text: "Duplicate transcript", is_final: true },
      }, "1")
      source?.emit("sophia.user_transcript", {
        type: "sophia.user_transcript",
        data: { text: "User once", utterance_id: "utterance-1" },
      }, "2")
      source?.emit("sophia.user_transcript", {
        type: "sophia.user_transcript",
        data: { text: "Duplicate user", utterance_id: "utterance-2" },
      }, "2")
      source?.emit("sophia.artifact", {
        type: "sophia.artifact",
        data: { takeaway: "Artifact once" },
      }, "3")
      source?.emit("sophia.artifact", {
        type: "sophia.artifact",
        data: { takeaway: "Duplicate artifact" },
      }, "3")
      source?.emit("sophia.builder_task", {
        type: "sophia.builder_task",
        data: { task_id: "builder-1" },
      }, "4")
      source?.emit("sophia.builder_task", {
        type: "sophia.builder_task",
        data: { task_id: "builder-duplicate" },
      }, "4")
      source?.emit("sophia.turn", {
        type: "sophia.turn",
        data: { phase: "agent_started" },
      }, "5")
      source?.emit("sophia.turn", {
        type: "sophia.turn",
        data: { phase: "agent_ended" },
      }, "5")
      source?.emit("sophia.turn_diagnostic", {
        type: "sophia.turn_diagnostic",
        data: { metric: "once" },
      }, "6")
      source?.emit("sophia.turn_diagnostic", {
        type: "sophia.turn_diagnostic",
        data: { metric: "duplicate" },
      }, "6")
      source?.emitError()
      source?.emitOpen()
      source?.emit("sophia.artifact", {
        type: "sophia.artifact",
        data: { takeaway: "Replay after reconnect" },
      }, "3")
      source?.emitError()
      source?.emitOpen()
      source?.emit("sophia.artifact", {
        type: "sophia.artifact",
        data: { takeaway: "New after second reconnect" },
      }, "7")
    })

    expect(onAssistantResponse).toHaveBeenCalledTimes(1)
    expect(onAssistantResponse).toHaveBeenCalledWith("Only once")
    expect(onUserTranscript).toHaveBeenCalledTimes(1)
    expect(onUserTranscript).toHaveBeenCalledWith("User once")
    expect(onArtifacts.mock.calls).toEqual([
      [{ takeaway: "Artifact once" }],
      [{ takeaway: "New after second reconnect" }],
    ])
    expect(onBuilderTask).toHaveBeenCalledTimes(1)
    expect(onBuilderTask).toHaveBeenCalledWith({ task_id: "builder-1" })
    expect(result.current.stage).toBe("speaking")
  })

  it("terminal Gemini connection loss closes SSE, tears down once, and never reconnects", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeGeminiBootstrap("gemini-prod-terminal-1")),
      text: () => Promise.resolve(""),
    })
    const terminalConnection = {
      ...mockGeminiConnection,
      sessionId: "gemini-prod-terminal-1",
      streamUrl: "/api/sophia/voice/gemini/events?session_id=gemini-prod-terminal-1",
    }
    mockConnectGeminiBrowserLiveFromBootstrap.mockResolvedValueOnce(terminalConnection)

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))
    await act(async () => {
      await result.current.startTalking()
    })

    const source = MockEventSource.latest
    const sourceCount = MockEventSource.instances.length
    const options = mockConnectGeminiBrowserLiveFromBootstrap.mock.calls[0]?.[0] as {
      onStage?: (stage: string) => void
    }

    await act(async () => {
      options.onStage?.("connection_lost")
      options.onStage?.("connection_lost")
      options.onStage?.("reconnecting")
      options.onStage?.("connected")
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockGeminiClose).toHaveBeenCalledTimes(1)
      expect(result.current.hasLiveCall).toBe(false)
    })
    expect(source?.readyState).toBe(MockEventSource.CLOSED)
    expect(MockEventSource.instances).toHaveLength(sourceCount)
    expect(result.current.stage).toBe("error")
    expect(result.current.error).toBe("Voice connection was interrupted. Tap to reconnect.")
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

  it("stopTalking requests voice disconnect for the active session", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    await act(async () => {
      await result.current.stopTalking()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/disconnect",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
        }),
      }),
    )
  })

  it("stopVoiceTransport is cleanup-only and uses the voice disconnect route", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    await act(async () => {
      await result.current.stopVoiceTransport()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/disconnect",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
        }),
      }),
    )
    expect(getFetchCalls("/api/sophia/end-session", "POST")).toHaveLength(0)
  })

  it("bargeIn leaves call synchronously and resets to idle", async () => {
    mockCallingState = CallingState.JOINED
    mockCall = makeCallMock()
    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    act(() => {
      result.current.bargeIn()
    })

    expect(mockLeave).toHaveBeenCalled()
    expect(result.current.stage).toBe("idle")
  })

  it("bargeIn requests voice disconnect for the active session", async () => {
    mockCall = makeCallMock()

    const { result } = renderHook(() => useStreamVoiceSession("user-1"))

    await act(async () => {
      await result.current.startTalking()
    })

    act(() => {
      result.current.bargeIn()
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sophia/user-1/voice/disconnect",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: "test-call-123",
          session_id: "voice-session-123",
          thread_id: "thread-voice-123",
        }),
      }),
    )
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
