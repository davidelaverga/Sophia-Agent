'use client'

import {
  Activity,
  AlertTriangle,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Wrench,
  Mic,
  PlugZap,
  Radio,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  connectGeminiBrowserLiveDogfood,
  isGeminiSetupCompleteMessage,
  readGeminiConfiguredToolNames,
  type GeminiBrowserLiveDogfoodConnection,
  type GeminiBrowserLiveDogfoodRelayDiagnostic,
  type GeminiBrowserLiveDogfoodRelayStatus,
  type GeminiBrowserLiveDogfoodStage,
  type GeminiBrowserLiveDogfoodToolLoopDiagnostic,
  type GeminiBrowserLiveDogfoodWebSocketDiagnostic,
} from '@/app/lib/gemini-browser-live-websocket-dogfood'
import { cn, createMessageId } from '@/app/lib/utils'
import { useAuth } from '@/app/providers'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error'
type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
type MicrophoneStatus = 'idle' | 'waiting' | 'granted' | 'connected' | 'error'
type RemoteAudioStatus = 'idle' | 'expected' | 'active'
type GeminiWebSocketStatus = 'idle' | 'connecting' | 'setup_pending' | 'setup_complete' | 'connected' | 'error' | 'closed'
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

type EventLogEntry = {
  id: string
  type: string
  receivedAt: string
  payload: Record<string, unknown> | null
  preview: string
}

type PageRelayDiagnostic = GeminiBrowserLiveDogfoodRelayDiagnostic & {
  publicSseConnected: boolean
}

type ToolLoopSessionSnapshot = {
  lastSuccessfulStartTaskId: string | null
  trackedTaskIds: string[]
}

const INTERNAL_DOGFOOD_ENABLED = process.env.NODE_ENV !== 'production'
const EVENT_LOG_LIMIT = 100
const SOPHIA_EVENT_TYPES = [
  'sophia.user_transcript',
  'sophia.turn',
  'sophia.transcript',
  'sophia.artifact',
  'sophia.builder_task',
  'sophia.turn_diagnostic',
] as const

const STAGE_LABELS: Record<GeminiBrowserLiveDogfoodStage, string> = {
  starting_backend_session: 'Starting backend session',
  requesting_microphone: 'Waiting for microphone permission',
  opening_websocket: 'Opening Gemini Live WebSocket',
  sending_setup: 'Sending locked setup payload',
  waiting_setup_complete: 'Waiting for setupComplete',
  connected: 'Connected',
  streaming_audio: 'Streaming microphone audio',
  closing: 'Disconnecting',
  closed: 'Closed',
}

