'use client'

import {
  Activity,
  AlertTriangle,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Mic,
  PlugZap,
  Radio,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  connectOpenAIBrowserDogfood,
  type OpenAIBrowserDogfoodConnection,
  type OpenAIBrowserDogfoodSidebandInfo,
  type OpenAIBrowserDogfoodStage,
  type OpenAIWebRTCCallDiagnostics,
} from '@/app/lib/openai-browser-webrtc-dogfood'
import { cn, createMessageId } from '@/app/lib/utils'
import { useAuth } from '@/app/providers'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error'
type StreamStatus = 'disconnected' | 'connecting' | 'connected' | 'unavailable' | 'error'
type MicrophoneStatus = 'idle' | 'waiting' | 'granted' | 'error'
type RemoteAudioStatus = 'idle' | 'expected' | 'active'
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

type EventLogEntry = {
  id: string
  type: string
  receivedAt: string
  payload: Record<string, unknown> | null
  preview: string
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

const STAGE_LABELS: Record<OpenAIBrowserDogfoodStage, string> = {
  starting_backend_session: 'Starting backend session',
  requesting_microphone: 'Waiting for microphone permission',
  creating_offer: 'Microphone granted',
  exchanging_sdp: 'Exchanging SDP with OpenAI',
  waiting_for_webrtc_ready: 'Waiting for WebRTC readiness',
  attaching_sideband: 'Attaching backend sideband',
  connected: 'Connected',
  closing: 'Disconnecting',
  closed: 'Closed',
}

export default function OpenAIRealtimeDogfoodPage() {
  const { user, loading } = useAuth()
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('disconnected')
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>('idle')
  const [remoteAudioStatus, setRemoteAudioStatus] = useState<RemoteAudioStatus>('idle')
  const [stage, setStage] = useState<OpenAIBrowserDogfoodStage | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [sidebandInfo, setSidebandInfo] = useState<OpenAIBrowserDogfoodSidebandInfo | null>(null)
  const [callDiagnostics, setCallDiagnostics] = useState<OpenAIWebRTCCallDiagnostics | null>(null)
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([])
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sidebandRetrying, setSidebandRetrying] = useState(false)

  const connectionRef = useRef<OpenAIBrowserDogfoodConnection | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const isMountedRef = useRef(false)

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
    const audioElement = remoteAudioRef.current
    if (!audioElement) {
      return
    }

    const markExpected = () => {
      if (!isMountedRef.current) {
        return
      }
      setRemoteAudioStatus((current) => (current === 'active' ? 'active' : connectionStatus === 'connected' ? 'expected' : 'idle'))
    }

    const markActive = () => {
      if (!isMountedRef.current) {
        return
      }
      setRemoteAudioStatus('active')
    }

    const markIdle = () => {
      if (!isMountedRef.current) {
        return
      }
      setRemoteAudioStatus(connectionStatus === 'connected' ? 'expected' : 'idle')
    }

    audioElement.addEventListener('loadeddata', markExpected)
    audioElement.addEventListener('canplay', markExpected)
    audioElement.addEventListener('playing', markActive)
    audioElement.addEventListener('pause', markIdle)
    audioElement.addEventListener('emptied', markIdle)

    return () => {
      audioElement.removeEventListener('loadeddata', markExpected)
      audioElement.removeEventListener('canplay', markExpected)
      audioElement.removeEventListener('playing', markActive)
      audioElement.removeEventListener('pause', markIdle)
      audioElement.removeEventListener('emptied', markIdle)
    }
  }, [connectionStatus])

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

  const handleStage = useCallback((nextStage: OpenAIBrowserDogfoodStage) => {
    if (!isMountedRef.current) {
      return
    }

    setStage(nextStage)

    if (nextStage === 'requesting_microphone') {
      setMicrophoneStatus('waiting')
      return
    }

    if (
      nextStage === 'creating_offer'
      || nextStage === 'exchanging_sdp'
      || nextStage === 'waiting_for_webrtc_ready'
      || nextStage === 'attaching_sideband'
    ) {
      setMicrophoneStatus('granted')
      return
    }

    if (nextStage === 'connected') {
      setConnectionStatus('connected')
      setMicrophoneStatus('granted')
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
      if (connectionStatus !== 'error') {
        setConnectionStatus('disconnected')
      }
    }
  }, [connectionStatus])

  const handleConnect = useCallback(async () => {
    if (!INTERNAL_DOGFOOD_ENABLED) {
      setErrorMessage('This internal dogfood page is disabled in production builds.')
      return
    }

    if (!user?.id) {
      setErrorMessage('Sign into Sophia first or enable the local dev auth bypass before starting OpenAI dogfood.')
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
    setSessionId(null)
    setCallId(null)
    setStreamUrl(null)
    setSidebandInfo(null)
    setCallDiagnostics(null)
    setSidebandRetrying(false)

    try {
      const connection = await connectOpenAIBrowserDogfood({
        userId: user.id,
        remoteAudioElement: remoteAudioRef.current,
        onStage: handleStage,
      })

      if (!isMountedRef.current) {
        void connection.close().catch(() => undefined)
        return
      }

      connectionRef.current = connection
      setSessionId(connection.sessionId)
      setCallId(connection.callId)
      setStreamUrl(connection.streamUrl)
      setSidebandInfo(connection.sideband)
      setCallDiagnostics(connection.callDiagnostics ?? connection.sideband.call_diagnostics ?? null)
      if (connection.sideband.attached) {
        openEventStream(connection.streamUrl)
      } else {
        clearEventStream()
        setStreamStatus('unavailable')
      }
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
      setErrorMessage(toErrorMessage(error))
    }
  }, [clearEventStream, handleStage, openEventStream, user?.id])

  const handleRetrySidebandAttach = useCallback(async () => {
    const activeConnection = connectionRef.current
    if (!activeConnection || !callId || sidebandInfo?.attached === true) {
      return
    }

    setErrorMessage(null)
    setSidebandRetrying(true)

    try {
      const nextSideband = await activeConnection.retrySidebandAttach({
        remoteAudioActive: remoteAudioStatus === 'active',
      })

      if (!isMountedRef.current || connectionRef.current !== activeConnection) {
        return
      }

      setSidebandInfo(nextSideband)
      setCallDiagnostics(activeConnection.callDiagnostics ?? nextSideband.call_diagnostics ?? null)

      if (nextSideband.attached) {
        openEventStream(activeConnection.streamUrl)
      } else {
        clearEventStream()
        setStreamStatus('unavailable')
      }
    } catch (error) {
      if (!isMountedRef.current || connectionRef.current !== activeConnection) {
        return
      }

      clearEventStream()
      setStreamStatus('unavailable')
      setSidebandInfo((current) => ({
        ...(current ?? {}),
        attached: false,
        attach_error: toErrorMessage(error),
      }))
    } finally {
      if (isMountedRef.current && connectionRef.current === activeConnection) {
        setSidebandRetrying(false)
      }
    }
  }, [callId, clearEventStream, openEventStream, remoteAudioStatus, sidebandInfo?.attached])

  const handleDisconnect = useCallback(async () => {
    const activeConnection = connectionRef.current
    if (!activeConnection) {
      return
    }

    setErrorMessage(null)
    setConnectionStatus('disconnecting')
    clearEventStream()
    setStreamStatus('disconnected')
    setSidebandRetrying(false)

    connectionRef.current = null

    try {
      await activeConnection.close()
    } catch (error) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(error))
        setConnectionStatus('error')
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
    if (streamStatus === 'unavailable') return 'warning'
    if (streamStatus === 'error') return 'danger'
    return 'neutral'
  }, [streamStatus])

  const microphoneTone = useMemo<Tone>(() => {
    if (microphoneStatus === 'granted') return 'success'
    if (microphoneStatus === 'waiting') return 'warning'
    if (microphoneStatus === 'error') return 'danger'
    return 'neutral'
  }, [microphoneStatus])

  const remoteAudioTone = useMemo<Tone>(() => {
    if (remoteAudioStatus === 'active') return 'success'
    if (remoteAudioStatus === 'expected') return 'accent'
    return 'neutral'
  }, [remoteAudioStatus])

  const canConnect = Boolean(INTERNAL_DOGFOOD_ENABLED && user?.id && connectionStatus !== 'connecting' && connectionStatus !== 'connected' && connectionStatus !== 'disconnecting')
  const canDisconnect = Boolean(connectionRef.current) && (connectionStatus === 'connected' || connectionStatus === 'connecting' || connectionStatus === 'error')
  const sidebandAttached = sidebandInfo?.attached === true
  const sidebandFailed = Boolean(sidebandInfo && !sidebandAttached)
  const isAudioOnlyDegraded = Boolean(connectionRef.current) && connectionStatus === 'connected' && !sidebandAttached
  const canRetrySidebandAttach = Boolean(connectionRef.current && callId && !sidebandAttached && connectionStatus === 'connected' && !sidebandRetrying)
  const sidebandStatusLabel = sidebandAttached ? 'Attached' : sidebandInfo?.attach_error ? 'Failed' : sidebandInfo ? 'Unavailable' : 'Pending'
  const sidebandTone: Tone = sidebandAttached ? 'success' : isAudioOnlyDegraded ? 'warning' : sidebandInfo ? 'danger' : 'neutral'
  const connectionModeLabel = isAudioOnlyDegraded
    ? 'Degraded audio-only'
    : sidebandAttached
      ? 'Full sideband observation'
      : connectionStatus === 'connected'
        ? 'Connecting sideband'
        : 'Idle'
  const connectionModeTone: Tone = isAudioOnlyDegraded ? 'warning' : sidebandAttached ? 'success' : connectionStatus === 'connected' ? 'accent' : 'neutral'
  const showRuntimeChecklist = shouldShowRuntimeChecklist(errorMessage)

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(124,92,170,0.18),_transparent_36%),linear-gradient(180deg,var(--bg)_0%,rgba(240,235,255,0.72)_100%)] text-sophia-text">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <SectionCard className="overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(157,124,201,0.22),_transparent_38%)]" aria-hidden="true" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Internal experimental path" tone="warning" />
                <StatusPill label="OpenAI runtime env required" tone="accent" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-sophia-text">OpenAI Realtime Dogfood</h1>
                <p className="max-w-3xl text-sm leading-6 text-sophia-text2 sm:text-base">
                  Internal browser dogfood page for the existing OpenAI Realtime WebRTC flow. This wraps the protected
                  browser helper, keeps production Stream voice untouched, and shows only normalized sophia.* public
                  events from the backend SSE boundary.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:min-w-[260px]">
              <MiniStatus label="Connection" value={formatConnectionStatus(connectionStatus)} tone={connectionTone} />
              <MiniStatus label="Mode" value={connectionModeLabel} tone={connectionModeTone} />
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
            message="This page needs an authenticated Sophia user id so the protected /api/sophia/{userId}/voice/dogfood/openai/* routes can authorize the request. Sign in through the main app or enable the local dev auth bypass first."
          />
        )}

        {errorMessage && (
          <AlertCard title="Connection error" message={errorMessage} />
        )}

        {isAudioOnlyDegraded && (
          <SectionCard>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold text-sophia-text">Degraded audio-only mode</h2>
                  <p className="max-w-3xl text-sm leading-6 text-sophia-text2">
                    Browser WebRTC is still live, so you can keep speaking with OpenAI Realtime for transport dogfood.
                    Sophia backend sideband control is currently unavailable, so normalized public SSE observation is
                    unavailable until sideband attach succeeds.
                  </p>
                  {sidebandInfo?.attach_error && (
                    <p className="rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 font-mono text-xs leading-5 text-sophia-text2">
                      {sidebandInfo.attach_error}
                    </p>
                  )}
                </div>
              </div>

              {canRetrySidebandAttach && (
                <button
                  type="button"
                  onClick={() => void handleRetrySidebandAttach()}
                  disabled={!canRetrySidebandAttach}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 self-start rounded-2xl px-5 py-3 text-sm font-medium text-white shadow-md transition-all',
                    canRetrySidebandAttach
                      ? 'bg-amber-600 hover:scale-[1.01] hover:shadow-lg active:scale-[0.99]'
                      : 'cursor-not-allowed bg-amber-600/45',
                  )}
                >
                  <Activity className="h-4 w-4" />
                  {sidebandRetrying ? 'Retrying sideband...' : 'Retry Sideband Attach'}
                </button>
              )}
            </div>
          </SectionCard>
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
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_RUNTIME_MODE=openai_realtime</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED=true</li>
                  <li className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-3 py-2 font-mono text-xs text-sophia-text">OPENAI_API_KEY configured on the voice service</li>
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
                description="Start or stop the protected browser WebRTC dogfood flow."
              />

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleConnect()}
                  disabled={!canConnect}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-medium text-white shadow-md transition-all',
                    canConnect
                      ? 'bg-sophia-purple hover:scale-[1.01] hover:shadow-lg active:scale-[0.99]'
                      : 'cursor-not-allowed bg-sophia-purple/45',
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
                      ? 'bg-sophia-button text-sophia-text hover:border-sophia-purple/40 hover:bg-sophia-button-hover'
                      : 'cursor-not-allowed bg-sophia-surface text-sophia-text2/60',
                  )}
                >
                  <Radio className="h-4 w-4" />
                  {connectionStatus === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
                </button>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MiniStatus label="Current status" value={formatConnectionStatus(connectionStatus)} tone={connectionTone} />
                <MiniStatus label="Current stage" value={stage ? STAGE_LABELS[stage] : 'Idle'} tone={stage === 'connected' ? 'success' : stage ? 'accent' : 'neutral'} />
                <MiniStatus label="Session id" value={sessionId ?? 'Not connected'} tone={sessionId ? 'accent' : 'neutral'} />
                <MiniStatus label="OpenAI call id" value={callId ?? 'Awaiting rtc_*'} tone={callId ? 'accent' : 'neutral'} />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Activity}
                title="Session status"
                description="Microphone, browser audio, sideband, and normalized SSE visibility."
              />

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MiniStatus label="Microphone" value={formatMicrophoneStatus(microphoneStatus)} tone={microphoneTone} />
                <MiniStatus label="Remote audio" value={formatRemoteAudioStatus(remoteAudioStatus)} tone={remoteAudioTone} />
                <MiniStatus label="Sideband attach" value={sidebandStatusLabel} tone={sidebandTone} />
                <MiniStatus label="Public SSE" value={formatStreamStatus(streamStatus)} tone={streamTone} />
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
                  <DetailRow label="Session mode" value={connectionModeLabel} />
                  <DetailRow label="Public event boundary" value={sidebandAttached ? (asReadableString(sidebandInfo?.public_event_boundary) ?? 'SophiaEventNormalizer') : 'Unavailable while sideband is detached'} />
                  <DetailRow label="Last sideband result" value={sidebandAttached ? 'Attached' : sidebandInfo?.attach_error ?? 'Not attached yet'} mono={sidebandFailed} />
                  <DetailRow label="Provider request id" value={sidebandInfo?.provider_request_id ?? 'Not captured yet'} mono />
                  <DetailRow label="Provider status" value={sidebandInfo?.provider_status_code == null ? 'Not captured yet' : String(sidebandInfo.provider_status_code)} />
                  <DetailRow label="Last attach attempt" value={formatAttemptTimestamp(sidebandInfo?.last_attach_attempt_at)} />
                  <DetailRow label="Session alive at last attach" value={formatElapsedSinceAttempt(sidebandInfo?.session_alive_ms_at_last_attempt)} />
                  <DetailRow label="Remote audio at last attach" value={formatRemoteAudioAttempt(sidebandInfo?.remote_audio_active_at_last_attempt)} />
                  <DetailRow label="WebRTC readiness" value={formatWebRTCReadiness(sidebandInfo?.webrtc_readiness)} />
                  <DetailRow label="Sideband URL" value={asReadableString(sidebandInfo?.sideband_url) ?? 'Not attached yet'} mono />
                  <DetailRow label="Requested model" value={callDiagnostics?.requested_model ?? 'Not captured yet'} mono />
                  <DetailRow label="SDP status" value={callDiagnostics?.sdp_status == null ? 'Not captured yet' : String(callDiagnostics.sdp_status)} />
                  <DetailRow label="Raw Location" value={callDiagnostics?.raw_location ?? 'Not captured yet'} mono />
                  <DetailRow label="Extracted call id" value={callDiagnostics?.extracted_call_id ?? 'Not captured yet'} mono />
                  <DetailRow label="Location shape" value={formatCallDiagnosticShape(callDiagnostics)} />
                  <DetailRow label="Location variant" value={callDiagnostics?.unexpected_location_variant ?? 'Documented shape'} mono />
                </div>
              </details>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Radio}
                title="Public event log"
                description="Only normalized sophia.* events from the SSE stream are shown here. Raw provider events stay on the backend sideband."
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
                              className="inline-flex items-center gap-1 self-start rounded-xl border border-sophia-surface-border bg-sophia-button px-3 py-1.5 text-xs font-medium text-sophia-text transition-colors hover:border-sophia-purple/40 hover:bg-sophia-button-hover"
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
                icon={Mic}
                title="Runtime preflight"
                description="What this page expects before Connect can succeed."
              />

              <div className="mt-5 grid gap-3 text-sm text-sophia-text2">
                <ChecklistRow label="Authenticated Sophia user id" detail={user?.id ?? (loading ? 'Loading...' : 'Missing')} ok={Boolean(user?.id)} />
                <ChecklistRow label="OpenAI browser helper path" detail="frontend/src/app/lib/openai-browser-webrtc-dogfood.ts" ok />
                <ChecklistRow label="Protected Next proxy routes" detail="/api/sophia/{userId}/voice/dogfood/openai/*" ok />
                <ChecklistRow label="Experimental voice runtime env" detail="Required on the voice service before connect will succeed" ok={showRuntimeChecklist ? false : true} />
              </div>
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
                <p>The UI subscribes only to normalized sophia.* SSE events. Raw OpenAI wire events stay behind the backend sideband and adapter boundary.</p>
                <p>If the runtime is not enabled, the page should fail clearly instead of pretending OpenAI is a production voice mode.</p>
              </div>
            </SectionCard>
          </div>
        </div>
      </main>
    </div>
  )
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
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sophia-purple/12 text-sophia-purple">
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
        tone === 'accent' && 'bg-sophia-purple/12 text-sophia-purple',
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

