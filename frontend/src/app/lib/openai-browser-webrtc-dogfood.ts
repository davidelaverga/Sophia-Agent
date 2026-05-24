export type OpenAIBrowserDogfoodStage =
  | 'starting_backend_session'
  | 'requesting_microphone'
  | 'creating_offer'
  | 'exchanging_sdp'
  | 'waiting_for_webrtc_ready'
  | 'attaching_sideband'
  | 'connected'
  | 'closing'
  | 'closed';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PeerConnectionFactory = () => RTCPeerConnection;
type GetUserMediaLike = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export interface OpenAIBrowserDogfoodConnectOptions {
  userId: string;
  sessionId?: string;
  instructions?: string;
  remoteAudioElement?: HTMLAudioElement | null;
  webrtcReadyTimeoutMs?: number;
  fetchFn?: FetchLike;
  peerConnectionFactory?: PeerConnectionFactory;
  getUserMedia?: GetUserMediaLike;
  onStage?: (stage: OpenAIBrowserDogfoodStage) => void;
  onDataChannelEvent?: (event: unknown) => void;
}

export type OpenAIWebRTCReadinessReason =
  | 'already_ready'
  | 'connection_state_connected'
  | 'ice_connection_state_connected'
  | 'data_channel_open'
  | 'connection_state_failed'
  | 'ice_connection_state_failed'
  | 'connection_closed'
  | 'data_channel_closed'
  | 'timeout';

export interface OpenAIWebRTCReadinessEvidence {
  ready: boolean;
  reason: OpenAIWebRTCReadinessReason;
  elapsed_ms: number;
  connection_state: string;
  ice_connection_state: string;
  ice_gathering_state: string;
  signaling_state: string;
  data_channel_ready_state: string;
  session_alive_ms?: number;
  remote_audio_active?: boolean;
}

export interface OpenAIBrowserDogfoodSidebandInfo {
  dogfood_session_id?: string;
  call_id?: string;
  attached?: boolean;
  attached_at?: number;
  sideband_url?: string;
  call_diagnostics?: OpenAIWebRTCCallDiagnostics;
  webrtc_readiness?: OpenAIWebRTCReadinessEvidence;
  event_stream_url?: string;
  public_event_boundary?: string;
  attach_error?: string;
  attach_attempt_count?: number;
  last_attach_attempt_at?: number;
  session_alive_ms_at_last_attempt?: number;
  remote_audio_active_at_last_attempt?: boolean;
  provider_request_id?: string;
  provider_status_code?: number;
  [key: string]: unknown;
}

export interface OpenAIBrowserDogfoodRetrySidebandOptions {
  remoteAudioActive?: boolean;
}

export interface OpenAIWebRTCCallDiagnostics {
  requested_model: string | null;
  sdp_status: number | null;
  raw_location: string | null;
  extracted_call_id: string | null;
  location_matches_documented_shape: boolean;
  call_id_matches_documented_shape: boolean;
  unexpected_location_variant: string | null;
}

export interface OpenAIBrowserDogfoodConnection {
  userId: string;
  sessionId: string;
  callId: string;
  streamUrl: string;
  sideband: OpenAIBrowserDogfoodSidebandInfo;
  callDiagnostics: OpenAIWebRTCCallDiagnostics;
  webrtcReadiness: OpenAIWebRTCReadinessEvidence;
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  localStream: MediaStream;
  transportConnectedAt: number;
  retrySidebandAttach: (
    options?: OpenAIBrowserDogfoodRetrySidebandOptions,
  ) => Promise<OpenAIBrowserDogfoodSidebandInfo>;
  close: () => Promise<void>;
}

interface BrowserSessionPayload {
  session_id?: unknown;
  client_secret?: unknown;
  requested_model?: unknown;
  openai_diagnostics?: unknown;
  webrtc_call_url?: unknown;
  stream_url?: unknown;
  event_stream_url?: unknown;
}

interface ClientSecretPayload {
  value?: unknown;
}

interface DogfoodErrorPayload {
  detail?: unknown;
  error?: unknown;
  message?: unknown;
}

const DEFAULT_OPENAI_WEBRTC_CALL_URL = 'https://api.openai.com/v1/realtime/calls';
const CALL_ID_PATTERN = /^rtc_[A-Za-z0-9_-]{1,156}$/;
const DEFAULT_WEBRTC_READY_TIMEOUT_MS = 10_000;
const PROVIDER_REQUEST_ID_PATTERN = /request_id=([^;\s]+)/i;
const PROVIDER_STATUS_CODE_PATTERN = /->\s*HTTP\s+(\d{3})/i;

