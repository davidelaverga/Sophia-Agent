import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type AuthState = {
  user: { id: string; email: string | null; name: string | null } | null
  loading: boolean
}

const { authState, connectMock } = vi.hoisted(() => ({
  authState: {
    user: { id: 'user-1', email: 'edward@example.com', name: 'Edward' },
    loading: false,
  } as AuthState,
  connectMock: vi.fn(),
}))

vi.mock('../../app/providers', () => ({
  useAuth: () => authState,
}))

vi.mock('../../app/lib/openai-browser-webrtc-dogfood', () => ({
  connectOpenAIBrowserDogfood: connectMock,
}))

import OpenAIRealtimeDogfoodPage from '../../app/debug/realtime/openai/page'

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    sessionId: 'browser-openai-1',
    callId: 'rtc_frontend_1',
    streamUrl: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
    sideband: { attached: true, public_event_boundary: 'SophiaEventNormalizer' },
    callDiagnostics: {
      requested_model: 'gpt-realtime-2',
      sdp_status: 200,
      raw_location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
      extracted_call_id: 'rtc_frontend_1',
      location_matches_documented_shape: true,
      call_id_matches_documented_shape: true,
      unexpected_location_variant: null,
    },
    peerConnection: {} as RTCPeerConnection,
    dataChannel: {} as RTCDataChannel,
    localStream: {} as MediaStream,
    transportConnectedAt: Date.now(),
    retrySidebandAttach: vi.fn(async () => ({ attached: true, call_id: 'rtc_frontend_1', public_event_boundary: 'SophiaEventNormalizer' })),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

function resolveConnection(connection: ReturnType<typeof makeConnection>) {
  return async ({ onStage }: { onStage?: (stage: string) => void }) => {
    onStage?.('requesting_microphone')
    onStage?.('connected')
    return connection
  }
}

class MockEventSource {
  static instances: MockEventSource[] = []

  readonly url: string
  readonly close = vi.fn()
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  constructor(url: string | URL) {
    this.url = String(url)
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) })
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') {
        listener(event)
      } else {
        listener.handleEvent(event)
      }
    }
  }

  open() {
    this.onopen?.(new Event('open'))
  }

  fail() {
    this.onerror?.(new Event('error'))
  }

  static reset() {
    MockEventSource.instances = []
  }
}

Object.defineProperty(globalThis, 'EventSource', {
  writable: true,
  value: MockEventSource,
})

