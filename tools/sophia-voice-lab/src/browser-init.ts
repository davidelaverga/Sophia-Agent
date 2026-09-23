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
    // Passive, content-free census of INBOUND provider frames (C038). It only
    // reads a copy of each message after the browser delivered it; it never
    // alters, consumes, reorders or suppresses what the product receives.
    // Exported: fixed documented keys, booleans as true/false/absent/
    // unavailable, transcript UTF-8 byte LENGTHS, part counts, finite
    // non-negative token counts, and unknown-key COUNTS. Never text, audio,
    // handles, field names outside the allowlist, or any other value.
    // Identical consecutive projections are coalesced with explicit counts;
    // emitted events per socket are capped. Observation WORK is bounded too:
    // at most INBOUND_MAX_QUEUED_FRAMES / _BYTES (estimate) await inspection,
    // oversized frames are typed without retaining their payload, and after
    // the cap nothing is inspected. Every frame is accounted for in the close
    // summary: received = emitted + suppressed + queue_dropped
    // + uninspected_after_cap + in_flight.
    const INBOUND_MAX_BYTES = 1048576;
    const INBOUND_MAX_QUEUED_FRAMES = 64;
    const INBOUND_MAX_QUEUED_BYTES = 8388608;
    const INBOUND_MAX_EVENTS = 512;
    const INBOUND_REPEAT_FLUSH = 25;
    const SERVER_TOP_KEYS = ['setupComplete', 'serverContent', 'toolCall', 'toolCallCancellation', 'goAway', 'sessionResumptionUpdate', 'usageMetadata'];
    const SERVER_CONTENT_KEYS = ['modelTurn', 'turnComplete', 'interrupted', 'generationComplete', 'waitingForInput', 'inputTranscription', 'interimInputTranscription', 'outputTranscription', 'groundingMetadata', 'urlContextMetadata', 'interactionStatus', 'speechState'];
    const USAGE_TOKEN_KEYS = ['promptTokenCount', 'cachedContentTokenCount', 'responseTokenCount', 'toolUsePromptTokenCount', 'thoughtsTokenCount', 'totalTokenCount'];
    const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
    const allowlistedKeys = (record, allowed) => {
      const known = [];
      let unknown = 0;
      for (const key of Object.keys(record)) {
        if (allowed.indexOf(key) === -1) unknown += 1;
        else known.push(key);
      }
      known.sort();
      return { known, unknown };
    };
    const booleanState = (record, key) => !hasOwn(record, key) ? 'absent' : record[key] === true ? 'true' : record[key] === false ? 'false' : 'unavailable';
    const transcriptUtf8Bytes = (record, key) => {
      if (!hasOwn(record, key)) return null;
      const value = record[key];
      if (!isPlainRecord(value) || typeof value.text !== 'string') return 'unavailable';
      try { return new TextEncoder().encode(value.text).length; } catch { return 'unavailable'; }
    };
    const projectServerContent = (content) => {
      if (!isPlainRecord(content)) return 'unavailable';
      const keys = allowlistedKeys(content, SERVER_CONTENT_KEYS);
      const turn = content.modelTurn;
      const parts = isPlainRecord(turn) && Array.isArray(turn.parts) ? turn.parts : null;
      const countParts = (predicate) => parts === null ? null : parts.filter((part) => isPlainRecord(part) && predicate(part)).length;
      return {
        fields: keys.known,
        unknown_field_count: keys.unknown,
        turn_complete: booleanState(content, 'turnComplete'),
        interrupted: booleanState(content, 'interrupted'),
        generation_complete: booleanState(content, 'generationComplete'),
        waiting_for_input: booleanState(content, 'waitingForInput'),
        input_transcription_utf8_bytes: transcriptUtf8Bytes(content, 'inputTranscription'),
        interim_input_transcription_utf8_bytes: transcriptUtf8Bytes(content, 'interimInputTranscription'),
        output_transcription_utf8_bytes: transcriptUtf8Bytes(content, 'outputTranscription'),
        model_turn_part_count: hasOwn(content, 'modelTurn') ? (parts === null ? 'unavailable' : parts.length) : null,
        model_turn_audio_part_count: countParts((part) => isPlainRecord(part.inlineData) && typeof part.inlineData.mimeType === 'string' && part.inlineData.mimeType.startsWith('audio/')),
        model_turn_text_part_count: countParts((part) => typeof part.text === 'string'),
      };
    };
    const projectInbound = (payload) => {
      if (!isPlainRecord(payload)) return { frame_kind: 'unrecognized' };
      const top = allowlistedKeys(payload, SERVER_TOP_KEYS);
      const resumption = payload.sessionResumptionUpdate;
      const usage = payload.usageMetadata;
      return {
        frame_kind: top.known.join('+') || (top.unknown > 0 ? 'unrecognized' : 'empty'),
        unknown_top_level_field_count: top.unknown,
        server_content: hasOwn(payload, 'serverContent') ? projectServerContent(payload.serverContent) : null,
        session_resumption: !hasOwn(payload, 'sessionResumptionUpdate') ? null : isPlainRecord(resumption)
          ? { resumable: booleanState(resumption, 'resumable'), new_handle_present: typeof resumption.newHandle === 'string' && resumption.newHandle.length > 0 }
          : 'unavailable',
        usage_tokens: !hasOwn(payload, 'usageMetadata') ? null : isPlainRecord(usage)
          ? Object.fromEntries(USAGE_TOKEN_KEYS.map((key) => [key, Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null]))
          : 'unavailable',
      };
    };
    const UNREADABLE_INBOUND = Symbol('unreadable');
    const OVERSIZED_INBOUND = Symbol('oversized');
    const isBinaryInbound = (data) => data instanceof ArrayBuffer || ArrayBuffer.isView(data);
    const isBlobInbound = (data) => Boolean(data) && typeof data.size === 'number' && typeof data.text === 'function';
    // Cheap, synchronous screen: every UTF-16 code unit encodes to >= 1 UTF-8 byte.
    const inboundCheaplyOversized = (data) => typeof data === 'string' ? data.length > INBOUND_MAX_BYTES
      : isBinaryInbound(data) ? data.byteLength > INBOUND_MAX_BYTES : isBlobInbound(data) ? data.size > INBOUND_MAX_BYTES : false;
    const inboundRetainedBytes = (data) => typeof data === 'string' ? data.length * 2
      : isBinaryInbound(data) ? data.byteLength : isBlobInbound(data) ? data.size : 0;
    const inboundText = async (data) => {
      if (data === UNREADABLE_INBOUND) return { uninspectable: true };
      if (data === OVERSIZED_INBOUND) return { oversized: true };
      if (typeof data === 'string') {
        if (data.length > INBOUND_MAX_BYTES) return { oversized: true };
        // Enforce the UTF-8 byte bound before parsing; encode only when the
        // code-unit count cannot already prove the string fits.
        if (data.length * 3 > INBOUND_MAX_BYTES && new TextEncoder().encode(data).length > INBOUND_MAX_BYTES) return { oversized: true };
        return { text: data };
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength > INBOUND_MAX_BYTES ? { oversized: true } : { text: new TextDecoder().decode(data) };
      if (data && typeof data.size === 'number' && typeof data.text === 'function') return data.size > INBOUND_MAX_BYTES ? { oversized: true } : { text: await data.text() };
      return { unrecognized: true };
    };
    const emitInboundSummary = (entry) => {
      const inbound = entry.inbound;
      emit('harness.provider_frame_received_summary', { harness_socket_ordinal: entry.epoch, received_count: inbound.received,
        inspected_count: inbound.emitted + inbound.suppressed, emitted_count: inbound.emitted, suppressed_count: inbound.suppressed,
        pending_repeat_count: inbound.repeats, oversized_count: inbound.oversized, unparsed_count: inbound.unparsed, cap_reached: inbound.capReached,
        queue_dropped_count: inbound.queueDropped, uninspected_after_cap_count: inbound.uninspectedAfterCap, in_flight_count: inbound.queued,
        capture_limited: inbound.queueDropped > 0 || inbound.uninspectedAfterCap > 0 });
    };
    // Exactly one capped event per socket, from whichever path first meets the cap.
    const markInboundCapReached = (entry, ordinal) => {
      const inbound = entry.inbound;
      if (inbound.capReached) return;
      inbound.capReached = true;
      emit('harness.provider_frame_received_capped', { harness_socket_ordinal: entry.epoch, inbound_ordinal: ordinal, emitted_count: inbound.emitted });
    };
    const recordInbound = (entry, projection, ordinal) => {
      const inbound = entry.inbound;
      const key = JSON.stringify(projection);
      if (key === inbound.lastKey && inbound.repeats + 1 < INBOUND_REPEAT_FLUSH) { inbound.repeats += 1; inbound.suppressed += 1; return; }
      if (inbound.emitted >= INBOUND_MAX_EVENTS) {
        inbound.suppressed += 1;
        markInboundCapReached(entry, ordinal);
        return;
      }
      inbound.emitted += 1;
      emit('harness.provider_frame_received', { harness_socket_ordinal: entry.epoch, inbound_ordinal: ordinal,
        repeats_suppressed_before: key === inbound.lastKey ? inbound.repeats : 0, previous_repeats_suppressed: key === inbound.lastKey ? 0 : inbound.repeats, ...projection });
      inbound.lastKey = key;
      inbound.repeats = 0;
    };
    const observeInbound = (entry, data) => {
      const inbound = entry.inbound;
      inbound.received += 1;
      const ordinal = inbound.received;
      // After the event cap nothing is inspected; the frame is only counted.
      if (inbound.emitted >= INBOUND_MAX_EVENTS) { inbound.uninspectedAfterCap += 1; markInboundCapReached(entry, ordinal); return; }
      let observed = data;
      let retained = 0;
      try {
        if (observed !== UNREADABLE_INBOUND && inboundCheaplyOversized(observed)) observed = OVERSIZED_INBOUND;
        retained = typeof observed === 'symbol' ? 0 : inboundRetainedBytes(observed);
      } catch { observed = UNREADABLE_INBOUND; retained = 0; }
      if (inbound.queued + 1 > INBOUND_MAX_QUEUED_FRAMES || inbound.queuedBytes + retained > INBOUND_MAX_QUEUED_BYTES) {
        inbound.queueDropped += 1;
        if (!inbound.queueLimited) {
          inbound.queueLimited = true;
          emit('harness.provider_frame_received_limited', { harness_socket_ordinal: entry.epoch, inbound_ordinal: ordinal,
            reason: inbound.queued + 1 > INBOUND_MAX_QUEUED_FRAMES ? 'observation_queue_frames' : 'observation_queue_bytes',
            queued_frames: inbound.queued, queued_bytes_estimate: inbound.queuedBytes });
        }
        return;
      }
      inbound.queued += 1;
      inbound.queuedBytes += retained;
      inbound.chain = inbound.chain.then(async () => {
        let projection;
        try {
          const read = await inboundText(observed);
          if (read.uninspectable) projection = { frame_kind: 'uninspectable' };
          else if (read.oversized) { inbound.oversized += 1; projection = { frame_kind: 'oversized' }; }
          else if (read.unrecognized) projection = { frame_kind: 'unrecognized_transport' };
          else {
            let payload;
            try { payload = JSON.parse(read.text); } catch { inbound.unparsed += 1; payload = undefined; }
            projection = payload === undefined ? { frame_kind: 'unparsed' } : projectInbound(payload);
          }
        } catch { projection = { frame_kind: 'uninspectable' }; }
        observed = null;
        inbound.queued -= 1;
        inbound.queuedBytes -= retained;
        recordInbound(entry, projection, ordinal);
      }).catch(() => undefined);
    };
    const attachInboundCensus = (socket, entry) => {
      entry.inbound = { received: 0, emitted: 0, suppressed: 0, oversized: 0, unparsed: 0, capReached: false, lastKey: null, repeats: 0,
        queued: 0, queuedBytes: 0, queueDropped: 0, queueLimited: false, uninspectedAfterCap: 0, chain: Promise.resolve() };
      try {
        if (typeof socket.addEventListener !== 'function') return;
        socket.addEventListener('message', (event) => {
          // A frame whose data cannot even be read is still counted.
          let data = UNREADABLE_INBOUND;
          try { data = event ? event.data : undefined; } catch {}
          try { observeInbound(entry, data); } catch {}
        });
        socket.addEventListener('close', () => { entry.inbound.chain = entry.inbound.chain.then(() => emitInboundSummary(entry)).catch(() => undefined); });
      } catch {}
    };
    const NativeWebSocket = window.WebSocket;
    class LabWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        let origin = null;
        try { origin = new URL(String(url), location.href).origin; } catch {}
        if (origin && allowedWsOrigins.has(origin)) {
          state.socketEpoch += 1;
          const entry = { socket: this, origin, epoch: state.socketEpoch, audioStreamEndCount: 0 };
          state.sockets.push(entry);
          if (state.sockets.length > 8) state.sockets.shift();
          attachInboundCensus(this, entry);
          emit('harness.socket_observed', { origin, epoch: state.socketEpoch });
        }
      }
      send(data) {
        // Observe, but never delay, alter, duplicate, or replace, the product's
        // exact-origin provider frame. Native send remains the mutation.
        super.send(data);
        const entry = state.sockets.find((candidate) => candidate.socket === this);
        if (!entry) return;
        // Content-free census of EVERY outbound frame on the provider socket.
        // The projections below are deliberately selective, so without this a
        // realtimeInput.text/video or toolResponse frame is sent and never
        // recorded, and the evidence cannot show what the client actually put
        // on the wire.
        //
        // Classification is a FIXED allowlist of documented protocol keys.
        // Arbitrary property names are never exported: anything outside the
        // allowlist is only counted, because a caller-chosen field name is
        // itself payload-derived content.
        const wireByteLength = (value) => {
          try {
            if (typeof value === 'string') return new TextEncoder().encode(value).length;
            if (value instanceof ArrayBuffer) return value.byteLength;
            if (ArrayBuffer.isView(value)) return value.byteLength;
            if (value && typeof value.size === 'number') return value.size;
          } catch {}
          return null;
        };
        const classify = (record, allowed) => {
          if (!record || typeof record !== 'object' || Array.isArray(record)) return { known: [], unknown: 0 };
          const known = [];
          let unknown = 0;
          for (const key of Object.keys(record)) {
            if (allowed.indexOf(key) === -1) unknown += 1;
            else if (known.indexOf(key) === -1) known.push(key);
          }
          known.sort();
          return { known, unknown };
        };
        if (typeof data !== 'string') {
          // Binary frames are recorded by fixed kind and size only; their
          // contents are never inspected.
          emit('harness.provider_frame_sent', { harness_socket_ordinal: entry.epoch, frame_kind: 'binary',
            realtime_input_kind: null, unknown_top_level_field_count: 0, unknown_realtime_input_field_count: 0,
            byte_length: wireByteLength(data) });
          return;
        }
        let payload;
        try { payload = JSON.parse(data); } catch {
          emit('harness.provider_frame_sent', { harness_socket_ordinal: entry.epoch, frame_kind: 'unparsed',
            realtime_input_kind: null, unknown_top_level_field_count: 0, unknown_realtime_input_field_count: 0,
            byte_length: wireByteLength(data) });
          return;
        }
        try {
          const top = classify(payload, ['setup', 'realtimeInput', 'clientContent', 'toolResponse']);
          const realtime = classify(payload ? payload.realtimeInput : null,
            ['audio', 'video', 'text', 'audioStreamEnd', 'activityStart', 'activityEnd', 'mediaChunks']);
          emit('harness.provider_frame_sent', {
            harness_socket_ordinal: entry.epoch,
            frame_kind: top.known.join('+') || (top.unknown > 0 ? 'unrecognized' : 'empty'),
            realtime_input_kind: realtime.known.join('+') || null,
            unknown_top_level_field_count: top.unknown,
            unknown_realtime_input_field_count: realtime.unknown,
            byte_length: wireByteLength(data),
          });
        } catch {
          emit('harness.provider_frame_sent', { harness_socket_ordinal: entry.epoch, frame_kind: 'uninspectable',
            realtime_input_kind: null, unknown_top_level_field_count: 0, unknown_realtime_input_field_count: 0,
            byte_length: wireByteLength(data) });
        }
        // Setup and stream-end precede/follow active synthetic input. Observe
        // only this fixed content-free projection, never the setup envelope.
        const setup = payload?.setup;
        if (setup && typeof setup === 'object' && !Array.isArray(setup)) {
          const modalities = setup.generationConfig?.responseModalities;
          const validModalities = Array.isArray(modalities) && modalities.length <= 2
            && modalities.every((value) => ['AUDIO', 'TEXT'].includes(value));
          const aad = setup.realtimeInputConfig?.automaticActivityDetection;
          emit('harness.provider_setup_sent', {
            harness_socket_ordinal: entry.epoch,
            model: typeof setup.model === 'string' && /^models\\/gemini-[a-z0-9.-]{1,120}$/.test(setup.model) ? setup.model : null,
            response_modalities: validModalities ? modalities : null,
            input_audio_transcription_present: Object.prototype.hasOwnProperty.call(setup, 'inputAudioTranscription'),
            output_audio_transcription_present: Object.prototype.hasOwnProperty.call(setup, 'outputAudioTranscription'),
            automatic_activity_detection_disabled: typeof aad?.disabled === 'boolean' ? aad.disabled : null,
          });
        }
        if (payload?.realtimeInput?.audioStreamEnd === true) {
          entry.audioStreamEndCount += 1;
          emit('harness.provider_audio_stream_end_sent', { harness_socket_ordinal: entry.epoch, audio_stream_end_count: entry.audioStreamEndCount });
        }
        const active = [...state.activeInputs.values()].filter((candidate) => candidate.started && !candidate.terminal);
        if (active.length !== 1) {
          if (active.length > 1) emit('harness.input_frame_ambiguous', { active_injection_count: active.length, harness_socket_ordinal: entry.epoch });
          return;
        }
        let audio = null;
        try {
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
