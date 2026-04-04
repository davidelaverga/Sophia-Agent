'use client';

import { useChatStore } from '../stores/chat-store';
import { useMessageMetadataStore } from '../stores/message-metadata-store';
import { useRecapStore } from '../stores/recap-store';
import { useSessionStore } from '../stores/session-store';
import { useVoiceStore } from '../stores/voice-store';
import { getDebugSnapshot, type DebugSnapshot } from './debug-tools';

const CAPTURE_FLAG_STORAGE_KEY = 'sophia.capture.enabled';
const MAX_CAPTURE_EVENTS = 500;
const CAPTURED_STORAGE_KEYS = [
  'sophia-session-store',
  'sophia-recap',
  'sophia.message-metadata.v1',
  'sophia-conversation-store',
  'sophia-session-history',
  'sophia-connectivity',
  'sophia-session',
  'sophia-conversation-history',
  'sophia_pending_interrupt',
];
const MICROPHONE_AUDIO_RMS_THRESHOLD = 0.002;
const MICROPHONE_SAMPLE_INTERVAL_MS = 100;

type SophiaCaptureEvent = {
  seq: number;
  recordedAt: string;
  category: string;
  name: string;
  payload?: unknown;
};

type SophiaCaptureMicrophoneConstraintSummary = {
  audioConstraintType: 'none' | 'boolean' | 'object';
  hasAudioConstraint: boolean;
  hasVideoConstraint: boolean;
};

type SophiaCaptureMicrophoneTrackSettings = {
  autoGainControl: boolean | null;
  channelCount: number | null;
  deviceId: string | null;
  echoCancellation: boolean | null;
  latency: number | null;
  noiseSuppression: boolean | null;
  sampleRate: number | null;
  sampleSize: number | null;
};

type SophiaCaptureMicrophoneTrackSummary = {
  acquiredAt: string;
  detectedAudio: boolean;
  enabled: boolean;
  endedAt: string | null;
  firstAudioAt: string | null;
  label: string | null;
  lastAudioAt: string | null;
  maxAbsPeak: number | null;
  maxRms: number | null;
  muted: boolean;
  nonSilentSampleWindows: number;
  readyState: string;
  sampleWindowCount: number;
  settings: SophiaCaptureMicrophoneTrackSettings;
  streamId: string;
  trackId: string;
};

type SophiaCaptureMicrophoneStreamSummary = {
  acquiredAt: string;
  active: boolean;
  constraints: SophiaCaptureMicrophoneConstraintSummary;
  streamId: string;
  trackIds: string[];
};

export type SophiaCaptureMicrophoneSummary = {
  audioTrackCount: number;
  detectedAudio: boolean;
  errors: string[];
  firstAudioAt: string | null;
  firstStreamAt: string | null;
  lastAudioAt: string | null;
  maxAbsPeak: number | null;
  maxRms: number | null;
  nonSilentSampleWindows: number;
  patchInstalled: boolean;
  streamCount: number;
  streams: SophiaCaptureMicrophoneStreamSummary[];
  totalSampleWindows: number;
  tracks: SophiaCaptureMicrophoneTrackSummary[];
};

type SophiaCaptureState = {
  microphone: SophiaCaptureMicrophoneSummary;
  startedAt: string;
  seq: number;
  events: SophiaCaptureEvent[];
};