export default function GeminiRealtimeDogfoodPage() {
  const { user, loading } = useAuth()
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('disconnected')
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>('idle')
  const [remoteAudioStatus, setRemoteAudioStatus] = useState<RemoteAudioStatus>('idle')
  const [websocketStatus, setWebsocketStatus] = useState<GeminiWebSocketStatus>('idle')
  const [relayStatus, setRelayStatus] = useState<GeminiBrowserLiveDogfoodRelayStatus>('disconnected')
  const [stage, setStage] = useState<GeminiBrowserLiveDogfoodStage | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [websocketUrl, setWebsocketUrl] = useState<string | null>(null)
  const [relayUrl, setRelayUrl] = useState<string | null>(null)
  const [transport, setTransport] = useState<string | null>(null)
  const [publicEventBoundary, setPublicEventBoundary] = useState<string | null>(null)
  const [setupCompleteReached, setSetupCompleteReached] = useState(false)
  const [relayDiagnostic, setRelayDiagnostic] = useState<PageRelayDiagnostic | null>(null)
  const [webSocketDiagnostic, setWebSocketDiagnostic] = useState<GeminiBrowserLiveDogfoodWebSocketDiagnostic | null>(null)
  const [configuredToolNames, setConfiguredToolNames] = useState<string[]>([])
  const [toolLoopDiagnostics, setToolLoopDiagnostics] = useState<GeminiBrowserLiveDogfoodToolLoopDiagnostic[]>([])
  const [toolLoopSnapshot, setToolLoopSnapshot] = useState<ToolLoopSessionSnapshot>(createEmptyToolLoopSessionSnapshot)
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([])
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const connectionRef = useRef<GeminiBrowserLiveDogfoodConnection | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const isMountedRef = useRef(false)
  const streamStatusRef = useRef<StreamStatus>('disconnected')

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      eventSourceRef.current?.close()
      eventSourceRef.current = null

      const activeConnection = connectionRef.current
      connectionRef.current = null
      if (activeConnection) {
        void activeConnection.close().catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    streamStatusRef.current = streamStatus
  }, [streamStatus])

  const clearEventStream = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const appendEvent = useCallback((eventType: string, rawData: string) => {
    if (!eventType.startsWith('sophia.')) {
      return
    }

    const payload = safeParseEventPayload(rawData)
    const entry: EventLogEntry = {
      id: createMessageId(),
      type: eventType,
      receivedAt: new Date().toLocaleTimeString(),
      payload,
      preview: buildPayloadPreview(eventType, payload),
    }

    setEventLog((current) => [entry, ...current].slice(0, EVENT_LOG_LIMIT))
  }, [])

  const openEventStream = useCallback((nextStreamUrl: string) => {
    clearEventStream()
    setStreamStatus('connecting')

    const eventSource = new EventSource(nextStreamUrl)
    eventSourceRef.current = eventSource

    eventSource.onopen = () => {
      if (!isMountedRef.current) {
        return
      }
      setStreamStatus('connected')
    }

    eventSource.onerror = () => {
      if (!isMountedRef.current || !connectionRef.current) {
        return
      }
      setStreamStatus('error')
    }

    for (const eventType of SOPHIA_EVENT_TYPES) {
      eventSource.addEventListener(eventType, (event) => {
        if (!isMountedRef.current || !(event instanceof MessageEvent)) {
          return
        }
        appendEvent(eventType, String(event.data ?? ''))
      })
    }
  }, [appendEvent, clearEventStream])

  const handleProviderEvent = useCallback((event: unknown) => {
    if (!isMountedRef.current) {
      return
    }

    if (isGeminiSetupCompleteMessage(event)) {
      setSetupCompleteReached(true)
      setWebsocketStatus((current) => (current === 'connected' ? 'connected' : 'setup_complete'))
    }
  }, [])

  const handleStage = useCallback((nextStage: GeminiBrowserLiveDogfoodStage) => {
    if (!isMountedRef.current) {
      return
    }

    setStage(nextStage)

    if (nextStage === 'starting_backend_session') {
      setWebsocketStatus('idle')
      setRelayStatus('disconnected')
      return
    }

    if (nextStage === 'requesting_microphone') {
      setMicrophoneStatus('waiting')
      return
    }

    if (nextStage === 'opening_websocket') {
      setMicrophoneStatus('granted')
      setWebsocketStatus('connecting')
      return
    }

    if (nextStage === 'sending_setup' || nextStage === 'waiting_setup_complete') {
      setMicrophoneStatus('granted')
      setWebsocketStatus('setup_pending')
      return
    }

    if (nextStage === 'connected' || nextStage === 'streaming_audio') {
      setConnectionStatus('connected')
      setMicrophoneStatus('connected')
      setWebsocketStatus('connected')
      setRemoteAudioStatus((current) => (current === 'active' ? 'active' : 'expected'))
      return
    }

    if (nextStage === 'closing') {
      setConnectionStatus('disconnecting')
      return
    }

    if (nextStage === 'closed') {
      setStreamStatus('disconnected')
      setRemoteAudioStatus('idle')
      setMicrophoneStatus('idle')
      setWebsocketStatus('closed')
      setRelayStatus('disconnected')
      if (connectionStatus !== 'error') {
        setConnectionStatus('disconnected')
      }
    }
  }, [connectionStatus])

  const handleRelayStatus = useCallback((status: GeminiBrowserLiveDogfoodRelayStatus) => {
    if (!isMountedRef.current) {
      return
    }
    setRelayStatus(status)
  }, [])

  const handleRelayDiagnostic = useCallback((diagnostic: GeminiBrowserLiveDogfoodRelayDiagnostic) => {
    if (!isMountedRef.current) {
      return
    }

    setRelayDiagnostic({
      ...diagnostic,
      publicSseConnected: streamStatusRef.current === 'connected',
    })
    setRelayStatus(diagnostic.terminal ? 'terminal_error' : 'degraded')
    if (diagnostic.terminal) {
      setErrorMessage(diagnostic.errorText)
    }
  }, [])

  const handleWebSocketDiagnostic = useCallback((diagnostic: GeminiBrowserLiveDogfoodWebSocketDiagnostic) => {
    if (!isMountedRef.current) {
      return
    }

    setWebSocketDiagnostic(diagnostic)
  }, [])

  const handleToolLoopDiagnostic = useCallback((diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic) => {
    if (!isMountedRef.current) {
      return
    }

    setToolLoopDiagnostics((current) => [diagnostic, ...current].slice(0, 12))
    setToolLoopSnapshot((current) => updateToolLoopSessionSnapshot(current, diagnostic))
  }, [])

  const handleConnect = useCallback(async () => {
    if (!INTERNAL_DOGFOOD_ENABLED) {
      setErrorMessage('This internal dogfood page is disabled in production builds.')
      return
    }

    if (!user?.id) {
      setErrorMessage('Sign into Sophia first or enable the local dev auth bypass before starting Gemini dogfood.')
      return
    }

    setErrorMessage(null)
    setEventLog([])
    setExpandedEntries(new Set())
    setStage('starting_backend_session')
    setConnectionStatus('connecting')
    setStreamStatus('disconnected')
    setMicrophoneStatus('idle')
    setRemoteAudioStatus('idle')
    setWebsocketStatus('idle')
    setRelayStatus('disconnected')
    setSetupCompleteReached(false)
    setSessionId(null)
    setStreamUrl(null)
    setWebsocketUrl(null)
    setRelayUrl(null)
    setTransport(null)
    setPublicEventBoundary(null)
    setRelayDiagnostic(null)
    setWebSocketDiagnostic(null)
    setConfiguredToolNames([])
    setToolLoopDiagnostics([])
    setToolLoopSnapshot(createEmptyToolLoopSessionSnapshot())

    try {
      const connection = await connectGeminiBrowserLiveDogfood({
        userId: user.id,
        onStage: handleStage,
        onProviderEvent: handleProviderEvent,
        onRelayStatus: handleRelayStatus,
        onRelayDiagnostic: handleRelayDiagnostic,
        onWebSocketDiagnostic: handleWebSocketDiagnostic,
        onToolLoopDiagnostic: handleToolLoopDiagnostic,
        onOutputAudio: () => {
          if (!isMountedRef.current) {
            return
          }
          setRemoteAudioStatus('active')
        },
      })

      if (!isMountedRef.current) {
        void connection.close().catch(() => undefined)
        return
      }

      connectionRef.current = connection
      setSessionId(connection.sessionId)
      setStreamUrl(connection.streamUrl)
      setWebsocketUrl(connection.websocketUrl)
      setRelayUrl(connection.relayUrl)
      setTransport(connection.transport)
      setPublicEventBoundary(connection.publicEventBoundary)
      setConfiguredToolNames(readGeminiConfiguredToolNames(connection.setup))
      setSetupCompleteReached(connection.setupComplete)
      openEventStream(connection.streamUrl)
    } catch (error) {
      if (!isMountedRef.current) {
        return
      }

      connectionRef.current = null
      clearEventStream()
      setConnectionStatus('error')
      setStreamStatus('disconnected')
      setRemoteAudioStatus('idle')
      setMicrophoneStatus((current) => (current === 'waiting' ? 'error' : current))
      setWebsocketStatus((current) => (current === 'idle' ? 'idle' : 'error'))
      setErrorMessage(toErrorMessage(error))
    }
  }, [clearEventStream, handleProviderEvent, handleRelayDiagnostic, handleRelayStatus, handleStage, handleToolLoopDiagnostic, handleWebSocketDiagnostic, openEventStream, user?.id])

  const handleDisconnect = useCallback(async () => {
    const activeConnection = connectionRef.current
    if (!activeConnection) {
      return
    }

    setErrorMessage(null)
    setConnectionStatus('disconnecting')
    clearEventStream()
    setStreamStatus('disconnected')
    setRelayStatus('disconnected')
    setRelayDiagnostic(null)

    connectionRef.current = null

    try {
      await activeConnection.close()
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(error))
        setConnectionStatus('error')
        setWebsocketStatus('error')
      }
      return
    }

    if (!isMountedRef.current) {
      return
    }

    setConnectionStatus('disconnected')
    setStage('closed')
    setRemoteAudioStatus('idle')
    setMicrophoneStatus('idle')
    setWebsocketStatus('closed')
  }, [clearEventStream])

  const toggleExpandedEntry = useCallback((entryId: string) => {
    setExpandedEntries((current) => {
      const next = new Set(current)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }, [])

  const connectionTone = useMemo<Tone>(() => {
    if (connectionStatus === 'connected') return 'success'
    if (connectionStatus === 'connecting' || connectionStatus === 'disconnecting') return 'accent'
    if (connectionStatus === 'error') return 'danger'
    return 'neutral'
  }, [connectionStatus])

  const streamTone = useMemo<Tone>(() => {
    if (streamStatus === 'connected') return 'success'
    if (streamStatus === 'connecting') return 'accent'
    if (streamStatus === 'error') return 'danger'
    return 'neutral'
  }, [streamStatus])

  const microphoneTone = useMemo<Tone>(() => {
    if (microphoneStatus === 'connected') return 'success'
    if (microphoneStatus === 'granted') return 'accent'
    if (microphoneStatus === 'waiting') return 'warning'
    if (microphoneStatus === 'error') return 'danger'
    return 'neutral'
  }, [microphoneStatus])

  const remoteAudioTone = useMemo<Tone>(() => {
    if (remoteAudioStatus === 'active') return 'success'
    if (remoteAudioStatus === 'expected') return 'accent'
    return 'neutral'
  }, [remoteAudioStatus])

  const websocketTone = useMemo<Tone>(() => {
    if (websocketStatus === 'connected' || websocketStatus === 'setup_complete') return 'success'
    if (websocketStatus === 'connecting' || websocketStatus === 'setup_pending') return 'accent'
    if (websocketStatus === 'error') return 'danger'
    if (websocketStatus === 'closed') return 'warning'
    return 'neutral'
  }, [websocketStatus])

  const relayTone = useMemo<Tone>(() => {
    if (relayStatus === 'active') return 'success'
    if (relayStatus === 'degraded') return 'warning'
    if (relayStatus === 'terminal_error') return 'danger'
    return 'neutral'
  }, [relayStatus])

  const setupTone = useMemo<Tone>(() => {
    if (setupCompleteReached) return 'success'
    if (websocketStatus === 'setup_pending' || websocketStatus === 'connecting') return 'accent'
    if (connectionStatus === 'error') return 'danger'
    return 'neutral'
  }, [connectionStatus, setupCompleteReached, websocketStatus])

  const lastToolCall = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.phase === 'tool_call_received') ?? null
  }, [toolLoopDiagnostics])

  const lastBackendToolResult = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.phase === 'backend_accepted_tool_call' || diagnostic.phase === 'tool_execution_rejected') ?? null
  }, [toolLoopDiagnostics])

  const lastToolResponse = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.phase === 'tool_response_sent' || diagnostic.phase === 'tool_response_send_failed') ?? null
  }, [toolLoopDiagnostics])

  const lastToolLoopError = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.errorText) ?? null
  }, [toolLoopDiagnostics])

  const lastTaskDiagnostic = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.taskId || diagnostic.taskStatus) ?? null
  }, [toolLoopDiagnostics])

  const lastSuccessfulStartTaskId = toolLoopSnapshot.lastSuccessfulStartTaskId
  const trackedTaskIds = toolLoopSnapshot.trackedTaskIds

  const lastLifecycleDiagnostic = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => isLifecycleToolName(diagnostic.toolCall.name)) ?? null
  }, [toolLoopDiagnostics])

  const lastExecutionRejection = useMemo(() => {
    return toolLoopDiagnostics.find((diagnostic) => diagnostic.phase === 'tool_execution_rejected') ?? null
  }, [toolLoopDiagnostics])

  const toolResponseTone = useMemo<Tone>(() => {
    if (!lastToolResponse) return 'neutral'
    return lastToolResponse.phase === 'tool_response_sent' ? 'success' : 'warning'
  }, [lastToolResponse])

  const canConnect = Boolean(
    INTERNAL_DOGFOOD_ENABLED
      && user?.id
      && connectionStatus !== 'connecting'
      && connectionStatus !== 'connected'
      && connectionStatus !== 'disconnecting',
  )
  const canDisconnect = Boolean(connectionRef.current) && (connectionStatus === 'connected' || connectionStatus === 'connecting' || connectionStatus === 'error')
  const showRuntimeChecklist = shouldShowRuntimeChecklist(errorMessage)

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(77,148,187,0.16),_transparent_34%),linear-gradient(180deg,var(--bg)_0%,rgba(228,244,247,0.78)_100%)] text-sophia-text">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <SectionCard className="overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(94,166,205,0.2),_transparent_38%)]" aria-hidden="true" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Internal experimental path" tone="warning" />
                <StatusPill label="Browser-owned Gemini WSS + backend relay" tone="accent" />
                <StatusPill label="Gemini runtime env required" tone="accent" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-sophia-text">Gemini Live Dogfood</h1>
                <p className="max-w-3xl text-sm leading-6 text-sophia-text2 sm:text-base">
                  Internal browser dogfood page for the existing Gemini Live WebSocket flow. The browser owns the
                  Gemini session, the backend relays server messages for normalized observation, and the page shows
                  only public sophia.* SSE events. This route requires the Gemini experimental runtime env to be
                  enabled on the voice service.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:min-w-[280px]">
              <MiniStatus label="Connection" value={formatConnectionStatus(connectionStatus)} tone={connectionTone} />
              <MiniStatus label="Public SSE" value={formatStreamStatus(streamStatus)} tone={streamTone} />
            </div>
          </div>
        </SectionCard>

        {!INTERNAL_DOGFOOD_ENABLED && (
          <AlertCard
            title="Internal dogfood is disabled here"
            message="This page is intentionally disabled in production builds. Use it from local development or an approved internal environment only."
          />
        )}

        {!loading && !user && (
          <AlertCard
            title="User session required"
            message="This page needs an authenticated Sophia user id so the protected /api/sophia/{userId}/voice/dogfood/gemini/* routes can authorize the request. Sign in through the main app or enable the local dev auth bypass first."
          />
        )}

        {errorMessage && (
          <AlertCard title="Connection error" message={errorMessage} />
        )}

        {showRuntimeChecklist && (
          <SectionCard>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-sophia-error" />
              <div className="space-y-3">
                <div>
                  <h2 className="text-lg font-semibold text-sophia-text">Runtime checklist</h2>
                  <p className="mt-1 text-sm text-sophia-text2">
                    The backend rejected the dogfood path. When the error is a runtime conflict, the usual missing
                    pieces are below.
                  </p>
                </div>
                <ul className="space-y-2 text-sm text-sophia-text2">
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_RUNTIME_MODE=gemini_live</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED=true</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">GOOGLE_API_KEY or GEMINI_API_KEY configured on the voice service</li>
                </ul>
              </div>
            </div>
          </SectionCard>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="grid gap-6">
            <SectionCard>
              <SectionHeader
                icon={PlugZap}
                title="Connect controls"
                description="Start or stop the protected Gemini browser Live dogfood flow."
              />

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleConnect()}
                  disabled={!canConnect}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-medium text-white shadow-md transition-all',
                    canConnect
                      ? 'bg-[#2f7e91] hover:scale-[1.01] hover:shadow-lg active:scale-[0.99]'
                      : 'cursor-not-allowed bg-[#2f7e91]/45',
                  )}
                >
                  <PlugZap className="h-4 w-4" />
                  {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
                </button>

                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={!canDisconnect}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 rounded-2xl border border-sophia-surface-border px-5 py-3 text-sm font-medium transition-all',
                    canDisconnect
                      ? 'bg-sophia-button text-sophia-text hover:border-[#2f7e91]/40 hover:bg-sophia-button-hover'
                      : 'cursor-not-allowed bg-sophia-surface text-sophia-text2/60',
                  )}
                >
                  <Radio className="h-4 w-4" />
                  {connectionStatus === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
                </button>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MiniStatus label="Current status" value={formatConnectionStatus(connectionStatus)} tone={connectionTone} />
                <MiniStatus label="Current stage" value={stage ? STAGE_LABELS[stage] : 'Idle'} tone={stage === 'connected' || stage === 'streaming_audio' ? 'success' : stage ? 'accent' : 'neutral'} />
                <MiniStatus label="Session id" value={sessionId ?? 'Not connected'} tone={sessionId ? 'accent' : 'neutral'} />
                <MiniStatus label="Setup complete" value={setupCompleteReached ? 'Reached' : 'Pending'} tone={setupTone} />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Mic}
                title="Session status"
                description="Microphone, browser audio, relay health, and normalized SSE visibility."
              />

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MiniStatus label="Microphone" value={formatMicrophoneStatus(microphoneStatus)} tone={microphoneTone} />
                <MiniStatus label="Remote audio" value={formatRemoteAudioStatus(remoteAudioStatus)} tone={remoteAudioTone} />
                <MiniStatus label="Backend relay" value={formatRelayStatus(relayStatus)} tone={relayTone} />
                <MiniStatus label="Public SSE" value={formatStreamStatus(streamStatus)} tone={streamTone} />
              </div>

              {relayDiagnostic && (
                <div data-testid="relay-diagnostic-panel" className="mt-5 rounded-3xl border border-amber-500/25 bg-amber-500/8 p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <StatusPill label={relayDiagnostic.terminal ? 'Relay terminal failure' : 'Relay degraded'} tone={relayDiagnostic.terminal ? 'danger' : 'warning'} />
                    <span className="text-xs text-sophia-text2">{new Date(relayDiagnostic.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <DetailRow label="Target path" value={relayDiagnostic.targetPath} mono />
                    <DetailRow label="Provider message" value={relayDiagnostic.eventType} mono />
                    <DetailRow label="HTTP response" value={relayDiagnostic.hasHttpResponse ? 'Received' : 'No browser-visible response'} />
                    <DetailRow label="Status" value={relayDiagnostic.statusCode === null ? 'Not available' : `${relayDiagnostic.statusCode} ${relayDiagnostic.statusText ?? ''}`.trim()} />
                    <DetailRow label="Gemini WSS after failure" value={`${relayDiagnostic.websocketState}${relayDiagnostic.websocketOpen ? ' (open)' : ''}`} />
                    <DetailRow label="Public SSE after failure" value={relayDiagnostic.publicSseConnected ? 'Connected' : 'Not connected'} />
                    <DetailRow label="Consecutive relay failures" value={String(relayDiagnostic.consecutiveFailures)} />
                    <DetailRow label="Request body bytes" value={String(relayDiagnostic.requestBodyBytes)} />
                  </div>
                  <div className="mt-3 rounded-2xl border border-sophia-surface-border bg-sophia-bg/70 px-4 py-3 text-sm text-sophia-text">
                    {relayDiagnostic.errorText}
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Activity}
                title="Gemini transport status"
                description="Gemini WSS lifecycle, setup handshake, and relay metadata for internal debugging."
              />

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MiniStatus label="Gemini WSS" value={formatGeminiWebSocketStatus(websocketStatus)} tone={websocketTone} />
                <MiniStatus label="Setup handshake" value={setupCompleteReached ? 'Complete' : 'Pending'} tone={setupTone} />
                <MiniStatus label="Relay session" value={formatRelayStatus(relayStatus)} tone={relayTone} />
                <MiniStatus label="Transport" value={transport ? 'Ready' : 'Pending'} tone={transport ? 'accent' : 'neutral'} />
              </div>

              <details className="group mt-5 rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 p-4">
                <summary className="cursor-pointer list-none text-sm font-medium text-sophia-text">
                  <span className="inline-flex items-center gap-2">
                    <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                    Transport details
                  </span>
                </summary>
                <div className="mt-4 grid gap-3 text-sm text-sophia-text2">
                  <DetailRow label="Stream URL" value={streamUrl ?? 'Not available yet'} mono />
                  <DetailRow label="WebSocket URL" value={websocketUrl ?? 'Not available yet'} mono />
                  <DetailRow label="Relay URL" value={relayUrl ?? 'Not available yet'} mono />
                  <DetailRow label="Public event boundary" value={publicEventBoundary ?? 'SophiaEventNormalizer'} />
                  <DetailRow label="Transport label" value={transport ?? 'Not available yet'} mono />
                  {webSocketDiagnostic && (
                    <DetailRow label="Last Gemini WSS diagnostic" value={formatWebSocketDiagnostic(webSocketDiagnostic)} />
                  )}
                </div>
              </details>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Radio}
                title="Public event log"
                description="Only normalized sophia.* events from the SSE stream are shown here. Raw Gemini provider messages never enter this public log."
              />

              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3 text-sm text-sophia-text2">
                <span>Newest events first. Log is capped to the latest {EVENT_LOG_LIMIT} entries.</span>
                <StatusPill label={formatStreamStatus(streamStatus)} tone={streamTone} />
              </div>

              <div className="mt-5 max-h-[38rem] overflow-y-auto pr-1">
                {eventLog.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-sophia-surface-border bg-sophia-bg/40 px-5 py-8 text-sm text-sophia-text2">
                    Connect first, then the newest normalized sophia.* events will appear here.
                  </div>
                ) : (
                  <ol className="space-y-3">
                    {eventLog.map((entry) => {
                      const isExpanded = expandedEntries.has(entry.id)

                      return (
                        <li
                          key={entry.id}
                          data-testid="dogfood-event-entry"
                          className="rounded-3xl border border-sophia-surface-border bg-sophia-surface/80 p-4 shadow-soft"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <StatusPill label={entry.type} tone="accent" />
                                <span className="text-xs text-sophia-text2">{entry.receivedAt}</span>
                              </div>
                              <p className="text-sm text-sophia-text">{entry.preview}</p>
                            </div>

                            <button
                              type="button"
                              onClick={() => toggleExpandedEntry(entry.id)}
                              className="inline-flex items-center gap-1 self-start rounded-xl border border-sophia-surface-border bg-sophia-button px-3 py-1.5 text-xs font-medium text-sophia-text transition-colors hover:border-[#2f7e91]/40 hover:bg-sophia-button-hover"
                            >
                              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              {isExpanded ? 'Hide JSON' : 'Show JSON'}
                            </button>
                          </div>

                          {isExpanded && (
                            <pre className="mt-3 overflow-x-auto rounded-2xl bg-sophia-bg/80 p-3 text-[11px] leading-5 text-sophia-text2">
                              {JSON.stringify(entry.payload, null, 2)}
                            </pre>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-6 self-start">
            <SectionCard>
              <SectionHeader
                icon={Activity}
                title="Runtime preflight"
                description="What this page expects before Connect can succeed."
              />

              <div className="mt-5 grid gap-3 text-sm text-sophia-text2">
                <ChecklistRow label="Authenticated Sophia user id" detail={user?.id ?? (loading ? 'Loading...' : 'Missing')} ok={Boolean(user?.id)} />
                <ChecklistRow label="Gemini browser helper path" detail="frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts" ok />
                <ChecklistRow label="Protected Next proxy routes" detail="/api/sophia/{userId}/voice/dogfood/gemini/*" ok />
                <ChecklistRow label="Experimental voice runtime env" detail="Required on the voice service before connect will succeed" ok={showRuntimeChecklist ? false : true} />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Wrench}
                title="Tool loop"
                description="Backend-owned Gemini function calling bridge for dogfood validation."
              />

              <div className="mt-5 grid gap-3 text-sm text-sophia-text2">
                <DetailRow
                  label="Tools configured"
                  value={configuredToolNames.length ? configuredToolNames.join(', ') : 'Not observed yet'}
                />
                <DetailRow
                  label="Last tool call"
                  value={lastToolCall ? formatToolCallSummary(lastToolCall) : 'No tool call received yet'}
                />
                <DetailRow
                  label="Backend result"
                  value={lastBackendToolResult ? formatToolResultSummary(lastBackendToolResult) : 'No backend tool result yet'}
                />
                <DetailRow
                  label="Last start task id"
                  value={lastSuccessfulStartTaskId ?? 'No successful start_builder_task yet'}
                />
                <DetailRow
                  label="Task id"
                  value={lastTaskDiagnostic?.taskId ?? 'No builder task yet'}
                />
                <DetailRow
                  label="Tracked task ids"
                  value={trackedTaskIds.length ? trackedTaskIds.join(', ') : 'No tracked builder tasks yet'}
                />
                <DetailRow
                  label="Lifecycle task id"
                  value={lastLifecycleDiagnostic?.taskId ?? 'No lifecycle task id used yet'}
                />
                <DetailRow
                  label="Task status"
                  value={formatTaskStatusSummary(lastTaskDiagnostic)}
                />
                <DetailRow
                  label="Execution rejection"
                  value={lastExecutionRejection ? formatExecutionRejection(lastExecutionRejection) : 'None'}
                />
                <DetailRow
                  label="Recovery guidance"
                  value={lastExecutionRejection?.recoveryGuidance ?? 'No recovery guidance returned yet'}
                />
                <DetailRow
                  label="Tool response sent"
                  value={lastToolResponse ? formatToolResponseSummary(lastToolResponse) : 'No toolResponse sent yet'}
                />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <StatusPill
                  label={configuredToolNames.length ? 'Tools configured' : 'Tools pending'}
                  tone={configuredToolNames.length ? 'success' : 'neutral'}
                />
                <StatusPill
                  label={lastToolResponse ? formatToolLoopPhase(lastToolResponse.phase) : 'Awaiting toolResponse'}
                  tone={toolResponseTone}
                />
                {lastExecutionRejection && (
                  <StatusPill label="Execution rejected" tone="warning" />
                )}
              </div>

              {lastToolLoopError && (
                <div className="mt-3 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-sophia-text">
                  {lastToolLoopError.errorText}
                </div>
              )}
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={AudioLines}
                title="Manual first smoke test"
                description="A quick operator script once the connection is up."
              />

              <ol className="mt-5 space-y-3 text-sm text-sophia-text2">
                <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">Say: Hola Sophia, me escuchas?</li>
                <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">Ask for one sentence.</li>
                <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">Say: Sophia, make a tiny reflection card about staying grounded today.</li>
                <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">Interrupt mid-response and watch the normalized turn diagnostics.</li>
              </ol>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={AlertTriangle}
                title="Safety notes"
                description="This page is deliberately scoped away from the production Stream voice UX."
              />

              <div className="mt-5 space-y-3 text-sm text-sophia-text2">
                <p>This route is for internal browser dogfooding only. It does not change the production /voice/connect path.</p>
                <p>The browser owns the Gemini WebSocket. Backend-owned tools run through the relay, and the browser only sends the returned Gemini toolResponse payload.</p>
                <p>If the runtime is not enabled, the page should fail clearly instead of implying Gemini Live is already a production voice mode.</p>
              </div>
            </SectionCard>
          </div>
        </div>
      </main>
    </div>
  )
}

function createEmptyToolLoopSessionSnapshot(): ToolLoopSessionSnapshot {
  return {
    lastSuccessfulStartTaskId: null,
    trackedTaskIds: [],
  }
}

function updateToolLoopSessionSnapshot(
  current: ToolLoopSessionSnapshot,
  diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic,
): ToolLoopSessionSnapshot {
  const lastSuccessfulStartTaskId = isSuccessfulBuilderStartDiagnostic(diagnostic)
    ? diagnostic.taskId
    : current.lastSuccessfulStartTaskId
  const trackedTaskIds = mergeUniqueStrings([
    ...current.trackedTaskIds,
    ...trustedTaskIdsFromDiagnostic(diagnostic),
  ])

  if (
    lastSuccessfulStartTaskId === current.lastSuccessfulStartTaskId
      && sameStringList(trackedTaskIds, current.trackedTaskIds)
  ) {
    return current
  }

  return {
    lastSuccessfulStartTaskId,
    trackedTaskIds,
  }
}

function isSuccessfulBuilderStartDiagnostic(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): diagnostic is GeminiBrowserLiveDogfoodToolLoopDiagnostic & { taskId: string } {
  return diagnostic.toolCall.name === 'start_builder_task'
    && diagnostic.success === true
    && typeof diagnostic.taskId === 'string'
    && diagnostic.taskId.trim().length > 0
    && !isRejectedTaskDiagnostic(diagnostic)
    && diagnostic.phase !== 'tool_response_send_failed'
    && diagnostic.phase !== 'tool_call_cancelled'
}

function trustedTaskIdsFromDiagnostic(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): string[] {
  const ids = [...(diagnostic.trackedTaskIds ?? [])]
  const taskId = typeof diagnostic.taskId === 'string' ? diagnostic.taskId.trim() : ''

  if (!taskId || isRejectedTaskDiagnostic(diagnostic)) {
    return ids
  }

  if (diagnostic.phase === 'tool_call_received' && isLifecycleToolName(diagnostic.toolCall.name)) {
    return ids
  }

  if (diagnostic.phase === 'tool_response_send_failed' || diagnostic.phase === 'tool_call_cancelled') {
    return ids
  }

  ids.push(taskId)
  return ids
}

function isRejectedTaskDiagnostic(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): boolean {
  return diagnostic.phase === 'tool_execution_rejected'
    || Boolean(diagnostic.rejectionReason)
    || diagnostic.backendResponse?.ok === false
}

function mergeUniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (normalized) {
      seen.add(normalized)
    }
  }
  return [...seen]
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('relative rounded-[28px] border border-sophia-surface-border bg-sophia-surface/88 p-6 shadow-soft backdrop-blur', className)}>
      {children}
    </section>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Activity
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#2f7e91]/12 text-[#2f7e91]">
        <Icon className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-sophia-text">{title}</h2>
        <p className="text-sm text-sophia-text2">{description}</p>
      </div>
    </div>
  )
}

function AlertCard({ title, message }: { title: string; message: string }) {
  return (
    <SectionCard>
      <div role="alert" className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sophia-error/10 text-sophia-error">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-sophia-text">{title}</h2>
          <p className="text-sm leading-6 text-sophia-text2">{message}</p>
        </div>
      </div>
    </SectionCard>
  )
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        tone === 'success' && 'bg-emerald-500/12 text-emerald-700',
        tone === 'accent' && 'bg-[#2f7e91]/12 text-[#245e6c]',
        tone === 'warning' && 'bg-amber-500/12 text-amber-700',
        tone === 'danger' && 'bg-rose-500/12 text-rose-700',
        tone === 'neutral' && 'bg-sophia-bg text-sophia-text2',
      )}
    >
      {label}
    </span>
  )
}