function formatWebRTCReadiness(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return 'Not measured yet'
  }

  const readiness = value as Record<string, unknown>
  const ready = readiness.ready === true ? 'ready' : 'not ready'
  const reason = asReadableString(readiness.reason) ?? 'unknown'
  const connectionState = asReadableString(readiness.connection_state) ?? 'unknown'
  const iceState = asReadableString(readiness.ice_connection_state) ?? 'unknown'
  const dataChannelState = asReadableString(readiness.data_channel_ready_state) ?? 'unknown'
  const elapsedMs = typeof readiness.elapsed_ms === 'number' ? `${readiness.elapsed_ms}ms` : 'unknown elapsed'
  const sessionAlive = typeof readiness.session_alive_ms === 'number' ? `; live=${formatElapsedSinceAttempt(readiness.session_alive_ms)}` : ''
  const remoteAudioActive = typeof readiness.remote_audio_active === 'boolean'
    ? `; remote_audio=${readiness.remote_audio_active ? 'active' : 'not active'}`
    : ''

  return `${ready}; reason=${reason}; pc=${connectionState}; ice=${iceState}; data=${dataChannelState}; ${elapsedMs}${sessionAlive}${remoteAudioActive}`
}

function formatCallDiagnosticShape(value: OpenAIWebRTCCallDiagnostics | null): string {
  if (!value) {
    return 'Not captured yet'
  }

  const locationShape = value.location_matches_documented_shape ? 'location documented' : 'location unexpected'
  const callIdShape = value.call_id_matches_documented_shape ? 'call id documented' : 'call id unexpected'
  return `${locationShape}; ${callIdShape}`
}