export type SophiaCaptureSnapshot = {
  capturedAt: string;
  location: {
    href: string;
    pathname: string;
    title: string;
    theme: string | null;
  };
  debug: DebugSnapshot;
  session: {
    sessionId: string;
    threadId: string;
    status: string;
    isActive: boolean;
    presetType: string;
    contextMode: string;
    voiceMode: boolean;
    startedAt: string;
    endedAt: string | null;
    lastActivityAt: string | null;
    messageCount: number;
  } | null;
  transcript: {
    chatMessages: Array<{
      id: string;
      role: string;
      content: string;
      createdAt: number;
      source: string | null;
      status: string | null;
      incomplete: boolean;
      audioUrl: string | null;
    }>;
    voiceMessages: Array<{
      id: string;
      content: string;
      timestamp: number;
    }>;
    dom: {
      articleCount: number;
      articles: Array<{
        label: string | null;
        text: string;
      }>;
    };
  };
  artifacts: {
    sessionArtifacts: unknown;
    recapArtifacts: unknown;
    recapCommitStatus: string | null;
    dom: {
      railLabel: string | null;
      takeawayText: string | null;
      reflectionText: string | null;
      memoriesText: string | null;
      panelVisible: boolean;
    };
  };
  harness: {
    microphone: SophiaCaptureMicrophoneSummary;
  };
  metadata: {
    currentSessionId: string | null;
    currentThreadId: string | null;
    currentRunId: string | null;
    emotionalWeather: unknown;
  };
  presence: {
    labels: string[];
  };
  storage: Record<string, unknown>;
};

export type SophiaCaptureBundle = {
  startedAt: string;
  exportedAt: string;
  eventCount: number;
  events: SophiaCaptureEvent[];
  snapshot: SophiaCaptureSnapshot;
};

type SophiaCaptureApi = {
  enable: () => void;
  disable: () => void;
  clear: () => void;
  isEnabled: () => boolean;
  snapshot: () => SophiaCaptureSnapshot;
  export: () => SophiaCaptureBundle;
  getEvents: () => SophiaCaptureEvent[];
};

declare global {
  interface Window {
    __SOPHIA_CAPTURE_ENABLED__?: boolean;
    __sophiaCapture?: SophiaCaptureApi;
    __sophiaCaptureState?: SophiaCaptureState;
    __sophiaCaptureMicProbeInstalled__?: boolean;
  }
}

function canUseCapture(): boolean {
  return process.env.NODE_ENV === 'development' && typeof window !== 'undefined';
}

function createEmptyMicrophoneSummary(
  patchInstalled = false
): SophiaCaptureMicrophoneSummary {
  return {
    audioTrackCount: 0,
    detectedAudio: false,
    errors: [],
    firstAudioAt: null,
    firstStreamAt: null,
    lastAudioAt: null,
    maxAbsPeak: null,
    maxRms: null,
    nonSilentSampleWindows: 0,
    patchInstalled,
    streamCount: 0,
    streams: [],
    totalSampleWindows: 0,
    tracks: [],
  };
}

function createCaptureState(): SophiaCaptureState {
  return {
    microphone: createEmptyMicrophoneSummary(window.__sophiaCaptureMicProbeInstalled__ === true),
    startedAt: new Date().toISOString(),
    seq: 0,
    events: [],
  };
}

function getCaptureState(): SophiaCaptureState | null {
  if (!canUseCapture()) return null;
  if (!window.__sophiaCaptureState) {
    window.__sophiaCaptureState = createCaptureState();
  }
  return window.__sophiaCaptureState;
}