function MiniStatus({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-sophia-text2/75">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <StatusPill label={value} tone={tone} />
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl border border-sophia-surface-border bg-sophia-surface/80 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-sophia-text2/70">{label}</div>
      <div className={cn('mt-1 break-all text-sm text-sophia-text', mono && 'font-mono text-xs')}>{value}</div>
    </div>
  )
}

function ChecklistRow({ label, detail, ok }: { label: string; detail: string; ok: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">
      <div>
        <div className="text-sm font-medium text-sophia-text">{label}</div>
        <div className="mt-1 text-xs text-sophia-text2">{detail}</div>
      </div>
      <StatusPill label={ok ? 'Ready' : 'Needs attention'} tone={ok ? 'success' : 'warning'} />
    </div>
  )
}

function safeParseEventPayload(rawData: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawData)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function buildPayloadPreview(eventType: string, payload: Record<string, unknown> | null): string {
  const data = extractDataRecord(payload)

  if (eventType === 'sophia.turn') {
    const phase = asReadableString(data?.phase)
    if (phase) {
      return `turn phase: ${phase}`
    }
  }

  if (eventType === 'sophia.transcript' || eventType === 'sophia.user_transcript') {
    const text = asReadableString(data?.text) ?? asReadableString(data?.content)
    if (text) {
      return truncateText(text)
    }
  }

  if (eventType === 'sophia.artifact') {
    const takeaway = asReadableString(data?.takeaway) ?? asReadableString(data?.next_step)
    if (takeaway) {
      return truncateText(takeaway)
    }
  }

  if (eventType === 'sophia.turn_diagnostic') {
    const reason = asReadableString(data?.reason) ?? asReadableString(data?.status)
    if (reason) {
      return truncateText(reason)
    }
  }

  if (data) {
    return truncateText(JSON.stringify(data))
  }

  return 'No preview available'
}