function shouldShowRuntimeChecklist(message: string | null): boolean {
  if (!message) {
    return false
  }

  return /(SOPHIA_VOICE_RUNTIME_MODE|SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED|SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED|OPENAI_API_KEY|OpenAI browser WebRTC dogfood requires)/.test(message)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'OpenAI dogfood failed for an unknown reason.'
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
  if (status === 'unavailable') return 'Unavailable'
  if (status === 'error') return 'Error'
  return 'Disconnected'
}

function formatMicrophoneStatus(status: MicrophoneStatus): string {
  if (status === 'waiting') return 'Waiting for permission'
  if (status === 'granted') return 'Granted'
  if (status === 'error') return 'Blocked or failed'
  return 'Idle'
}

function formatRemoteAudioStatus(status: RemoteAudioStatus): string {
  if (status === 'expected') return 'Expected'
  if (status === 'active') return 'Active'
  return 'Idle'
}

function formatAttemptTimestamp(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Not captured yet'
  }

  return new Date(value).toLocaleTimeString()
}

function formatElapsedSinceAttempt(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Not captured yet'
  }
  if (value < 1_000) {
    return `${Math.max(0, Math.round(value))}ms`
  }

  return `${(value / 1_000).toFixed(1)}s`
}

function formatRemoteAudioAttempt(value: boolean | undefined): string {
  if (value === true) return 'Active'
  if (value === false) return 'Not active yet'
  return 'Not captured yet'
}