export function extractOpenAIRealtimeCallId(location: string | null | undefined): string | null {
  if (typeof location !== 'string') {
    return null;
  }

  const trimmed = location.trim();
  if (!trimmed) {
    return null;
  }

  const pathOnly = trimmed.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') ?? '';
  const candidate = pathOnly.split('/').pop() ?? '';
  return CALL_ID_PATTERN.test(candidate) ? candidate : null;
}

export async function connectOpenAIBrowserDogfood(
  options: OpenAIBrowserDogfoodConnectOptions,
): Promise<OpenAIBrowserDogfoodConnection> {
  const fetchFn = options.fetchFn ?? fetch;
  const peerConnectionFactory = options.peerConnectionFactory ?? (() => new RTCPeerConnection());
  const getUserMedia = options.getUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const notifyStage = (stage: OpenAIBrowserDogfoodStage) => options.onStage?.(stage);

  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  let dogfoodSessionId: string | null = null;
  let locationHeader: string | null = null;
  let openaiCallId: string | null = null;
  let currentCallDiagnostics: OpenAIWebRTCCallDiagnostics | null = null;
  let transportConnectedAt = 0;
  let currentSideband: OpenAIBrowserDogfoodSidebandInfo | null = null;
  const attachAbortController = new AbortController();
  let closed = false;

  const cleanup = async () => {
    notifyStage('closing');
    attachAbortController.abort();
    dataChannel?.close();
    localStream?.getTracks().forEach((track) => track.stop());
    peerConnection?.close();
    if (options.remoteAudioElement) {
      options.remoteAudioElement.pause();
      options.remoteAudioElement.srcObject = null;
    }
    if (dogfoodSessionId) {
      await fetchFn(`/api/sophia/${encodeURIComponent(options.userId)}/voice/dogfood/openai/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: dogfoodSessionId }),
        keepalive: true,
      }).catch(() => undefined);
    }
    notifyStage('closed');
  };

  try {
    notifyStage('starting_backend_session');
    const browserSession = await startBrowserDogfoodSession(fetchFn, options);
    dogfoodSessionId = browserSession.sessionId;

    notifyStage('requesting_microphone');
    localStream = await getUserMedia({ audio: true });
    peerConnection = peerConnectionFactory();
    dataChannel = peerConnection.createDataChannel('oai-events');
    dataChannel.onmessage = (event) => {
      if (!options.onDataChannelEvent) {
        return;
      }
      try {
        options.onDataChannelEvent(JSON.parse(String(event.data)));
      } catch {
        options.onDataChannelEvent(event.data);
      }
    };

    peerConnection.ontrack = (event) => {
      if (!options.remoteAudioElement) {
        return;
      }
      const [remoteStream] = event.streams;
      if (remoteStream) {
        options.remoteAudioElement.srcObject = remoteStream;
        void options.remoteAudioElement.play().catch(() => undefined);
      }
    };

    localStream.getTracks().forEach((track) => {
      peerConnection?.addTrack(track, localStream);
    });

    notifyStage('creating_offer');
    const offer = await peerConnection.createOffer();
    if (!offer.sdp) {
      throw new Error('OpenAI WebRTC offer did not contain SDP.');
    }
    await peerConnection.setLocalDescription(offer);

    notifyStage('exchanging_sdp');
    const sdpResponse = await fetchFn(browserSession.webrtcCallUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${browserSession.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      throw new Error(await formatDogfoodHttpError(sdpResponse, 'OpenAI WebRTC SDP exchange failed'));
    }

    const location = sdpResponse.headers.get('Location');
    const callId = extractOpenAIRealtimeCallId(location);
    const callDiagnostics = buildOpenAIWebRTCCallDiagnostics({
      requestedModel: browserSession.requestedModel,
      sdpStatus: sdpResponse.status,
      rawLocation: location,
      extractedCallId: callId,
    });
    locationHeader = location;
    openaiCallId = callId;
    currentCallDiagnostics = callDiagnostics;
    if (!callId) {
      throw new Error('OpenAI WebRTC SDP response did not include a valid rtc_* Location call id.');
    }

    const answerSdp = await sdpResponse.text();
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    notifyStage('waiting_for_webrtc_ready');
    const webrtcReadiness = await waitForOpenAIWebRTCReady(peerConnection, dataChannel, {
      timeoutMs: options.webrtcReadyTimeoutMs ?? DEFAULT_WEBRTC_READY_TIMEOUT_MS,
    });
    if (!webrtcReadiness.ready) {
      throw new Error(formatOpenAIWebRTCReadinessError(webrtcReadiness));
    }

    transportConnectedAt = Date.now();

    const performSidebandAttachAttempt = async (
      retryOptions: OpenAIBrowserDogfoodRetrySidebandOptions = {},
    ): Promise<OpenAIBrowserDogfoodSidebandInfo> => {
      if (!peerConnection || !dataChannel || !dogfoodSessionId || !openaiCallId || !currentCallDiagnostics) {
        throw new Error('OpenAI browser dogfood cannot attach sideband before WebRTC setup completes.');
      }

      const currentWebRTCState = snapshotOpenAIWebRTCReadiness(peerConnection, dataChannel, {
        connectedAt: transportConnectedAt,
        remoteAudioActive: retryOptions.remoteAudioActive,
      });

      currentSideband = await attachOpenAISideband(
        fetchFn,
        options.userId,
        dogfoodSessionId,
        openaiCallId,
        locationHeader,
        currentCallDiagnostics,
        currentWebRTCState,
        attachAbortController.signal,
        currentSideband?.attach_attempt_count ?? 0,
        browserSession.streamUrl,
      );

      return currentSideband;
    };

    notifyStage('attaching_sideband');
    const sideband = await performSidebandAttachAttempt();

    notifyStage('connected');
    return {
      userId: options.userId,
      sessionId: dogfoodSessionId,
      callId,
      streamUrl: browserSession.streamUrl,
      sideband,
      callDiagnostics,
      webrtcReadiness,
      peerConnection,
      dataChannel,
      localStream,
      transportConnectedAt,
      retrySidebandAttach: async (
        retryOptions: OpenAIBrowserDogfoodRetrySidebandOptions = {},
      ) => {
        if (closed) {
          throw new Error('Cannot retry sideband attach after the browser dogfood session has closed.');
        }

        notifyStage('attaching_sideband');
        const nextSideband = await performSidebandAttachAttempt(retryOptions);
        notifyStage('connected');
        return nextSideband;
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function startBrowserDogfoodSession(
  fetchFn: FetchLike,
  options: OpenAIBrowserDogfoodConnectOptions,
): Promise<{
  sessionId: string;
  clientSecret: string;
  requestedModel: string | null;
  webrtcCallUrl: string;
  streamUrl: string;
}> {
  const response = await fetchFn(`/api/sophia/${encodeURIComponent(options.userId)}/voice/dogfood/openai/browser-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: options.sessionId, instructions: options.instructions }),
  });

  if (!response.ok) {
    throw new Error(await formatDogfoodHttpError(response, 'OpenAI browser dogfood session failed'));
  }

  const payload = (await response.json()) as BrowserSessionPayload;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const clientSecret = readClientSecret(payload.client_secret);
  const requestedModel = readRequestedModel(payload);
  const webrtcCallUrl = typeof payload.webrtc_call_url === 'string' ? payload.webrtc_call_url : DEFAULT_OPENAI_WEBRTC_CALL_URL;
  const streamUrl = typeof payload.stream_url === 'string'
    ? payload.stream_url
    : typeof payload.event_stream_url === 'string'
      ? payload.event_stream_url
      : null;

  if (!sessionId) {
    throw new Error('OpenAI browser dogfood session response omitted session_id.');
  }
  if (!clientSecret) {
    throw new Error('OpenAI browser dogfood session response omitted the ephemeral client secret.');
  }
  if (!streamUrl) {
    throw new Error('OpenAI browser dogfood session response omitted stream_url.');
  }

  return { sessionId, clientSecret, requestedModel, webrtcCallUrl, streamUrl };
}