function extractDataRecord(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) {
    return null
  }

  const candidate = payload.data
  return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : payload
}

function asReadableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function truncateText(value: string, maxLength: number = 160): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}...`
}

function shouldShowRuntimeChecklist(message: string | null): boolean {
  if (!message) {
    return false
  }

  return /(SOPHIA_VOICE_RUNTIME_MODE|SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED|SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED|GOOGLE_API_KEY|GEMINI_API_KEY|Gemini browser Live dogfood requires)/.test(message)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Gemini dogfood failed for an unknown reason.'
}

function formatConnectionStatus(status: ConnectionStatus): string {
  if (status === 'connecting') return 'Connecting'
  if (status === 'connected') return 'Connected'
  if (status === 'disconnecting') return 'Disconnecting'
  if (status === 'error') return 'Error'
  return 'Disconnected'
}

function formatStreamStatus(status: StreamStatus): string {
  if (status === 'connecting') return 'Connecting'
  if (status === 'connected') return 'Connected'
  if (status === 'error') return 'Error'
  return 'Disconnected'
}

function formatMicrophoneStatus(status: MicrophoneStatus): string {
  if (status === 'waiting') return 'Waiting for permission'
  if (status === 'granted') return 'Granted'
  if (status === 'connected') return 'Connected'
  if (status === 'error') return 'Blocked or failed'
  return 'Idle'
}

function formatRemoteAudioStatus(status: RemoteAudioStatus): string {
  if (status === 'expected') return 'Expected'
  if (status === 'active') return 'Active'
  return 'Idle'
}

function formatGeminiWebSocketStatus(status: GeminiWebSocketStatus): string {
  if (status === 'connecting') return 'Connecting'
  if (status === 'setup_pending') return 'Setup pending'
  if (status === 'setup_complete') return 'Setup complete'
  if (status === 'connected') return 'Connected'
  if (status === 'error') return 'Error'
  if (status === 'closed') return 'Closed'
  return 'Idle'
}

function formatRelayStatus(status: GeminiBrowserLiveDogfoodRelayStatus): string {
  if (status === 'active') return 'Active'
  if (status === 'degraded') return 'Degraded'
  if (status === 'terminal_error') return 'Terminal failure'
  return 'Disconnected'
}

function formatToolCallSummary(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): string {
  const parts = [
    diagnostic.toolCall.name ?? 'unknown_tool',
    diagnostic.toolCall.id ? `id ${diagnostic.toolCall.id}` : null,
    diagnostic.toolCall.argsPreview && diagnostic.toolCall.argsPreview !== '{}'
      ? `args ${diagnostic.toolCall.argsPreview}`
      : null,
  ].filter(Boolean)
  return parts.join(' | ')
}

function formatToolResultSummary(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): string {
  if (diagnostic.phase === 'tool_execution_rejected') {
    return `Rejected: ${diagnostic.resultSummary ?? diagnostic.errorText ?? 'Backend rejected the tool call.'}`
  }
  const status = diagnostic.success === false ? 'Failed' : 'Success'
  return `${status}: ${diagnostic.resultSummary ?? 'Backend accepted the tool call.'}`
}

function formatToolResponseSummary(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): string {
  if (diagnostic.phase === 'tool_response_sent') {
    return `Yes: ${diagnostic.toolCall.name ?? 'tool'} ${diagnostic.toolCall.id ?? ''}`.trim()
  }
  return `No: ${diagnostic.errorText ?? 'toolResponse send failed'}`
}

function formatTaskStatusSummary(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic | null): string {
  if (!diagnostic?.taskStatus) {
    return 'No builder status yet'
  }
  return diagnostic.taskId ? `${diagnostic.taskStatus} | ${diagnostic.taskId}` : diagnostic.taskStatus
}

function formatToolLoopPhase(phase: GeminiBrowserLiveDogfoodToolLoopDiagnostic['phase']): string {
  if (phase === 'tool_response_sent') return 'toolResponse sent'
  if (phase === 'tool_response_send_failed') return 'toolResponse failed'
  if (phase === 'backend_accepted_tool_call') return 'Backend accepted'
  if (phase === 'tool_execution_rejected') return 'Execution rejected'
  if (phase === 'tool_call_received') return 'Tool call received'
  return 'Tool call cancelled'
}

function formatExecutionRejection(diagnostic: GeminiBrowserLiveDogfoodToolLoopDiagnostic): string {
  const parts = [
    diagnostic.toolCall.name ?? 'tool',
    diagnostic.taskId ? `task ${diagnostic.taskId}` : null,
    diagnostic.rejectionReason ?? null,
  ].filter(Boolean)
  return parts.join(' | ') || diagnostic.errorText || 'Tool execution rejected'
}

function isLifecycleToolName(name: string | null): boolean {
  return name === 'check_async_task'
    || name === 'update_async_task'
    || name === 'cancel_async_task'
    || name === 'list_async_tasks'
}

function formatWebSocketDiagnostic(diagnostic: GeminiBrowserLiveDogfoodWebSocketDiagnostic): string {
  if (diagnostic.kind === 'error') {
    return `${diagnostic.message} Relay failure before event: ${diagnostic.relayFailureAlreadyObserved ? 'yes' : 'no'}.`
  }

  const closeDetails = [
    diagnostic.closeCode === null ? null : `code ${diagnostic.closeCode}`,
    diagnostic.closeReason ? `reason ${diagnostic.closeReason}` : null,
    diagnostic.wasClean === null ? null : diagnostic.wasClean ? 'clean' : 'unclean',
  ].filter(Boolean).join(', ')

  return `${diagnostic.message}${closeDetails ? ` ${closeDetails}.` : ''} Relay failure before close: ${diagnostic.relayFailureAlreadyObserved ? 'yes' : 'no'}.`
}