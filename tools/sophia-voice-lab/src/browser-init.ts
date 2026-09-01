export interface InitScriptOptions {
  pageOrigin: string;
  websocketOrigins: string[];
  maxAudioBytes: number;
  testRunId: string;
  cleanupObligationId: string;
}

export function buildVoiceLabInitScript(options: InitScriptOptions): string {
  const encoded = JSON.stringify(options).replaceAll("<", "\\u003c");
  return `(() => {
    'use strict';
    const options = ${encoded};
    // addInitScript executes for every document in the context. Never patch
    // media, storage, or sockets on a redirect target, popup, or foreign frame.
    if (location.origin !== options.pageOrigin || window.top !== window) return;
    const allowedWsOrigins = new Set(options.websocketOrigins);
    const state = { seq: 0, events: [], sockets: [], socketEpoch: 0, activeInputs: new Map(), scheduleReceipts: new Map() };
    const pushToWorker = (channel, payload) => {
      try {
        const binding = window.__sophiaVoiceLabPushV1;
        if (typeof binding !== 'function') return;
        Promise.resolve(binding({
          schema: 'sophia_voice_lab_page_push_v1',
          channel,
          payload,
        })).catch(() => undefined);
      } catch {}
    };
    const emit = (kind, payload = {}) => {
      const event = { seq: ++state.seq, kind, observed_at: new Date().toISOString(), payload };
      state.events.push(event);
      if (state.events.length > 2048) state.events.splice(0, state.events.length - 2048);
      // Push startup receipts over Playwright's exposed-binding event lane.
      // This is observation-only: the durable runner still validates every
      // sequence and product binding before accepting evidence. Avoiding a
      // new Runtime.evaluate after the ordinary mic activation prevents a
      // renderer command acknowledgement from owning the startup watchdog.
      pushToWorker('harness', event);
      return event;
    };
    addEventListener('sophia:capture-event', (event) => {
      if (!(event instanceof CustomEvent) || !event.detail) return;
      pushToWorker('product', event.detail);
    });
    const emitProductInputBoundary = (phase, detail) => {
      // This content-free event is only correlation metadata. The product must
      // independently prove the authenticated synthetic run and the PCM bytes
      // it actually forwards; this event authorizes no action and makes no
      // claim that input was accepted by the provider.
      try {
        dispatchEvent(new CustomEvent('sophia:voice-lab-input-operation', { detail: {
          schema: 'sophia_voice_lab_input_operation_v1',
          phase,
          test_run_id: options.testRunId,
          cleanup_obligation_id: options.cleanupObligationId,
          ...detail,
        } }));
      } catch {
        emit('harness.input_operation_dispatch_failed', { phase });
      }
    };
    const hashText = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const terminalToolStates = new Set(['responded', 'cancelled-before-send', 'cancelled-after-send', 'suppressed', 'rejected']);
    const assertProductTargetActive = (target) => {
      if (target === undefined || target === null) return null;
      if (!target || typeof target !== 'object') throw new Error('active product target rejected');
      const generation = Number(target.productGeneration);
      const seq = Number(target.productSeq);
      const capture = window.__sophiaCapture;
      if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(seq) || seq < 1 || !capture?.getEvents) throw new Error('active product target cursor rejected');
      const events = capture.getEvents();
      const cited = events.find((event) => event.generation === generation && event.seq === seq);
      const binding = cited?.synthetic_test;
      if (!cited || binding?.synthetic !== true || binding.test_run_id !== options.testRunId || binding.cleanup_obligation_id !== options.cleanupObligationId) throw new Error('active product target binding rejected');
      const later = events.filter((event) => event.generation === generation && event.seq > seq);
      let active = false;
      if (target.kind === 'output_realization') {
        const receipt = cited?.payload?.receipt;
        const terminal = later.some((event) => {
          const candidate = event?.payload?.receipt;
          return ['gemini-output-audio-playback-completed', 'gemini-output-audio-playback-flushed', 'gemini-output-audio-playback-dropped'].includes(event.name)
            && (candidate?.realizationId === target.stableId || candidate?.chunkHash === target.chunkHash);
        });
        active = cited.name === 'gemini-output-audio-playback-started' && receipt?.phase === 'started' && receipt.realizationId === target.stableId
          && receipt.chunkHash === target.chunkHash && receipt.providerConnectionEpoch === target.providerConnectionEpoch
          && receipt.playbackGeneration === target.playbackGeneration && !terminal;
      } else if (target.kind === 'tool_effect') {
        const entry = cited?.payload?.entry;
        const terminal = later.some((event) => {
          const candidate = event?.payload?.entry;
          return event.name === 'gemini-tool-call-ledger' && candidate?.toolCallId === target.toolCallId && candidate?.effectId === target.effectId
            && terminalToolStates.has(String(candidate?.finalState));
        });
        active = cited.name === 'gemini-tool-call-ledger' && entry?.toolCallId === target.toolCallId && entry?.effectId === target.effectId
          && entry?.providerConnectionEpoch === target.providerConnectionEpoch && entry?.finalState === 'unknown'
          && entry?.toolResponseSentAt === null && entry?.cancelledAt === null && !terminal;
      }
      if (!active) throw new Error('active product target settled before mutation');
      const latest = events.filter((event) => event.generation === generation).at(-1);
      const receipt = {
        schema: 'sophia_voice_lab_active_target_fence_v1',
        operation_id: target.operationId,
        lab_event_seq: target.labEventSeq,
        kind: target.kind,
        product_generation: generation,
        product_seq: seq,
        observed_through_product_seq: latest?.seq ?? seq,
        stable_id: target.kind === 'output_realization' ? target.stableId : target.toolCallId,
        effect_or_chunk_id: target.kind === 'output_realization' ? target.chunkHash : target.effectId,
        provider_connection_epoch: target.providerConnectionEpoch,
        active: true,
        fenced_at: new Date().toISOString(),
      };
      emit('harness.product_active_target_fenced', receipt);
      return receipt;
    };
    try {
      const completedOnboarding = { state: { firstRun: { status: 'completed', currentStepId: null, completedSteps: [], skippedAt: null, completedAt: new Date().toISOString() }, contextualTips: {}, preferences: { voiceOverEnabled: true, reducedMotion: true }, legacyStep: 'complete' }, version: 2 };
      localStorage.setItem('sophia-onboarding-v2', JSON.stringify(completedOnboarding));
      // The dashboard spotlight predates the v2 onboarding store and uses its
      // own completion key. Seed both before hydration so its full-screen
      // overlay cannot appear later and intercept the ordinary microphone CTA.
      localStorage.setItem('sophia-onboarded', '1');
      // The dedicated synthetic principal is forbidden from ordinary product
      // mutation endpoints, including /api/consent/accept. Import the
      // campaign-approved consent state before React hydrates so the ordinary
      // dashboard can render without asking the isolated principal to cross
      // that boundary. Synthetic telemetry remains independently fenced by
      // the HttpOnly run-context markers.
      localStorage.setItem('sophia_consent_accepted', 'true');
      localStorage.setItem('sophia.capture.enabled', '1');
    } catch {}
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) { emit('harness.audio_context_unavailable'); return; }
    const audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
    const destination = audioContext.createMediaStreamDestination();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') { emit('harness.media_devices_unavailable'); return; }
    // Keep the native method unreachable after this point. The ordinary app's
    // capture bridge is allowed to install one observer wrapper around the
    // synthetic replacement, but it never receives the native function and
    // therefore cannot escape to a physical microphone.
    let activeGetUserMedia = null;
    let observerWrapperInstalled = false;
    const replacement = async (constraints) => {
      const wantsAudio = constraints === undefined || constraints.audio !== false;
      const wantsVideo = Boolean(constraints && constraints.video);
      if (!wantsAudio || wantsVideo) {
        emit('harness.media_request_rejected', { wants_audio: wantsAudio, wants_video: wantsVideo });
        throw new DOMException('Voice Lab only permits the synthetic audio-only stream.', 'NotAllowedError');
      }
      const trackIds = destination.stream.getAudioTracks().map((track) => track.id);
      emit('harness.media_stream_issued', { audio_tracks: trackIds.length, stream_id_sha256: await hashText(destination.stream.id), track_id_sha256s: await Promise.all(trackIds.map(hashText)), replacement_active: activeGetUserMedia === replacement || observerWrapperInstalled });
      return destination.stream;
    };
    activeGetUserMedia = replacement;
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: false,
      enumerable: true,
      get: () => activeGetUserMedia,
      set: (candidate) => {
        // SessionCaptureBridge reads the current replacement, binds it, then
        // assigns one observer wrapper. Permit exactly that single layer. A
        // later product effect may repeat its installation while React is
        // settling the ordinary route; retain the already-attested wrapper
        // instead of throwing into that effect. The candidate is never called
        // or installed, so the sealed synthetic pipeline cannot be replaced.
        if (observerWrapperInstalled || typeof candidate !== 'function' || candidate === replacement) {
          emit('harness.media_observer_wrapper_retained', {
            synthetic_pipeline_sealed: true,
            candidate_function: typeof candidate === 'function',
          });
          return;
        }
        activeGetUserMedia = candidate;
        observerWrapperInstalled = true;
        emit('harness.media_observer_wrapper_installed', { synthetic_pipeline_sealed: true });
      },
    });
    const NativeWebSocket = window.WebSocket;
    class LabWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        let origin = null;
        try { origin = new URL(String(url), location.href).origin; } catch {}
        if (origin && allowedWsOrigins.has(origin)) {
          state.socketEpoch += 1;
          state.sockets.push({ socket: this, origin, epoch: state.socketEpoch });
          if (state.sockets.length > 8) state.sockets.shift();
          emit('harness.socket_observed', { origin, epoch: state.socketEpoch });
        }
      }
      send(data) {
        // Observe, but never delay, alter, duplicate, or replace, the product's
        // exact-origin provider frame. Native send remains the mutation.
        super.send(data);
        const entry = state.sockets.find((candidate) => candidate.socket === this);
        if (!entry || typeof data !== 'string') return;
        const active = [...state.activeInputs.values()].filter((candidate) => candidate.started && !candidate.terminal);
        if (active.length !== 1) {
          if (active.length > 1) emit('harness.input_frame_ambiguous', { active_injection_count: active.length, harness_socket_ordinal: entry.epoch });
          return;
        }
        let audio = null;
        try {
          const payload = JSON.parse(data);
          const candidate = payload?.realtimeInput?.audio;
          if (candidate && typeof candidate.data === 'string' && typeof candidate.mimeType === 'string' && candidate.mimeType.startsWith('audio/pcm')) audio = candidate;
        } catch { return; }
        if (!audio) return;
        try {
          const binary = atob(audio.data);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          let nonzeroByteCount = 0;
          for (const byte of bytes) if (byte !== 0) nonzeroByteCount += 1;
          const current = active[0];
          current.forwardedFrameCount += 1;
          const frameSeq = current.forwardedFrameCount;
          const proof = crypto.subtle.digest('SHA-256', bytes).then((digest) => {
            const frameSha256 = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
            emit('harness.input_frame_forwarded', { operation_id: current.operationId, utterance_id: current.utteranceId, frame_seq: frameSeq, byte_length: bytes.length, nonzero_byte_count: nonzeroByteCount, sha256: frameSha256, mime_type: audio.mimeType, harness_socket_ordinal: entry.epoch });
          }).catch(() => emit('harness.input_frame_observation_failed', { operation_id: current.operationId, utterance_id: current.utteranceId, frame_seq: frameSeq }));
          current.pendingFrameProofs.push(proof);
        } catch {
          emit('harness.input_frame_observation_failed', { operation_id: active[0].operationId, utterance_id: active[0].utteranceId });
        }
      }
    }
    Object.defineProperties(LabWebSocket, { CONNECTING: { value: NativeWebSocket.CONNECTING }, OPEN: { value: NativeWebSocket.OPEN }, CLOSING: { value: NativeWebSocket.CLOSING }, CLOSED: { value: NativeWebSocket.CLOSED } });
    window.WebSocket = LabWebSocket;
    const bridge = Object.freeze({
      schedule: async ({ operationId, utteranceId, audioBase64, sha256, delayMs = 0, expectedSilence = false, settlementWindowMs, activeTarget = null }) => {
        const replay = state.scheduleReceipts.get(operationId);
        if (replay) return replay;
        const scheduling = (async () => {
          let source = null;
          let active = null;
          try {
          if (typeof audioBase64 !== 'string' || audioBase64.length > Math.ceil(options.maxAudioBytes * 4 / 3) + 16) throw new Error('audio payload rejected');
          if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10000) throw new Error('audio schedule rejected');
          const binary = atob(audioBase64);
          if (binary.length > options.maxAudioBytes) throw new Error('audio payload rejected');
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const actualDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
          if (actualDigest !== sha256) throw new Error('audio sha256 mismatch');
          if (audioContext.state === 'suspended') await audioContext.resume();
          const decoded = await audioContext.decodeAudioData(bytes.buffer.slice(0));
          source = audioContext.createBufferSource();
          source.buffer = decoded;
          source.connect(destination);
          const scheduledAt = audioContext.currentTime + delayMs / 1000;
          if (typeof expectedSilence !== 'boolean' || (settlementWindowMs !== undefined && (!Number.isFinite(settlementWindowMs) || settlementWindowMs < 0 || settlementWindowMs > 10000))) throw new Error('audio expectation rejected');
          const correlation = { operation_id: operationId, utterance_id: utteranceId, source_sha256: sha256, expected_silence: expectedSilence, ...(settlementWindowMs === undefined ? {} : { settlement_window_ms: settlementWindowMs }) };
          active = { source, operationId, utteranceId, sha256, expectedSilence, settlementWindowMs, startedTimer: null, terminal: false, started: false, forwardedFrameCount: 0, pendingFrameProofs: [] };
          const announceStartedAtBoundary = () => {
            if (active.terminal || active.started) return;
            if (audioContext.state === 'running' && audioContext.currentTime >= scheduledAt) {
              active.started = true;
              emit('audio.input.started', { operation_id: operationId, utterance_id: utteranceId, sha256, scheduled_context_time: scheduledAt, actual_context_time: audioContext.currentTime });
              emitProductInputBoundary('started', { ...correlation, scheduled_context_time: scheduledAt, actual_context_time: audioContext.currentTime });
              return;
            }
            active.startedTimer = setTimeout(announceStartedAtBoundary, 5);
          };
          active.startedTimer = setTimeout(announceStartedAtBoundary, Math.max(0, (scheduledAt - audioContext.currentTime) * 1000));
          state.activeInputs.set(utteranceId, active);
          source.addEventListener('ended', async () => {
            if (active.terminal) return;
            active.terminal = true;
            clearTimeout(active.startedTimer);
            if (!active.started) {
              active.started = true;
              emit('audio.input.started', { operation_id: operationId, utterance_id: utteranceId, sha256, scheduled_context_time: scheduledAt, actual_context_time: audioContext.currentTime });
              emitProductInputBoundary('started', { ...correlation, scheduled_context_time: scheduledAt, actual_context_time: audioContext.currentTime });
            }
            await Promise.allSettled(active.pendingFrameProofs);
            emit('audio.input.completed', { operation_id: operationId, utterance_id: utteranceId, sha256, actual_context_time: audioContext.currentTime, forwarded_frame_count: active.forwardedFrameCount });
            emitProductInputBoundary('completed', { ...correlation, actual_context_time: audioContext.currentTime });
            state.activeInputs.delete(utteranceId);
            source.disconnect();
          }, { once: true });
          // No product WebSocket/capture callback can interleave between this
          // synchronous app-ring check and source.start in the same browser
          // task. This closes the queue/worker drain TOCTOU window.
          assertProductTargetActive(activeTarget);
          source.start(scheduledAt);
          const scheduled = emit('audio.input.scheduled', { operation_id: operationId, utterance_id: utteranceId, sha256, byte_length: bytes.length, scheduled_context_time: scheduledAt, duration_seconds: decoded.duration, expected_silence: expectedSilence, ...(settlementWindowMs === undefined ? {} : { settlement_window_ms: settlementWindowMs }) });
          emitProductInputBoundary('scheduled', { ...correlation, scheduled_context_time: scheduledAt });
          return scheduled;
          } catch (error) {
            if (active) { active.terminal = true; clearTimeout(active.startedTimer); state.activeInputs.delete(utteranceId); }
            try { source?.disconnect(); } catch {}
            emit('audio.input.rejected', { operation_id: operationId, utterance_id: utteranceId, reason: error instanceof Error ? error.message : 'invalid payload' });
            if (typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)) emitProductInputBoundary('rejected', { operation_id: operationId, utterance_id: utteranceId, source_sha256: sha256, expected_silence: expectedSilence === true, reason: 'invalid_audio_or_schedule' });
            throw error;
          }
        })();
        state.scheduleReceipts.set(operationId, scheduling);
        try { return await scheduling; }
        catch (error) { state.scheduleReceipts.delete(operationId); throw error; }
      },
      rotate: (activeTarget = null) => {
        const candidate = [...state.sockets].reverse().find((entry) => entry.socket.readyState === NativeWebSocket.OPEN);
        if (!candidate) throw new Error('no allowlisted live socket is open');
        // As above, capture inspection and close are synchronous in one task.
        assertProductTargetActive(activeTarget);
        candidate.socket.close(4100, 'voice-lab-rotation');
        return emit('harness.socket_rotation_requested', { harness_socket_ordinal: candidate.epoch, origin: candidate.origin });
      },
      drain: (afterSeq = 0) => {
        const min = state.events[0]?.seq || state.seq + 1;
        return { min_seq: min, latest_seq: state.seq, events: state.events.filter((event) => event.seq > afterSeq) };
      },
    });
    addEventListener('pagehide', () => {
      for (const [utteranceId, active] of state.activeInputs) {
        active.terminal = true;
        clearTimeout(active.startedTimer);
        try { active.source.stop(); } catch {}
        emit('audio.input.interrupted', { operation_id: active.operationId, utterance_id: utteranceId, sha256: active.sha256, reason: 'pagehide' });
        emitProductInputBoundary('interrupted', { operation_id: active.operationId, utterance_id: utteranceId, source_sha256: active.sha256, expected_silence: active.expectedSilence === true, ...(active.settlementWindowMs === undefined ? {} : { settlement_window_ms: active.settlementWindowMs }), reason: 'pagehide' });
      }
      state.activeInputs.clear();
    }, { once: true });
    Object.defineProperty(window, '__sophiaVoiceLab', { configurable: false, enumerable: false, writable: false, value: bridge });
    emit('harness.initialized', { page_owned_audio_context: true, synthetic_audio_tracks: destination.stream.getAudioTracks().length });
  })();`;
}