async function attachOpenAISideband(
  fetchFn: FetchLike,
  userId: string,
  sessionId: string,
  callId: string,
  location: string | null,
  callDiagnostics: OpenAIWebRTCCallDiagnostics,
  webrtcReadiness: OpenAIWebRTCReadinessEvidence,
  signal: AbortSignal,
  previousAttempts: number,
  eventStreamUrl: string,
): Promise<OpenAIBrowserDogfoodSidebandInfo> {
  const attemptCount = previousAttempts + 1;
  const attemptedAt = Date.now();

  try {
    const response = await fetchFn(`/api/sophia/${encodeURIComponent(userId)}/voice/dogfood/openai/sideband`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        call_id: callId,
        location,
        call_diagnostics: callDiagnostics,
        webrtc_readiness: webrtcReadiness,
      }),
      signal,
    });

    if (!response.ok) {
      return buildSidebandAttachFailureInfo({
        sessionId,
        callId,
        callDiagnostics,
        webrtcReadiness,
        eventStreamUrl,
        attachError: await formatDogfoodHttpError(response, 'OpenAI browser dogfood sideband attach failed'),
        attemptCount,
        attemptedAt,
      });
    }

    const payload = await response.json().catch(() => null);
    const sideband = payload && typeof payload === 'object' ? payload as OpenAIBrowserDogfoodSidebandInfo : {};

    return {
      ...sideband,
      dogfood_session_id: typeof sideband.dogfood_session_id === 'string' ? sideband.dogfood_session_id : sessionId,
      call_id: typeof sideband.call_id === 'string' ? sideband.call_id : callId,
      call_diagnostics: sideband.call_diagnostics ?? callDiagnostics,
      webrtc_readiness: sideband.webrtc_readiness ?? webrtcReadiness,
      event_stream_url: typeof sideband.event_stream_url === 'string' ? sideband.event_stream_url : eventStreamUrl,
      attached: sideband.attached === true,
      attach_attempt_count: attemptCount,
      last_attach_attempt_at: attemptedAt,
      session_alive_ms_at_last_attempt: typeof webrtcReadiness.session_alive_ms === 'number'
        ? webrtcReadiness.session_alive_ms
        : undefined,
      remote_audio_active_at_last_attempt: webrtcReadiness.remote_audio_active === true,
    };
  } catch (error) {
    return buildSidebandAttachFailureInfo({
      sessionId,
      callId,
      callDiagnostics,
      webrtcReadiness,
      eventStreamUrl,
      attachError: formatUnknownDogfoodError(error),
      attemptCount,
      attemptedAt,
    });
  }
}

