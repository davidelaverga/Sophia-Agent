import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenAIWebRTCCallDiagnostics,
  connectOpenAIBrowserDogfood,
  extractOpenAIRealtimeCallId,
  type OpenAIBrowserDogfoodStage,
} from '../app/lib/openai-browser-webrtc-dogfood';

class FakeDataChannel {
  readyState: RTCDataChannelState;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readyState: RTCDataChannelState = 'open') {
    this.readyState = readyState;
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

class FakePeerConnection {
  readonly dataChannel: FakeDataChannel;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  addTrack = vi.fn();
  close = vi.fn();
  createDataChannel = vi.fn(() => this.dataChannel as unknown as RTCDataChannel);
  createOffer = vi.fn(async () => ({ type: 'offer' as RTCSdpType, sdp: 'offer-sdp' }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(options: {
    connectionState?: RTCPeerConnectionState;
    iceConnectionState?: RTCIceConnectionState;
    iceGatheringState?: RTCIceGatheringState;
    signalingState?: RTCSignalingState;
    dataChannelReadyState?: RTCDataChannelState;
  } = {}) {
    this.connectionState = options.connectionState ?? 'connected';
    this.iceConnectionState = options.iceConnectionState ?? 'connected';
    this.iceGatheringState = options.iceGatheringState ?? 'complete';
    this.signalingState = options.signalingState ?? 'stable';
    this.dataChannel = new FakeDataChannel(options.dataChannelReadyState ?? 'open');
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

describe('OpenAI browser WebRTC dogfood connector', () => {
  it('extracts the rtc call id from the OpenAI WebRTC Location header', () => {
    expect(extractOpenAIRealtimeCallId('https://api.openai.com/v1/realtime/calls/rtc_frontend_1')).toBe('rtc_frontend_1');
    expect(extractOpenAIRealtimeCallId('/v1/realtime/calls/rtc_frontend_2?foo=bar')).toBe('rtc_frontend_2');
    expect(extractOpenAIRealtimeCallId('https://api.openai.com/v1/realtime/calls/call_frontend_1')).toBeNull();
    expect(extractOpenAIRealtimeCallId(null)).toBeNull();
  });

  it('reports raw Location diagnostics for documented and unexpected call id shapes', () => {
    expect(buildOpenAIWebRTCCallDiagnostics({
      requestedModel: 'gpt-realtime-2',
      sdpStatus: 200,
      rawLocation: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
      extractedCallId: 'rtc_frontend_1',
    })).toEqual({
      requested_model: 'gpt-realtime-2',
      sdp_status: 200,
      raw_location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
      extracted_call_id: 'rtc_frontend_1',
      location_matches_documented_shape: true,
      call_id_matches_documented_shape: true,
      unexpected_location_variant: null,
    });

    expect(buildOpenAIWebRTCCallDiagnostics({
      rawLocation: '/v1/realtime/calls/call_frontend_1',
      extractedCallId: null,
    })).toEqual(expect.objectContaining({
      extracted_call_id: null,
      location_matches_documented_shape: false,
      call_id_matches_documented_shape: false,
      unexpected_location_variant: 'unexpected_call_id_prefix:call',
    }));
  });

  it('starts backend dogfood, installs the SDP answer, then attaches sideband', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            requested_model: 'gpt-realtime-2',
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attached: true, call_id: 'rtc_frontend_1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const peerConnection = new FakePeerConnection();
    const stages: OpenAIBrowserDogfoodStage[] = [];

    const connection = await connectOpenAIBrowserDogfood({
      userId: 'user-1',
      sessionId: 'browser-openai-1',
      fetchFn: fetchMock as typeof fetch,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => localStream),
      onStage: (stage) => stages.push(stage),
    });

    expect(connection.sessionId).toBe('browser-openai-1');
    expect(connection.callId).toBe('rtc_frontend_1');
    expect(connection.callDiagnostics).toEqual({
      requested_model: 'gpt-realtime-2',
      sdp_status: 200,
      raw_location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
      extracted_call_id: 'rtc_frontend_1',
      location_matches_documented_shape: true,
      call_id_matches_documented_shape: true,
      unexpected_location_variant: null,
    });
    expect(connection.streamUrl).toBe('/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1');
    expect(stages).toEqual([
      'starting_backend_session',
      'requesting_microphone',
      'creating_offer',
      'exchanging_sdp',
      'waiting_for_webrtc_ready',
      'attaching_sideband',
      'connected',
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/sophia/user-1/voice/dogfood/openai/browser-session',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.openai.com/v1/realtime/calls',
      expect.objectContaining({
        method: 'POST',
        body: 'offer-sdp',
        headers: expect.objectContaining({
          Authorization: 'Bearer ek_test_ephemeral',
          'Content-Type': 'application/sdp',
        }),
      }),
    );
    const sidebandRequest = fetchMock.mock.calls[2];
    const sidebandInit = sidebandRequest?.[1] as RequestInit;
    expect(sidebandRequest?.[0]).toBe('/api/sophia/user-1/voice/dogfood/openai/sideband');
    expect(sidebandInit).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(sidebandInit.body))).toEqual(expect.objectContaining({
      session_id: 'browser-openai-1',
      call_id: 'rtc_frontend_1',
      location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
      call_diagnostics: expect.objectContaining({
        requested_model: 'gpt-realtime-2',
        sdp_status: 200,
        raw_location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1',
        extracted_call_id: 'rtc_frontend_1',
        location_matches_documented_shape: true,
        call_id_matches_documented_shape: true,
      }),
      webrtc_readiness: expect.objectContaining({
        ready: true,
        reason: 'connection_state_connected',
        connection_state: 'connected',
        ice_connection_state: 'connected',
        data_channel_ready_state: 'open',
      }),
    }));
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
    expect(peerConnection.setRemoteDescription.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      fetchMock.mock.invocationCallOrder[2] ?? 0,
    );
    expect(connection.webrtcReadiness.ready).toBe(true);

    await connection.close();

    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(peerConnection.dataChannel.close).toHaveBeenCalledTimes(1);
    expect(peerConnection.close).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/sophia/user-1/voice/dogfood/openai/disconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session_id: 'browser-openai-1' }),
        keepalive: true,
      }),
    );
  });

  it('waits for WebRTC readiness evidence before attaching the sideband', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attached: true, call_id: 'rtc_frontend_1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const peerConnection = new FakePeerConnection({
      connectionState: 'connecting',
      iceConnectionState: 'checking',
      dataChannelReadyState: 'connecting',
    });
    const stages: OpenAIBrowserDogfoodStage[] = [];
    const localStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    const connectPromise = connectOpenAIBrowserDogfood({
      userId: 'user-1',
      fetchFn: fetchMock as typeof fetch,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => localStream),
      onStage: (stage) => stages.push(stage),
    });

    await vi.waitFor(() => expect(stages).toContain('waiting_for_webrtc_ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    peerConnection.connectionState = 'connected';
    peerConnection.dispatch('connectionstatechange');

    const connection = await connectPromise;
    expect(connection.webrtcReadiness).toEqual(expect.objectContaining({
      ready: true,
      reason: 'connection_state_connected',
      connection_state: 'connected',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the live WebRTC session alive in degraded audio-only mode when sideband attach fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            requested_model: 'gpt-realtime-2',
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: 'OpenAI sideband websocket attach failed: wss://api.openai.com/v1/realtime?call_id=rtc_frontend_1 -> HTTP 404; attempt=4/4; retryable=false; elapsed_ms=1021; request_id=req_live_404; error_type=InvalidStatusCode; error=server rejected WebSocket connection: HTTP 404',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const peerConnection = new FakePeerConnection();

    const connection = await connectOpenAIBrowserDogfood({
      userId: 'user-1',
      sessionId: 'browser-openai-1',
      fetchFn: fetchMock as typeof fetch,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => localStream),
    });

    expect(connection.sideband).toEqual(expect.objectContaining({
      attached: false,
      attach_attempt_count: 1,
      provider_request_id: 'req_live_404',
      provider_status_code: 404,
      attach_error: expect.stringContaining('OpenAI sideband websocket attach failed'),
      session_alive_ms_at_last_attempt: expect.any(Number),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stoppedTrack).not.toHaveBeenCalled();
    expect(peerConnection.dataChannel.close).not.toHaveBeenCalled();
    expect(peerConnection.close).not.toHaveBeenCalled();

    await connection.close();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stoppedTrack).toHaveBeenCalledTimes(1);
  });

  it('retries sideband attach against the same live browser session without recreating WebRTC', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            requested_model: 'gpt-realtime-2',
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('answer-sdp', {
          status: 200,
          headers: { Location: 'https://api.openai.com/v1/realtime/calls/rtc_frontend_1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: 'OpenAI sideband websocket attach failed: wss://api.openai.com/v1/realtime?call_id=rtc_frontend_1 -> HTTP 404; attempt=4/4; retryable=false; elapsed_ms=1021; request_id=req_live_404; error_type=InvalidStatusCode; error=server rejected WebSocket connection: HTTP 404',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ attached: true, call_id: 'rtc_frontend_1' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const localStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const peerConnection = new FakePeerConnection();

    const connection = await connectOpenAIBrowserDogfood({
      userId: 'user-1',
      sessionId: 'browser-openai-1',
      fetchFn: fetchMock as typeof fetch,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => localStream),
    });

    const retriedSideband = await connection.retrySidebandAttach({ remoteAudioActive: true });

    expect(retriedSideband).toEqual(expect.objectContaining({
      attached: true,
      call_id: 'rtc_frontend_1',
      attach_attempt_count: 2,
      remote_audio_active_at_last_attempt: true,
    }));
    expect(peerConnection.createOffer).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const retryRequest = fetchMock.mock.calls[3];
    const retryInit = retryRequest?.[1] as RequestInit;
    expect(retryRequest?.[0]).toBe('/api/sophia/user-1/voice/dogfood/openai/sideband');
    expect(JSON.parse(String(retryInit.body))).toEqual(expect.objectContaining({
      session_id: 'browser-openai-1',
      call_id: 'rtc_frontend_1',
      webrtc_readiness: expect.objectContaining({
        session_alive_ms: expect.any(Number),
        remote_audio_active: true,
      }),
    }));

    await connection.close();
  });

  it('surfaces backend conflict details from the protected dogfood session start', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: 'OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.' }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      connectOpenAIBrowserDogfood({
        userId: 'user-1',
        fetchFn: fetchMock as typeof fetch,
        peerConnectionFactory: vi.fn(),
        getUserMedia: vi.fn(),
      }),
    ).rejects.toThrow(
      'OpenAI browser dogfood session failed: OpenAI browser WebRTC dogfood requires SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED=true.',
    );
  });

  it('cleans up the backend dogfood session when the browser connect fails before sideband attach', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('Blocked by Content Security Policy', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const stoppedTrack = vi.fn();
    const localStream = {
      getTracks: () => [{ stop: stoppedTrack }],
    } as unknown as MediaStream;
    const peerConnection = new FakePeerConnection();
    const stages: OpenAIBrowserDogfoodStage[] = [];

    await expect(
      connectOpenAIBrowserDogfood({
        userId: 'user-1',
        sessionId: 'browser-openai-1',
        fetchFn: fetchMock as typeof fetch,
        peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
        getUserMedia: vi.fn(async () => localStream),
        onStage: (stage) => stages.push(stage),
      }),
    ).rejects.toThrow('OpenAI WebRTC SDP exchange failed: Blocked by Content Security Policy');

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sophia/user-1/voice/dogfood/openai/disconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session_id: 'browser-openai-1' }),
        keepalive: true,
      }),
    );
    expect(stages).toEqual([
      'starting_backend_session',
      'requesting_microphone',
      'creating_offer',
      'exchanging_sdp',
      'closing',
      'closed',
    ]);
    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(peerConnection.dataChannel.close).toHaveBeenCalledTimes(1);
    expect(peerConnection.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the original connect error when cleanup itself rejects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            session_id: 'browser-openai-1',
            client_secret: { value: 'ek_test_ephemeral' },
            webrtc_call_url: 'https://api.openai.com/v1/realtime/calls',
            stream_url: '/api/sophia/user-1/voice/dogfood/openai/events?session_id=browser-openai-1',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('Failed to fetch', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
      )
      .mockRejectedValueOnce(new TypeError('disconnect cleanup failed'));
    const localStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    await expect(
      connectOpenAIBrowserDogfood({
        userId: 'user-1',
        sessionId: 'browser-openai-1',
        fetchFn: fetchMock as typeof fetch,
        peerConnectionFactory: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        getUserMedia: vi.fn(async () => localStream),
      }),
    ).rejects.toThrow('OpenAI WebRTC SDP exchange failed: Failed to fetch');
  });
});