function setCaptureEnabled(enabled: boolean): void {
  if (!canUseCapture()) return;

  window.__SOPHIA_CAPTURE_ENABLED__ = enabled;
  try {
    if (enabled) {
      window.localStorage.setItem(CAPTURE_FLAG_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(CAPTURE_FLAG_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage failures in capture helpers.
  }
}

function isCaptureEnabled(): boolean {
  if (!canUseCapture()) return false;
  if (window.__SOPHIA_CAPTURE_ENABLED__ === true) return true;

  try {
    return window.localStorage.getItem(CAPTURE_FLAG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function clearCaptureState(): void {
  if (!canUseCapture()) return;

  const state = getCaptureState();
  if (!state) {
    return;
  }

  state.startedAt = new Date().toISOString();
  state.seq = 0;
  state.events = [];
  state.microphone = createEmptyMicrophoneSummary(window.__sophiaCaptureMicProbeInstalled__ === true);
}

function clonePayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;

  try {
    return structuredClone(payload);
  } catch {
    try {
      return JSON.parse(JSON.stringify(payload)) as unknown;
    } catch {
      return String(payload);
    }
  }
}

function parseStoredValue(raw: string | null): unknown {
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;

  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function formatProbeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function summarizeMediaConstraints(
  constraints: MediaStreamConstraints | undefined
): SophiaCaptureMicrophoneConstraintSummary {
  const audio = constraints?.audio;
  const video = constraints?.video;

  return {
    audioConstraintType:
      audio === undefined || audio === false ? 'none' : typeof audio === 'boolean' ? 'boolean' : 'object',
    hasAudioConstraint: audio !== undefined && audio !== false,
    hasVideoConstraint: video !== undefined && video !== false,
  };
}

function serializeTrackSettings(track: MediaStreamTrack): SophiaCaptureMicrophoneTrackSettings {
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;

  return {
    autoGainControl:
      typeof settings?.autoGainControl === 'boolean' ? settings.autoGainControl : null,
    channelCount:
      typeof settings?.channelCount === 'number' && Number.isFinite(settings.channelCount)
        ? settings.channelCount
        : null,
    deviceId: typeof settings?.deviceId === 'string' ? settings.deviceId : null,
    echoCancellation:
      typeof settings?.echoCancellation === 'boolean' ? settings.echoCancellation : null,
    latency:
      typeof settings?.latency === 'number' && Number.isFinite(settings.latency)
        ? settings.latency
        : null,
    noiseSuppression:
      typeof settings?.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
    sampleRate:
      typeof settings?.sampleRate === 'number' && Number.isFinite(settings.sampleRate)
        ? settings.sampleRate
        : null,
    sampleSize:
      typeof settings?.sampleSize === 'number' && Number.isFinite(settings.sampleSize)
        ? settings.sampleSize
        : null,
  };
}

function refreshMicrophoneSummary(state: SophiaCaptureState): void {
  const microphone = state.microphone;

  microphone.patchInstalled = window.__sophiaCaptureMicProbeInstalled__ === true;
  microphone.streamCount = microphone.streams.length;
  microphone.audioTrackCount = microphone.tracks.length;
  microphone.firstStreamAt =
    microphone.streams
      .map((stream) => stream.acquiredAt)
      .sort()[0] ?? null;
  microphone.detectedAudio = microphone.tracks.some((track) => track.detectedAudio);
  microphone.firstAudioAt =
    microphone.tracks
      .map((track) => track.firstAudioAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;
  microphone.lastAudioAt =
    microphone.tracks
      .map((track) => track.lastAudioAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  microphone.totalSampleWindows = microphone.tracks.reduce(
    (total, track) => total + track.sampleWindowCount,
    0
  );
  microphone.nonSilentSampleWindows = microphone.tracks.reduce(
    (total, track) => total + track.nonSilentSampleWindows,
    0
  );

  const maxRms = microphone.tracks
    .map((track) => track.maxRms)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const maxAbsPeak = microphone.tracks
    .map((track) => track.maxAbsPeak)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  microphone.maxRms = maxRms.length > 0 ? Math.max(...maxRms) : null;
  microphone.maxAbsPeak = maxAbsPeak.length > 0 ? Math.max(...maxAbsPeak) : null;

  for (const stream of microphone.streams) {
    stream.active = stream.trackIds.some((trackId) => {
      const track = microphone.tracks.find((entry) => entry.trackId === trackId);
      return track ? track.readyState !== 'ended' : false;
    });
  }
}

function ensureMicrophoneStreamSummary(
  state: SophiaCaptureState,
  stream: MediaStream,
  constraints: MediaStreamConstraints | undefined,
  acquiredAt: string
): SophiaCaptureMicrophoneStreamSummary {
  const existing = state.microphone.streams.find((entry) => entry.streamId === stream.id);

  if (existing) {
    existing.constraints = summarizeMediaConstraints(constraints);
    existing.trackIds = stream.getAudioTracks().map((track) => track.id);
    existing.active = stream.getAudioTracks().some((track) => track.readyState !== 'ended');
    refreshMicrophoneSummary(state);
    return existing;
  }

  const created: SophiaCaptureMicrophoneStreamSummary = {
    acquiredAt,
    active: stream.getAudioTracks().some((track) => track.readyState !== 'ended'),
    constraints: summarizeMediaConstraints(constraints),
    streamId: stream.id,
    trackIds: stream.getAudioTracks().map((track) => track.id),
  };

  state.microphone.streams.push(created);
  refreshMicrophoneSummary(state);
  return created;
}

function ensureMicrophoneTrackSummary(
  state: SophiaCaptureState,
  stream: MediaStream,
  track: MediaStreamTrack,
  acquiredAt: string
): SophiaCaptureMicrophoneTrackSummary {
  const existing = state.microphone.tracks.find((entry) => entry.trackId === track.id);

  if (existing) {
    existing.enabled = track.enabled;
    existing.label = track.label || null;
    existing.muted = track.muted;
    existing.readyState = track.readyState;
    existing.settings = serializeTrackSettings(track);
    existing.streamId = stream.id;
    refreshMicrophoneSummary(state);
    return existing;
  }

  const created: SophiaCaptureMicrophoneTrackSummary = {
    acquiredAt,
    detectedAudio: false,
    enabled: track.enabled,
    endedAt: null,
    firstAudioAt: null,
    label: track.label || null,
    lastAudioAt: null,
    maxAbsPeak: null,
    maxRms: null,
    muted: track.muted,
    nonSilentSampleWindows: 0,
    readyState: track.readyState,
    sampleWindowCount: 0,
    settings: serializeTrackSettings(track),
    streamId: stream.id,
    trackId: track.id,
  };

  state.microphone.tracks.push(created);
  refreshMicrophoneSummary(state);
  return created;
}

function getMicrophoneTrackSummary(
  streamId: string,
  trackId: string
): SophiaCaptureMicrophoneTrackSummary | null {
  const state = getCaptureState();
  if (!state) {
    return null;
  }

  return (
    state.microphone.tracks.find(
      (entry) => entry.trackId === trackId && entry.streamId === streamId
    ) ?? null
  );
}

function pushMicrophoneError(message: string): void {
  const state = getCaptureState();
  if (!state) {
    return;
  }

  state.microphone.errors.push(message);
  refreshMicrophoneSummary(state);
}

function summarizeAudioWindow(samples: Float32Array): {
  maxAbsPeak: number;
  rms: number;
} {
  let maxAbsPeak = 0;
  let sumSquares = 0;

  for (const sample of samples) {
    const absolute = Math.abs(sample);
    if (absolute > maxAbsPeak) {
      maxAbsPeak = absolute;
    }
    sumSquares += sample * sample;
  }

  return {
    maxAbsPeak,
    rms: Math.sqrt(sumSquares / samples.length),
  };
}

function startMicrophoneTrackProbe(
  stream: MediaStream,
  track: MediaStreamTrack,
  constraints: MediaStreamConstraints | undefined
): void {
  const state = getCaptureState();
  if (!state) {
    return;
  }

  const acquiredAt = new Date().toISOString();
  ensureMicrophoneStreamSummary(state, stream, constraints, acquiredAt);
  ensureMicrophoneTrackSummary(state, stream, track, acquiredAt);

  const audioContext = new window.AudioContext();
  const source = audioContext.createMediaStreamSource(new MediaStream([track]));
  const analyser = audioContext.createAnalyser();
  const silentSink = audioContext.createGain();
  const samples = new Float32Array(analyser.fftSize);
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.1;
  silentSink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(silentSink);
  silentSink.connect(audioContext.destination);

  void audioContext.resume().catch((error) => {
    const message = `resume:${track.id}:${formatProbeError(error)}`;
    pushMicrophoneError(message);
    recordSophiaCaptureEvent({
      category: 'harness-input',
      name: 'microphone-probe-error',
      payload: {
        error: formatProbeError(error),
        phase: 'resume',
        streamId: stream.id,
        trackId: track.id,
      },
    });
  });

  const sampleTrack = () => {
    const currentState = getCaptureState();
    if (!currentState) {
      return;
    }

    const trackSummary = ensureMicrophoneTrackSummary(currentState, stream, track, acquiredAt);
    analyser.getFloatTimeDomainData(samples);
    const { maxAbsPeak, rms } = summarizeAudioWindow(samples);
    const observedAudio = rms >= MICROPHONE_AUDIO_RMS_THRESHOLD;
    trackSummary.sampleWindowCount += 1;
    trackSummary.maxAbsPeak = Math.max(trackSummary.maxAbsPeak ?? 0, maxAbsPeak);
    trackSummary.maxRms = Math.max(trackSummary.maxRms ?? 0, rms);

    if (observedAudio) {
      const observedAt = new Date().toISOString();
      trackSummary.nonSilentSampleWindows += 1;
      trackSummary.lastAudioAt = observedAt;

      if (!trackSummary.detectedAudio) {
        trackSummary.detectedAudio = true;
        trackSummary.firstAudioAt = observedAt;
        recordSophiaCaptureEvent({
          category: 'harness-input',
          name: 'microphone-audio-detected',
          payload: {
            maxAbsPeak,
            rms,
            streamId: stream.id,
            trackId: track.id,
          },
        });
      }
    }

    refreshMicrophoneSummary(currentState);
  };

  const intervalId = window.setInterval(sampleTrack, MICROPHONE_SAMPLE_INTERVAL_MS);

  const updateTrackLifecycle = (name: 'microphone-track-muted' | 'microphone-track-unmuted' | 'microphone-track-ended') => {
    const currentState = getCaptureState();
    if (!currentState) {
      return;
    }

    const trackSummary = ensureMicrophoneTrackSummary(currentState, stream, track, acquiredAt);
    trackSummary.enabled = track.enabled;
    trackSummary.muted = track.muted;
    trackSummary.readyState = track.readyState;
    trackSummary.settings = serializeTrackSettings(track);

    if (name === 'microphone-track-ended') {
      trackSummary.endedAt = new Date().toISOString();
    }

    refreshMicrophoneSummary(currentState);
    recordSophiaCaptureEvent({
      category: 'harness-input',
      name,
      payload: {
        readyState: track.readyState,
        streamId: stream.id,
        trackId: track.id,
      },
    });
  };

  const cleanup = () => {
    window.clearInterval(intervalId);
    source.disconnect();
    analyser.disconnect();
    silentSink.disconnect();
    void audioContext.close().catch(() => {});
    updateTrackLifecycle('microphone-track-ended');
  };

  track.addEventListener('mute', () => updateTrackLifecycle('microphone-track-muted'));
  track.addEventListener('unmute', () => updateTrackLifecycle('microphone-track-unmuted'));
  track.addEventListener('ended', cleanup, { once: true });
}

function instrumentMicrophoneStream(
  stream: MediaStream,
  constraints: MediaStreamConstraints | undefined
): void {
  const state = getCaptureState();
  if (!state) {
    return;
  }

  const acquiredAt = new Date().toISOString();
  const streamSummary = ensureMicrophoneStreamSummary(state, stream, constraints, acquiredAt);
  const audioTracks = stream.getAudioTracks();

  recordSophiaCaptureEvent({
    category: 'harness-input',
    name: 'microphone-stream-acquired',
    payload: {
      audioTrackCount: audioTracks.length,
      constraints: streamSummary.constraints,
      streamId: stream.id,
      trackIds: audioTracks.map((track) => track.id),
    },
  });

  if (audioTracks.length === 0) {
    pushMicrophoneError(`no-audio-tracks:${stream.id}`);
    recordSophiaCaptureEvent({
      category: 'harness-input',
      name: 'microphone-probe-error',
      payload: {
        error: 'No audio tracks returned from getUserMedia',
        phase: 'stream-acquired',
        streamId: stream.id,
      },
    });
    return;
  }

  for (const track of audioTracks) {
    ensureMicrophoneTrackSummary(state, stream, track, acquiredAt);
    try {
      startMicrophoneTrackProbe(stream, track, constraints);
    } catch (error) {
      const message = `probe:${track.id}:${formatProbeError(error)}`;
      pushMicrophoneError(message);
      recordSophiaCaptureEvent({
        category: 'harness-input',
        name: 'microphone-probe-error',
        payload: {
          error: formatProbeError(error),
          phase: 'probe-start',
          streamId: stream.id,
          trackId: track.id,
        },
      });
    }
  }

  refreshMicrophoneSummary(state);
}

function installMicrophoneCaptureProbe(): void {
  if (!canUseCapture() || window.__sophiaCaptureMicProbeInstalled__ === true) {
    return;
  }

  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    pushMicrophoneError('mediaDevices.getUserMedia unavailable');
    return;
  }

  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  mediaDevices.getUserMedia = async (
    constraints?: MediaStreamConstraints
  ): Promise<MediaStream> => {
    try {
      const stream = await originalGetUserMedia(constraints);
      instrumentMicrophoneStream(stream, constraints);
      return stream;
    } catch (error) {
      const message = `getUserMedia:${formatProbeError(error)}`;
      pushMicrophoneError(message);
      recordSophiaCaptureEvent({
        category: 'harness-input',
        name: 'microphone-request-failed',
        payload: {
          constraints: clonePayload(constraints),
          error: formatProbeError(error),
        },
      });
      throw error;
    }
  };

  window.__sophiaCaptureMicProbeInstalled__ = true;
  const state = getCaptureState();
  if (state) {
    state.microphone.patchInstalled = true;
    refreshMicrophoneSummary(state);
  }
}

function readTranscriptDom(): SophiaCaptureSnapshot['transcript']['dom'] {
  const transcriptRoot = document.querySelector('[role="log"][aria-label="Conversation with Sophia"]');
  const articles = Array.from(transcriptRoot?.querySelectorAll('[role="article"]') ?? [])
    .map((article) => ({
      label: article.getAttribute('aria-label'),
      text: cleanText(article.textContent),
    }))
    .filter((entry): entry is { label: string | null; text: string } => Boolean(entry.text));

  return {
    articleCount: articles.length,
    articles,
  };
}

function readArtifactsDom(): SophiaCaptureSnapshot['artifacts']['dom'] {
  return {
    railLabel: document.querySelector('button[aria-label^="Artifacts:"]')?.getAttribute('aria-label') ?? null,
    takeawayText: cleanText(document.querySelector('[data-onboarding="artifact-takeaway"]')?.textContent),
    reflectionText: cleanText(document.querySelector('[data-onboarding="reflection-card"]')?.textContent),
    memoriesText: cleanText(document.querySelector('[data-onboarding="memory-candidates"]')?.textContent),
    panelVisible:
      document.querySelector('[data-onboarding="artifact-takeaway"]') !== null ||
      document.querySelector('[data-onboarding="reflection-card"]') !== null ||
      document.querySelector('[data-onboarding="memory-candidates"]') !== null,
  };
}

function serializeChatMessages(): SophiaCaptureSnapshot['transcript']['chatMessages'] {
  return useChatStore.getState().messages.map((message) => {
    const rawMessage = message as unknown as Record<string, unknown>;

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      source: typeof rawMessage.source === 'string' ? rawMessage.source : null,
      status: typeof rawMessage.status === 'string' ? rawMessage.status : null,
      incomplete: rawMessage.incomplete === true,
      audioUrl: typeof rawMessage.audioUrl === 'string' ? rawMessage.audioUrl : null,
    };
  });
}

function serializeVoiceMessages(): SophiaCaptureSnapshot['transcript']['voiceMessages'] {
  return useVoiceStore.getState().messages.map((message) => ({
    id: message.id,
    content: message.content,
    timestamp: message.timestamp,
  }));
}

export function buildSophiaCaptureSnapshot(): SophiaCaptureSnapshot {
  const session = useSessionStore.getState().session;
  const metadata = useMessageMetadataStore.getState();
  const recap = useRecapStore.getState();
  const sessionId = session?.sessionId ?? metadata.currentSessionId ?? null;

  const storage = Object.fromEntries(
    CAPTURED_STORAGE_KEYS.map((key) => {
      try {
        return [key, parseStoredValue(window.localStorage.getItem(key))];
      } catch {
        return [key, null];
      }
    })
  );

  return {
    capturedAt: new Date().toISOString(),
    location: {
      href: window.location.href,
      pathname: window.location.pathname,
      title: document.title,
      theme: document.documentElement.dataset.sophiaTheme ?? null,
    },
    debug: getDebugSnapshot(),
    session: session
      ? {
          sessionId: session.sessionId,
          threadId: session.threadId,
          status: session.status,
          isActive: session.isActive,
          presetType: session.presetType,
          contextMode: session.contextMode,
          voiceMode: Boolean(session.voiceMode),
          startedAt: session.startedAt,
          endedAt: session.endedAt ?? null,
          lastActivityAt: session.lastActivityAt ?? null,
          messageCount: session.messages?.length ?? 0,
        }
      : null,
    transcript: {
      chatMessages: serializeChatMessages(),
      voiceMessages: serializeVoiceMessages(),
      dom: readTranscriptDom(),
    },
    artifacts: {
      sessionArtifacts: session?.artifacts ?? null,
      recapArtifacts: sessionId ? recap.artifacts[sessionId] ?? null : null,
      recapCommitStatus: sessionId ? recap.getCommitStatus(sessionId) : null,
      dom: readArtifactsDom(),
    },
    harness: {
      microphone: clonePayload(
        getCaptureState()?.microphone ??
          createEmptyMicrophoneSummary(window.__sophiaCaptureMicProbeInstalled__ === true)
      ) as SophiaCaptureMicrophoneSummary,
    },
    metadata: {
      currentSessionId: metadata.currentSessionId,
      currentThreadId: metadata.currentThreadId,
      currentRunId: metadata.currentRunId,
      emotionalWeather: metadata.emotionalWeather,
    },
    presence: {
      labels: Array.from(document.querySelectorAll('[aria-label^="Sophia is "]'))
        .map((element) => element.getAttribute('aria-label'))
        .filter((label): label is string => Boolean(label)),
    },
    storage,
  };
}

export function recordSophiaCaptureEvent({
  category,
  name,
  payload,
}: {
  category: string;
  name: string;
  payload?: unknown;
}): void {
  if (!isCaptureEnabled()) return;

  const state = getCaptureState();
  if (!state) return;

  state.seq += 1;
  state.events.push({
    seq: state.seq,
    recordedAt: new Date().toISOString(),
    category,
    name,
    payload: clonePayload(payload),
  });

  if (state.events.length > MAX_CAPTURE_EVENTS) {
    state.events.splice(0, state.events.length - MAX_CAPTURE_EVENTS);
  }
}

export function exportSophiaCaptureBundle(): SophiaCaptureBundle {
  const state = getCaptureState();

  return {
    startedAt: state?.startedAt ?? new Date().toISOString(),
    exportedAt: new Date().toISOString(),
    eventCount: state?.events.length ?? 0,
    events: [...(state?.events ?? [])],
    snapshot: buildSophiaCaptureSnapshot(),
  };
}

export function registerSophiaCaptureBridge(): void {
  if (!canUseCapture()) return;

  getCaptureState();
  installMicrophoneCaptureProbe();
  if (window.__sophiaCapture) return;

  window.__sophiaCapture = {
    enable: () => setCaptureEnabled(true),
    disable: () => setCaptureEnabled(false),
    clear: () => clearCaptureState(),
    isEnabled: () => isCaptureEnabled(),
    snapshot: () => buildSophiaCaptureSnapshot(),
    export: () => exportSophiaCaptureBundle(),
    getEvents: () => [...(getCaptureState()?.events ?? [])],
  };
}