export function buildOpenAIWebRTCCallDiagnostics({
  requestedModel,
  sdpStatus,
  rawLocation,
  extractedCallId,
}: {
  requestedModel?: string | null;
  sdpStatus?: number | null;
  rawLocation?: string | null;
  extractedCallId?: string | null;
}): OpenAIWebRTCCallDiagnostics {
  const normalizedLocation = cleanOptionalString(rawLocation);
  const normalizedCallId = cleanOptionalString(extractedCallId) ?? extractOpenAIRealtimeCallId(normalizedLocation);
  const callIdMatches = normalizedCallId !== null && CALL_ID_PATTERN.test(normalizedCallId);
  const locationMatches = matchesDocumentedOpenAILocationShape(normalizedLocation, normalizedCallId);

  return {
    requested_model: cleanOptionalString(requestedModel),
    sdp_status: typeof sdpStatus === 'number' ? sdpStatus : null,
    raw_location: normalizedLocation,
    extracted_call_id: normalizedCallId,
    location_matches_documented_shape: locationMatches,
    call_id_matches_documented_shape: callIdMatches,
    unexpected_location_variant: describeOpenAILocationVariant(normalizedLocation, normalizedCallId),
  };
}

export async function waitForOpenAIWebRTCReady(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  options: { timeoutMs?: number } = {},
): Promise<OpenAIWebRTCReadinessEvidence> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBRTC_READY_TIMEOUT_MS;
  const startedAt = Date.now();
  const initialReadyReason = readWebRTCReadyReason(peerConnection, dataChannel);
  if (initialReadyReason) {
    return makeWebRTCReadinessEvidence(peerConnection, dataChannel, startedAt, initialReadyReason, true);
  }

  const initialFailureReason = readWebRTCFailureReason(peerConnection, dataChannel);
  if (initialFailureReason) {
    return makeWebRTCReadinessEvidence(peerConnection, dataChannel, startedAt, initialFailureReason, false);
  }

  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];

    const finish = (reason: OpenAIWebRTCReadinessReason, ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      cleanups.forEach((cleanup) => cleanup());
      resolve(makeWebRTCReadinessEvidence(peerConnection, dataChannel, startedAt, reason, ready));
    };

    const check = () => {
      const readyReason = readWebRTCReadyReason(peerConnection, dataChannel);
      if (readyReason) {
        finish(readyReason, true);
        return;
      }

      const failureReason = readWebRTCFailureReason(peerConnection, dataChannel);
      if (failureReason) {
        finish(failureReason, false);
      }
    };

    const timeoutId = window.setTimeout(() => finish('timeout', false), timeoutMs);
    cleanups.push(addOptionalEventListener(peerConnection, 'connectionstatechange', check));
    cleanups.push(addOptionalEventListener(peerConnection, 'iceconnectionstatechange', check));
    cleanups.push(addOptionalEventListener(peerConnection, 'signalingstatechange', check));
    cleanups.push(addOptionalEventListener(dataChannel, 'open', check));
    cleanups.push(addOptionalEventListener(dataChannel, 'close', check));
    cleanups.push(addOptionalEventListener(dataChannel, 'error', check));
    check();
  });
}