describe('OpenAI Realtime dogfood page', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1', email: 'edward@example.com', name: 'Edward' }
    authState.loading = false
    connectMock.mockReset()
    MockEventSource.reset()
  })

  it('renders the heading and primary controls', () => {
    render(<OpenAIRealtimeDogfoodPage />)

    expect(screen.getByRole('heading', { name: 'OpenAI Realtime Dogfood' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
    expect(screen.getByText('Internal experimental path')).toBeInTheDocument()
  })

  it('invokes the helper, shows session state, and opens the normalized SSE stream', async () => {
    const closeMock = vi.fn(async () => undefined)
    connectMock.mockImplementation(resolveConnection(makeConnection({ close: closeMock })))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('browser-openai-1')).toBeInTheDocument())
    expect(screen.getAllByText('rtc_frontend_1').length).toBeGreaterThan(0)
    expect(screen.getByText('gpt-realtime-2')).toBeInTheDocument()
    expect(screen.getByText('https://api.openai.com/v1/realtime/calls/rtc_frontend_1')).toBeInTheDocument()
    expect(screen.getByText('location documented; call id documented')).toBeInTheDocument()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0]?.url).toBe('/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1')

    await act(async () => {
      MockEventSource.instances[0]?.open()
    })

    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0))
  })

  it('renders a clean runtime error and checklist when the helper fails', async () => {
    connectMock.mockRejectedValue(
      new Error('OpenAI browser dogfood session failed: OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.'),
    )

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(screen.getByText(/OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true/i)).toBeInTheDocument()
    })
    expect(screen.getByText('Runtime checklist')).toBeInTheDocument()
    expect(screen.getByText('SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true')).toBeInTheDocument()
  })

  it('closes the helper connection and EventSource on disconnect', async () => {
    const closeMock = vi.fn(async () => undefined)
    connectMock.mockImplementation(resolveConnection(makeConnection({ close: closeMock })))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1))
    expect(MockEventSource.instances[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('shows incoming sophia events in the compact event log', async () => {
    connectMock.mockImplementation(resolveConnection(makeConnection()))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]?.emit('sophia.transcript', {
        type: 'sophia.transcript',
        data: { text: 'Hola Edward, te escucho.' },
      })
    })

    await waitFor(() => expect(screen.getByText('Hola Edward, te escucho.')).toBeInTheDocument())
  })

  it('keeps the event log bounded to the latest 100 entries', async () => {
    connectMock.mockImplementation(resolveConnection(makeConnection()))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      for (let index = 0; index <= 100; index += 1) {
        MockEventSource.instances[0]?.emit('sophia.turn_diagnostic', {
          type: 'sophia.turn_diagnostic',
          data: { reason: `entry-${index}` },
        })
      }
    })

    await waitFor(() => expect(screen.getAllByTestId('dogfood-event-entry')).toHaveLength(100))
    expect(screen.queryByText('entry-0')).not.toBeInTheDocument()
    expect(screen.getByText('entry-100')).toBeInTheDocument()
  })

  it('shows degraded audio-only mode and keeps the session connected when sideband is unavailable', async () => {
    connectMock.mockImplementation(resolveConnection(makeConnection({
      sideband: {
        attached: false,
        public_event_boundary: 'Unavailable while sideband is detached',
        attach_error: 'OpenAI browser dogfood sideband attach failed: wss://api.openai.com/v1/realtime?call_id=rtc_frontend_1 -> HTTP 404; request_id=req_live_404; error_type=InvalidStatusCode; error=server rejected WebSocket connection: HTTP 404',
        provider_request_id: 'req_live_404',
        provider_status_code: 404,
        session_alive_ms_at_last_attempt: 1800,
        remote_audio_active_at_last_attempt: false,
        last_attach_attempt_at: 1_715_084_800_000,
        webrtc_readiness: {
          ready: true,
          reason: 'connection_state_connected',
          elapsed_ms: 42,
          connection_state: 'connected',
          ice_connection_state: 'connected',
          ice_gathering_state: 'complete',
          signaling_state: 'stable',
          data_channel_ready_state: 'open',
          session_alive_ms: 1800,
        },
      },
    })))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getByText('Degraded audio-only mode')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Retry Sideband Attach' })).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText('req_live_404')).toBeInTheDocument()
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('retries sideband attach on the live call without reconnecting and opens SSE on later success', async () => {
    const retrySidebandAttach = vi.fn(async () => ({
      attached: true,
      call_id: 'rtc_frontend_1',
      public_event_boundary: 'SophiaEventNormalizer',
      attach_attempt_count: 2,
    }))
    connectMock.mockImplementation(resolveConnection(makeConnection({
      sideband: {
        attached: false,
        public_event_boundary: 'Unavailable while sideband is detached',
        attach_error: 'OpenAI browser dogfood sideband attach failed: HTTP 404',
      },
      retrySidebandAttach,
    })))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Degraded audio-only mode')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry Sideband Attach' })[0] as HTMLElement)

    await waitFor(() => expect(retrySidebandAttach).toHaveBeenCalledTimes(1))
    expect(connectMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getAllByText('Attached').length).toBeGreaterThan(0))
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('keeps the live session degraded and surfaces diagnostics when retry still fails', async () => {
    const retrySidebandAttach = vi.fn(async () => ({
      attached: false,
      attach_error: 'OpenAI browser dogfood sideband attach failed: wss://api.openai.com/v1/realtime?call_id=rtc_frontend_1 -> HTTP 404; request_id=req_retry_404; error_type=InvalidStatusCode; error=server rejected WebSocket connection: HTTP 404',
      public_event_boundary: 'Unavailable while sideband is detached',
      provider_request_id: 'req_retry_404',
      provider_status_code: 404,
      session_alive_ms_at_last_attempt: 4200,
      remote_audio_active_at_last_attempt: true,
    }))
    connectMock.mockImplementation(resolveConnection(makeConnection({
      sideband: {
        attached: false,
        public_event_boundary: 'Unavailable while sideband is detached',
        attach_error: 'OpenAI browser dogfood sideband attach failed: HTTP 404',
      },
      retrySidebandAttach,
    })))

    render(<OpenAIRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Degraded audio-only mode')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry Sideband Attach' })[0] as HTMLElement)

    await waitFor(() => expect(retrySidebandAttach).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('req_retry_404')).toBeInTheDocument())
    expect(screen.getByText('Degraded audio-only mode')).toBeInTheDocument()
    expect(MockEventSource.instances).toHaveLength(0)
  })
})