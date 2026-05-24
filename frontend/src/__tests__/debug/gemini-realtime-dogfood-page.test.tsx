import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

vi.mock('../../app/lib/gemini-browser-live-websocket-dogfood', () => ({
  connectGeminiBrowserLiveDogfood: connectMock,
  isGeminiSetupCompleteMessage: (event: unknown) => {
    return Boolean(event && typeof event === 'object' && 'setupComplete' in (event as Record<string, unknown>))
  },
  readGeminiConfiguredToolNames: (setup: Record<string, unknown>) => {
    const tools = Array.isArray(setup.tools) ? setup.tools : []
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== 'object') return []
      const declarations = (tool as { functionDeclarations?: Array<{ name?: string }> }).functionDeclarations ?? []
      return declarations
        .map((declaration) => declaration.name)
        .filter((name): name is string => typeof name === 'string')
    })
  },
}))

import GeminiRealtimeDogfoodPage from '../../app/debug/realtime/gemini/page'

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

describe('Gemini Realtime dogfood page', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1', email: 'edward@example.com', name: 'Edward' }
    authState.loading = false
    connectMock.mockReset()
    MockEventSource.reset()
  })

  it('renders the heading and primary controls', () => {
    render(<GeminiRealtimeDogfoodPage />)

    expect(screen.getByRole('heading', { name: 'Gemini Live Dogfood' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
    expect(screen.getByText('Browser-owned Gemini WSS + backend relay')).toBeInTheDocument()
  })

  it('invokes the helper, shows session state, and opens the normalized SSE stream', async () => {
    const closeMock = vi.fn(async () => undefined)

    connectMock.mockImplementation(async ({
      onStage,
      onProviderEvent,
      onRelayStatus,
      onOutputAudio,
      onToolLoopDiagnostic,
    }: {
      onStage?: (stage: string) => void
      onProviderEvent?: (event: unknown) => void
      onRelayStatus?: (status: string) => void
      onOutputAudio?: () => void
      onToolLoopDiagnostic?: (diagnostic: unknown) => void
    }) => {
      onStage?.('requesting_microphone')
      onStage?.('opening_websocket')
      onStage?.('waiting_setup_complete')
      onProviderEvent?.({ setupComplete: {} })
      onRelayStatus?.('active')
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.000Z').toISOString(),
        phase: 'tool_call_received',
        toolCall: {
          id: 'artifact-call-1',
          name: 'emit_artifact',
          args: { session_goal: 'Probe Gemini artifacts.', voice_speed: 'normal' },
          argsPreview: '{"session_goal":"Probe Gemini artifacts.","voice_speed":"normal"}',
        },
        success: null,
        resultSummary: null,
        errorText: null,
      })
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.010Z').toISOString(),
        phase: 'backend_accepted_tool_call',
        toolCall: { id: 'artifact-call-1', name: 'emit_artifact', args: null, argsPreview: '{}' },
        success: true,
        resultSummary: 'Existing Sophia emit_artifact tool executed.',
        taskId: 'builder-thread-1',
        taskStatus: 'running',
        backendResponse: { task_id: 'builder-thread-1', status: 'running' },
        errorText: null,
      })
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.020Z').toISOString(),
        phase: 'tool_response_sent',
        toolCall: { id: 'artifact-call-1', name: 'emit_artifact', args: null, argsPreview: '{}' },
        success: true,
        resultSummary: 'Artifact recorded.',
        errorText: null,
      })
      onStage?.('connected')
      onStage?.('streaming_audio')
      onOutputAudio?.()

      return {
        userId: 'user-1',
        sessionId: 'browser-gemini-1',
        streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
        websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
        relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
        publicEventBoundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
        setup: {
          model: 'models/gemini-3.1-flash-live-preview',
          tools: [{ functionDeclarations: [{ name: 'emit_artifact' }] }],
        },
        setupComplete: true,
        websocket: {} as WebSocket,
        localStream: {} as MediaStream,
        sendText: vi.fn(),
        close: closeMock,
      }
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('browser-gemini-1')).toBeInTheDocument())
    expect(screen.getByText('Reached')).toBeInTheDocument()
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    expect(screen.getByText('emit_artifact')).toBeInTheDocument()
    expect(screen.getByText(/emit_artifact \| id artifact-call-1/i)).toBeInTheDocument()
    expect(screen.getByText('Success: Existing Sophia emit_artifact tool executed.')).toBeInTheDocument()
    expect(screen.getAllByText('builder-thread-1').length).toBeGreaterThan(0)
    expect(screen.getByText('running | builder-thread-1')).toBeInTheDocument()
    expect(screen.getByText('Yes: emit_artifact artifact-call-1')).toBeInTheDocument()
    expect(screen.getByText('toolResponse sent')).toBeInTheDocument()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0]?.url).toBe('/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1')

    await act(async () => {
      MockEventSource.instances[0]?.open()
    })

    await waitFor(() => expect(screen.getAllByText('Connected').length).toBeGreaterThan(0))
  })

  it('transitions setup status from pending to reached when setupComplete is emitted', async () => {
    let capturedProviderEvent: ((event: unknown) => void) | undefined

    connectMock.mockImplementation(({ onStage, onProviderEvent }: {
      onStage?: (stage: string) => void
      onProviderEvent?: (event: unknown) => void
    }) => {
      capturedProviderEvent = onProviderEvent
      onStage?.('requesting_microphone')
      onStage?.('opening_websocket')
      onStage?.('waiting_setup_complete')
      return new Promise(() => undefined)
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getByText('Waiting for setupComplete')).toBeInTheDocument())
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)

    await act(async () => {
      capturedProviderEvent?.({ setupComplete: {} })
    })

    await waitFor(() => expect(screen.getByText('Reached')).toBeInTheDocument())
    expect(screen.getAllByText('Setup complete').length).toBeGreaterThan(0)
  })

  it('renders a clean runtime error and checklist when the helper fails', async () => {
    connectMock.mockRejectedValue(
      new Error('Gemini browser dogfood session failed: Gemini browser Live dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.'),
    )

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(screen.getByText(/Gemini browser Live dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true/i)).toBeInTheDocument()
    })
    expect(screen.getByText('Runtime checklist')).toBeInTheDocument()
    expect(screen.getByText('SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true')).toBeInTheDocument()
  })

  it('shows relay errors clearly when the helper surfaces them', async () => {
    connectMock.mockImplementation(async ({
      onStage,
      onRelayStatus,
      onRelayDiagnostic,
    }: {
      onStage?: (stage: string) => void
      onRelayStatus?: (status: string) => void
      onRelayDiagnostic?: (diagnostic: unknown) => void
    }) => {
      onStage?.('connected')
      onRelayStatus?.('degraded')
      onRelayDiagnostic?.({
        timestamp: new Date('2026-05-19T01:17:45.100Z').toISOString(),
        targetPath: '/api/sophia/voice/dogfood/gemini/relay',
        eventType: 'serverContent.modelTurn.inlineData.audio',
        requestBodyBytes: 72000,
        hasHttpResponse: false,
        statusCode: null,
        statusText: null,
        errorText: 'Failed to fetch',
        fetchErrorName: 'TypeError',
        terminal: false,
        consecutiveFailures: 1,
        websocketOpen: true,
        websocketReadyState: 1,
        websocketState: 'open',
        sessionClosing: false,
      })

      return {
        userId: 'user-1',
        sessionId: 'browser-gemini-1',
        streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
        websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
        relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
        publicEventBoundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
        setup: {},
        setupComplete: true,
        websocket: {} as WebSocket,
        localStream: {} as MediaStream,
        sendText: vi.fn(),
        close: vi.fn(async () => undefined),
      }
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      expect(screen.getByTestId('relay-diagnostic-panel')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0)
    expect(screen.getByText('Relay degraded')).toBeInTheDocument()
    expect(screen.getByText('/api/sophia/voice/dogfood/gemini/relay')).toBeInTheDocument()
    expect(screen.getByText('serverContent.modelTurn.inlineData.audio')).toBeInTheDocument()
    expect(screen.getByText('No browser-visible response')).toBeInTheDocument()
    expect(screen.getByText('open (open)')).toBeInTheDocument()
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    expect(screen.queryByText('Connection error')).not.toBeInTheDocument()
  })

  it('shows lifecycle execution rejection separately from relay transport failure', async () => {
    connectMock.mockImplementation(async ({ onStage, onRelayStatus, onToolLoopDiagnostic }: {
      onStage?: (stage: string) => void
      onRelayStatus?: (status: string) => void
      onToolLoopDiagnostic?: (diagnostic: unknown) => void
    }) => {
      onStage?.('connected')
      onRelayStatus?.('active')
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.000Z').toISOString(),
        phase: 'backend_accepted_tool_call',
        toolCall: { id: 'builder-call-1', name: 'start_builder_task', args: null, argsPreview: '{}' },
        success: true,
        resultSummary: 'Existing Sophia builder task launched: builder-thread-1.',
        taskId: 'builder-thread-1',
        taskStatus: 'running',
        trackedTaskIds: ['builder-thread-1'],
        backendResponse: { task_id: 'builder-thread-1', status: 'running' },
        errorText: null,
      })
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.005Z').toISOString(),
        phase: 'tool_call_received',
        toolCall: { id: 'check-call-1', name: 'check_async_task', args: { task_id: '789654321' }, argsPreview: '{"task_id":"789654321"}' },
        success: null,
        resultSummary: null,
        taskId: '789654321',
        taskStatus: null,
        trackedTaskIds: [],
        backendResponse: null,
        errorText: null,
      })
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.010Z').toISOString(),
        phase: 'tool_execution_rejected',
        toolCall: { id: 'check-call-1', name: 'check_async_task', args: null, argsPreview: '{}' },
        success: false,
        resultSummary: "Lifecycle tool rejected: no tracked task exists for task_id '789654321'.",
        taskId: '789654321',
        taskStatus: 'rejected',
        trackedTaskIds: ['builder-thread-1'],
        rejectionReason: 'unknown_task_id',
        recoveryGuidance: 'Do not invent task ids. Call start_builder_task first or list_async_tasks.',
        backendResponse: { ok: false, task_id: '789654321', tracked_task_ids: ['builder-thread-1'] },
        errorText: "No tracked task exists for task_id '789654321' in this trusted Gemini dogfood session.",
      })
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.020Z').toISOString(),
        phase: 'tool_response_sent',
        toolCall: { id: 'check-call-1', name: 'check_async_task', args: null, argsPreview: '{}' },
        success: true,
        resultSummary: "Lifecycle tool rejected: no tracked task exists for task_id '789654321'.",
        taskId: '789654321',
        taskStatus: 'rejected',
        trackedTaskIds: ['builder-thread-1'],
        rejectionReason: 'unknown_task_id',
        recoveryGuidance: 'Do not invent task ids. Call start_builder_task first or list_async_tasks.',
        backendResponse: { ok: false, task_id: '789654321', tracked_task_ids: ['builder-thread-1'] },
        errorText: null,
      })

      return {
        userId: 'user-1',
        sessionId: 'browser-gemini-1',
        streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
        websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
        relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
        publicEventBoundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
        setup: { tools: [{ functionDeclarations: [{ name: 'start_builder_task' }, { name: 'check_async_task' }] }] },
        setupComplete: true,
        websocket: {} as WebSocket,
        localStream: {} as MediaStream,
        sendText: vi.fn(),
        close: vi.fn(async () => undefined),
      }
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getAllByText('Execution rejected').length).toBeGreaterThan(0))
    expect(screen.getAllByText('builder-thread-1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('789654321').length).toBeGreaterThan(0)
    const trackedTaskRow = screen.getByText('Tracked task ids').parentElement
    expect(trackedTaskRow).not.toBeNull()
    expect(within(trackedTaskRow as HTMLElement).getByText('builder-thread-1')).toBeInTheDocument()
    expect(within(trackedTaskRow as HTMLElement).queryByText('789654321')).not.toBeInTheDocument()
    expect(screen.getByText(/unknown_task_id/)).toBeInTheDocument()
    expect(screen.getByText('Do not invent task ids. Call start_builder_task first or list_async_tasks.')).toBeInTheDocument()
    expect(screen.queryByText('Relay degraded')).not.toBeInTheDocument()
  })

  it('keeps the successful start task id after later lifecycle diagnostics cap the rolling log', async () => {
    connectMock.mockImplementation(async ({ onStage, onRelayStatus, onToolLoopDiagnostic }: {
      onStage?: (stage: string) => void
      onRelayStatus?: (status: string) => void
      onToolLoopDiagnostic?: (diagnostic: unknown) => void
    }) => {
      onStage?.('connected')
      onRelayStatus?.('active')
      onToolLoopDiagnostic?.({
        timestamp: new Date('2026-05-19T02:00:00.000Z').toISOString(),
        phase: 'backend_accepted_tool_call',
        toolCall: { id: 'builder-call-1', name: 'start_builder_task', args: null, argsPreview: '{}' },
        success: true,
        resultSummary: 'Existing Sophia builder task launched: builder-thread-persist.',
        taskId: 'builder-thread-persist',
        taskStatus: 'running',
        trackedTaskIds: ['builder-thread-persist'],
        backendResponse: { task_id: 'builder-thread-persist', status: 'running' },
        errorText: null,
      })

      for (let index = 0; index < 13; index += 1) {
        onToolLoopDiagnostic?.({
          timestamp: new Date(`2026-05-19T02:00:${String(index + 1).padStart(2, '0')}.000Z`).toISOString(),
          phase: 'backend_accepted_tool_call',
          toolCall: { id: `check-call-${index}`, name: 'check_async_task', args: null, argsPreview: '{}' },
          success: true,
          resultSummary: `Builder task builder-thread-persist is running (${index}).`,
          taskId: 'builder-thread-persist',
          taskStatus: 'running',
          trackedTaskIds: ['builder-thread-persist'],
          backendResponse: { task_id: 'builder-thread-persist', status: 'running' },
          errorText: null,
        })
      }

      return {
        userId: 'user-1',
        sessionId: 'browser-gemini-1',
        streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
        websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
        relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
        publicEventBoundary: 'SophiaEventNormalizer',
        transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
        setup: { tools: [{ functionDeclarations: [{ name: 'start_builder_task' }, { name: 'check_async_task' }] }] },
        setupComplete: true,
        websocket: {} as WebSocket,
        localStream: {} as MediaStream,
        sendText: vi.fn(),
        close: vi.fn(async () => undefined),
      }
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getByText('browser-gemini-1')).toBeInTheDocument())
    const lastStartRow = screen.getByText('Last start task id').parentElement
    expect(lastStartRow).not.toBeNull()
    expect(within(lastStartRow as HTMLElement).getByText('builder-thread-persist')).toBeInTheDocument()
    expect(within(lastStartRow as HTMLElement).queryByText('No successful start_builder_task yet')).not.toBeInTheDocument()
  })

  it('closes the helper connection and EventSource on disconnect', async () => {
    const closeMock = vi.fn(async () => undefined)

    connectMock.mockResolvedValue({
      userId: 'user-1',
      sessionId: 'browser-gemini-1',
      streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
      websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
      relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
      publicEventBoundary: 'SophiaEventNormalizer',
      transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
      setup: {},
      setupComplete: true,
      websocket: {} as WebSocket,
      localStream: {} as MediaStream,
      sendText: vi.fn(),
      close: closeMock,
    })

    render(<GeminiRealtimeDogfoodPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1))
    expect(MockEventSource.instances[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('shows incoming sophia events in the compact event log', async () => {
    connectMock.mockResolvedValue({
      userId: 'user-1',
      sessionId: 'browser-gemini-1',
      streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
      websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
      relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
      publicEventBoundary: 'SophiaEventNormalizer',
      transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
      setup: {},
      setupComplete: true,
      websocket: {} as WebSocket,
      localStream: {} as MediaStream,
      sendText: vi.fn(),
      close: vi.fn(async () => undefined),
    })

    render(<GeminiRealtimeDogfoodPage />)

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
    connectMock.mockResolvedValue({
      userId: 'user-1',
      sessionId: 'browser-gemini-1',
      streamUrl: '/api/sophia/user-1/voice/dogfood/gemini/events?session_id=browser-gemini-1',
      websocketUrl: 'wss://gemini.example/live?access_token=auth_tokens%2Fgemini-browser-test',
      relayUrl: '/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events',
      publicEventBoundary: 'SophiaEventNormalizer',
      transport: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
      setup: {},
      setupComplete: true,
      websocket: {} as WebSocket,
      localStream: {} as MediaStream,
      sendText: vi.fn(),
      close: vi.fn(async () => undefined),
    })

    render(<GeminiRealtimeDogfoodPage />)

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
})