function snapshotOpenAIWebRTCReadiness(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  options: {
    connectedAt?: number;
    remoteAudioActive?: boolean;
  } = {},
): OpenAIWebRTCReadinessEvidence {
  const readyReason = readWebRTCReadyReason(peerConnection, dataChannel);
  const failureReason = readWebRTCFailureReason(peerConnection, dataChannel);
  const reason = readyReason ?? failureReason ?? 'already_ready';
  const readiness = makeWebRTCReadinessEvidence(
    peerConnection,
    dataChannel,
    options.connectedAt ?? Date.now(),
    reason,
    failureReason === null,
  );

  if (typeof options.connectedAt === 'number') {
    readiness.session_alive_ms = Math.max(0, Date.now() - options.connectedAt);
  }
  if (typeof options.remoteAudioActive === 'boolean') {
    readiness.remote_audio_active = options.remoteAudioActive;
  }

  return readiness;
}

function readWebRTCReadyReason(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
): OpenAIWebRTCReadinessReason | null {
  if (peerConnection.connectionState === 'connected') {
    return 'connection_state_connected';
  }
  if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
    return 'ice_connection_state_connected';
  }
  if (dataChannel.readyState === 'open') {
    return 'data_channel_open';
  }
  return null;
}

function readWebRTCFailureReason(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
): OpenAIWebRTCReadinessReason | null {
  if (peerConnection.connectionState === 'failed') {
    return 'connection_state_failed';
  }
  if (peerConnection.connectionState === 'closed') {
    return 'connection_closed';
  }
  if (peerConnection.iceConnectionState === 'failed') {
    return 'ice_connection_state_failed';
  }
  if (peerConnection.iceConnectionState === 'closed') {
    return 'connection_closed';
  }
  if (dataChannel.readyState === 'closed') {
    return 'data_channel_closed';
  }
  return null;
}

function makeWebRTCReadinessEvidence(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  startedAt: number,
  reason: OpenAIWebRTCReadinessReason,
  ready: boolean,
): OpenAIWebRTCReadinessEvidence {
  return {
    ready,
    reason,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    connection_state: String(peerConnection.connectionState ?? 'unknown'),
    ice_connection_state: String(peerConnection.iceConnectionState ?? 'unknown'),
    ice_gathering_state: String(peerConnection.iceGatheringState ?? 'unknown'),
    signaling_state: String(peerConnection.signalingState ?? 'unknown'),
    data_channel_ready_state: String(dataChannel.readyState ?? 'unknown'),
  };
}

function addOptionalEventListener(
  target: unknown,
  type: string,
  listener: EventListener,
): () => void {
  const eventTarget = target as {
    addEventListener?: (eventType: string, eventListener: EventListener) => void;
    removeEventListener?: (eventType: string, eventListener: EventListener) => void;
  } | null;

  if (!eventTarget || typeof eventTarget.addEventListener !== 'function') {
    return () => undefined;
  }

  eventTarget.addEventListener(type, listener);
  return () => eventTarget.removeEventListener?.(type, listener);
}

function formatOpenAIWebRTCReadinessError(readiness: OpenAIWebRTCReadinessEvidence): string {
  return (
    'OpenAI WebRTC did not become ready before sideband attach: '
    + `reason=${readiness.reason}; `
    + `connection_state=${readiness.connection_state}; `
    + `ice_connection_state=${readiness.ice_connection_state}; `
    + `data_channel_ready_state=${readiness.data_channel_ready_state}; `
    + `elapsed_ms=${readiness.elapsed_ms}.`
  );
}

function matchesDocumentedOpenAILocationShape(
  rawLocation: string | null,
  extractedCallId: string | null,
): boolean {
  if (!rawLocation || !extractedCallId || !CALL_ID_PATTERN.test(extractedCallId)) {
    return false;
  }

  return getOpenAILocationPath(rawLocation) === `/v1/realtime/calls/${extractedCallId}`;
}

function describeOpenAILocationVariant(
  rawLocation: string | null,
  extractedCallId: string | null,
): string | null {
  if (!rawLocation) {
    return 'missing_location';
  }

  const path = getOpenAILocationPath(rawLocation);
  if (!path.startsWith('/v1/realtime/calls/')) {
    return 'unexpected_location_path';
  }

  const candidate = path.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!candidate) {
    return 'missing_call_id_segment';
  }
  if (!candidate.startsWith('rtc_')) {
    const prefix = candidate.includes('_') ? candidate.split('_', 1)[0] : candidate.slice(0, 12);
    return `unexpected_call_id_prefix:${prefix}`;
  }
  if (!CALL_ID_PATTERN.test(candidate)) {
    return 'invalid_call_id_shape';
  }
  if (extractedCallId && candidate !== extractedCallId) {
    return 'extracted_call_id_mismatch';
  }
  return null;
}

function getOpenAILocationPath(location: string): string {
  try {
    return new URL(location, 'https://api.openai.com').pathname;
  } catch {
    return location.split(/[?#]/, 1)[0] ?? location;
  }
}

function readRequestedModel(payload: BrowserSessionPayload): string | null {
  if (typeof payload.requested_model === 'string' && payload.requested_model.trim()) {
    return payload.requested_model.trim();
  }

  const diagnostics = payload.openai_diagnostics;
  if (diagnostics && typeof diagnostics === 'object') {
    const requestedModel = (diagnostics as { requested_model?: unknown }).requested_model;
    if (typeof requestedModel === 'string' && requestedModel.trim()) {
      return requestedModel.trim();
    }
  }

  return null;
}

function cleanOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildSidebandAttachFailureInfo({
  sessionId,
  callId,
  callDiagnostics,
  webrtcReadiness,
  eventStreamUrl,
  attachError,
  attemptCount,
  attemptedAt,
}: {
  sessionId: string;
  callId: string;
  callDiagnostics: OpenAIWebRTCCallDiagnostics;
  webrtcReadiness: OpenAIWebRTCReadinessEvidence;
  eventStreamUrl: string;
  attachError: string;
  attemptCount: number;
  attemptedAt: number;
}): OpenAIBrowserDogfoodSidebandInfo {
  return {
    dogfood_session_id: sessionId,
    call_id: callId,
    attached: false,
    call_diagnostics: callDiagnostics,
    webrtc_readiness: webrtcReadiness,
    event_stream_url: eventStreamUrl,
    public_event_boundary: 'Unavailable while sideband is detached',
    attach_error: attachError,
    attach_attempt_count: attemptCount,
    last_attach_attempt_at: attemptedAt,
    session_alive_ms_at_last_attempt: typeof webrtcReadiness.session_alive_ms === 'number'
      ? webrtcReadiness.session_alive_ms
      : undefined,
    remote_audio_active_at_last_attempt: webrtcReadiness.remote_audio_active === true,
    provider_request_id: extractProviderRequestId(attachError) ?? undefined,
    provider_status_code: extractProviderStatusCode(attachError) ?? undefined,
  };
}

function extractProviderRequestId(errorMessage: string): string | null {
  const match = PROVIDER_REQUEST_ID_PATTERN.exec(errorMessage);
  if (!match) {
    return null;
  }
  return cleanOptionalString(match[1]);
}

function extractProviderStatusCode(errorMessage: string): number | null {
  const match = PROVIDER_STATUS_CODE_PATTERN.exec(errorMessage);
  if (!match) {
    return null;
  }

  const statusCode = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(statusCode) ? statusCode : null;
}

function readClientSecret(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const clientSecret = (value as ClientSecretPayload).value;
  return typeof clientSecret === 'string' && clientSecret.trim() ? clientSecret : null;
}

function formatUnknownDogfoodError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'OpenAI browser dogfood sideband attach failed for an unknown reason.';
}

async function formatDogfoodHttpError(response: Response, prefix: string): Promise<string> {
  let detail = '';

  try {
    const contentType = response.headers.get('Content-Type') ?? response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const payload = await response.json() as DogfoodErrorPayload | null;
      detail = readDogfoodErrorDetail(payload);
    } else {
      detail = (await response.text()).trim();
    }
  } catch {
    detail = '';
  }

  const suffix = detail || response.statusText || `HTTP ${response.status}`;
  return `${prefix}: ${suffix}`;
}

function readDogfoodErrorDetail(payload: DogfoodErrorPayload | null): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  for (const candidate of [payload.detail, payload.error, payload.message]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}
