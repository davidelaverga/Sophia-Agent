import { describe, expect, it } from 'vitest';

import {
  analyzeVoiceBenchmarkCapture,
  mapEmotionToFamily,
  summarizeVoiceBenchmarkReports,
  type VoiceBenchmarkCaseDefinition,
  type VoiceBenchmarkManifest,
} from '../../app/lib/voice-benchmark-analysis';

function buildEvent({
  at,
  category,
  data,
  name,
}: {
  at: string;
  category: string;
  data?: Record<string, unknown>;
  name: string;
}) {
  return {
    recordedAt: at,
    category,
    name,
    payload: data ? { data } : {},
  };
}

function buildCapture(events: ReturnType<typeof buildEvent>[]) {
  return {
    captureBundle: {
      startedAt: '2026-04-02T02:28:54.624Z',
      exportedAt: '2026-04-02T02:29:37.907Z',
      events,
      snapshot: {
        transcript: {
          voiceMessages: [],
        },
        artifacts: {
          sessionArtifacts: null,
        },
      },
    },
    domSummary: {
      transcriptMessages: [],
    },
  };
}

function buildHarnessCapture({
  events,
  microphone,
}: {
  events: ReturnType<typeof buildEvent>[];
  microphone: Record<string, unknown>;
}) {
  return {
    harness: {
      fakeAudioFile: {
        basename: 'fixture.wav',
        sizeBytes: 16384,
        wav: {
          channelCount: 1,
          durationMs: 4200,
          sampleRate: 16000,
        },
      },
    },
    captureBundle: {
      startedAt: '2026-04-02T02:28:54.624Z',
      exportedAt: '2026-04-02T02:29:37.907Z',
      events,
      snapshot: {
        harness: {
          microphone,
        },
        transcript: {
          voiceMessages: [],
        },
        artifacts: {
          sessionArtifacts: null,
        },
      },
    },
    domSummary: {
      transcriptMessages: [],
    },
  };
}

const manifest: VoiceBenchmarkManifest = {
  suite: 'live-voice-benchmark',
  version: 1,
  cases: [],
};

describe('voice benchmark analysis', () => {
  it('maps artifact emotions into benchmark families', () => {
    expect(mapEmotionToFamily('determined')).toBe('challenging');
    expect(mapEmotionToFamily('sympathetic')).toBe('supportive');
    expect(mapEmotionToFamily('excited')).toBe('celebratory');
    expect(mapEmotionToFamily('unknown')).toBeNull();
  });

  it('analyzes a successful completed clip with artifact comparison', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'map_03_mixed',
      label: 'Mixed emotion',
      category: 'mapping',
      audioFile: 'map_03_mixed.wav',
      expected: {
        emotionFamilies: ['challenging'],
        responseIntent: 'Name the loop and ask the reflective question.',
        toneBand: 'engagement',
      },
    };
    const capture = buildCapture([
      buildEvent({
        at: '2026-04-02T02:28:55.274Z',
        category: 'voice-session',
        name: 'start-talking-requested',
      }),
      buildEvent({
        at: '2026-04-02T02:28:57.477Z',
        category: 'voice-session',
        name: 'calling-state-changed',
        data: { callingState: 'joined', mappedStage: 'listening' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:13.269Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:32.807Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_started' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:32.960Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_started' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:33.975Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:34.392Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:29:36.316Z',
        category: 'stream-custom',
        name: 'sophia.transcript',
        data: {
          is_final: true,
          text: 'You are stuck in a loop. What does your friend have that you want?',
        },
      }),
      buildEvent({
        at: '2026-04-02T02:29:36.392Z',
        category: 'stream-custom',
        name: 'sophia.artifact',
        data: {
          active_tone_band: 'engagement',
          voice_emotion_primary: 'determined',
          voice_emotion_secondary: 'curious',
          voice_speed: 'normal',
        },
      }),
    ]);

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.metrics.response_completion).toBe(true);
    expect(report.metrics.join_latency_ms).toBe(2203);
    expect(report.metrics.turn_close_ms).toBe(19538);
    expect(report.metrics.raw_turn_close_ms).toBeNull();
    expect(report.metrics.turn_close_metric_source).toBe('public_turn_event');
    expect(report.metrics.artifact_receipt).toBe(true);
    expect(report.metrics.duplicate_phase_counts).toEqual({
      agent_ended: 1,
      agent_started: 1,
    });
    expect(report.actual.emotionFamily).toBe('challenging');
    expect(report.comparisons.emotionFamilyHit).toBe(true);
    expect(report.comparisons.toneBandHit).toBe(true);
    expect(report.classification.auto).toBe('completed');
  });

  it('classifies repeated unresolved user-ended storms as no turn closure', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'flow_02_pause_midthought',
      label: 'Pause mid-thought',
      category: 'flow',
      audioFile: 'flow_02_pause_midthought.wav',
      expected: {
        responseIntent: 'Recover from the pause and answer once.',
      },
    };
    const capture = buildCapture([
      buildEvent({
        at: '2026-04-02T02:25:41.249Z',
        category: 'voice-session',
        name: 'start-talking-requested',
      }),
      buildEvent({
        at: '2026-04-02T02:25:46.970Z',
        category: 'voice-session',
        name: 'calling-state-changed',
        data: { callingState: 'joined', mappedStage: 'listening' },
      }),
      buildEvent({
        at: '2026-04-02T02:25:50.504Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:25:50.589Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:25:52.539Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:25:55.104Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:25:59.228Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:25.162Z',
        category: 'stream-custom',
        name: 'sophia.turn_diagnostic',
        data: {
          reason: 'silence_timing',
          raw_false_end_count: 6,
          duplicate_phase_counts: { agent_started: 0, agent_ended: 0 },
        },
      }),
    ]);

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.metrics.response_completion).toBe(false);
    expect(report.metrics.false_user_ended_count).toBe(6);
    expect(report.metrics.artifact_receipt).toBe(false);
    expect(report.metrics.terminal_reason).toBe('silence_timing');
    expect(report.classification.auto).toBe('no_turn_closure');
    expect(report.manualReview.responseIntent.required).toBe(false);
  });

  it('classifies missing browser microphone input as a harness miss', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'flow_04_correction',
      label: 'Correction',
      category: 'flow',
      audioFile: 'flow_04_correction.wav',
    };
    const capture = buildHarnessCapture({
      events: [
        buildEvent({
          at: '2026-04-02T02:26:28.684Z',
          category: 'voice-session',
          name: 'start-talking-requested',
        }),
        buildEvent({
          at: '2026-04-02T02:26:31.000Z',
          category: 'voice-session',
          name: 'calling-state-changed',
          data: { callingState: 'joined', mappedStage: 'listening' },
        }),
      ],
      microphone: {
        audioTrackCount: 1,
        detectedAudio: false,
        errors: [],
        firstAudioAt: null,
        firstStreamAt: '2026-04-02T02:26:31.050Z',
        lastAudioAt: null,
        maxAbsPeak: 0.0001,
        maxRms: 0.00005,
        nonSilentSampleWindows: 0,
        patchInstalled: true,
        streamCount: 1,
        streams: [],
        totalSampleWindows: 24,
        tracks: [],
      },
    });

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.classification.auto).toBe('harness_input_missing');
    expect(report.harness.classification.inputReceived).toBe(false);
    expect(report.harness.classification.reason).toBe('microphone_stream_without_audio');
    expect(report.harness.configured.durationMs).toBe(4200);
    expect(report.harness.observed.totalSampleWindows).toBe(24);
  });

  it('treats downstream turn events as proof that input reached Sophia', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'map_01_grief',
      label: 'Grief',
      category: 'mapping',
      audioFile: 'map_01_grief.wav',
    };
    const capture = buildHarnessCapture({
      events: [
        buildEvent({
          at: '2026-04-02T02:26:28.684Z',
          category: 'voice-session',
          name: 'start-talking-requested',
        }),
        buildEvent({
          at: '2026-04-02T02:26:31.000Z',
          category: 'voice-session',
          name: 'calling-state-changed',
          data: { callingState: 'joined', mappedStage: 'listening' },
        }),
        buildEvent({
          at: '2026-04-02T02:26:40.000Z',
          category: 'stream-custom',
          name: 'sophia.turn',
          data: { phase: 'user_ended' },
        }),
      ],
      microphone: {
        audioTrackCount: 1,
        detectedAudio: false,
        errors: ['resume-denied'],
        firstAudioAt: null,
        firstStreamAt: '2026-04-02T02:26:31.050Z',
        lastAudioAt: null,
        maxAbsPeak: 0.0001,
        maxRms: 0.00005,
        nonSilentSampleWindows: 0,
        patchInstalled: true,
        streamCount: 1,
        streams: [],
        totalSampleWindows: 24,
        tracks: [],
      },
    });

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.classification.auto).toBe('no_turn_closure');
    expect(report.harness.classification.inputReceived).toBe(true);
    expect(report.harness.classification.reason).toBe('turn_events_observed');
  });

  it('falls back to timing and transcript data when no diagnostic event exists', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'flow_04_correction',
      label: 'Correction',
      category: 'flow',
      audioFile: 'flow_04_correction.wav',
    };
    const capture = buildCapture([
      buildEvent({
        at: '2026-04-02T02:26:28.684Z',
        category: 'voice-session',
        name: 'start-talking-requested',
      }),
      buildEvent({
        at: '2026-04-02T02:26:31.000Z',
        category: 'voice-session',
        name: 'calling-state-changed',
        data: { callingState: 'joined', mappedStage: 'listening' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:40.000Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:42.500Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_started' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:44.000Z',
        category: 'stream-custom',
        name: 'sophia.transcript',
        data: { is_final: true, text: 'Let me correct that and answer directly.' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:44.100Z',
        category: 'stream-custom',
        name: 'sophia.artifact',
        data: {
          active_tone_band: 'engagement',
          voice_emotion_primary: 'content',
          voice_speed: 'normal',
        },
      }),
    ]);

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.metrics.turn_close_ms).toBe(2500);
    expect(report.metrics.raw_turn_close_ms).toBeNull();
    expect(report.metrics.turn_close_metric_source).toBe('public_turn_event');
    expect(report.metrics.terminal_reason).toBe('completed');
    expect(report.classification.auto).toBe('completed');
  });

  it('prefers committed user transcript spacing and preserves raw diagnostic latency', () => {
    const definition: VoiceBenchmarkCaseDefinition = {
      id: 'flow_02_pause_midthought',
      label: 'Pause mid-thought',
      category: 'flow',
      audioFile: 'flow_02_pause_midthought.wav',
    };
    const capture = buildCapture([
      buildEvent({
        at: '2026-04-02T02:26:28.684Z',
        category: 'voice-session',
        name: 'start-talking-requested',
      }),
      buildEvent({
        at: '2026-04-02T02:26:31.000Z',
        category: 'voice-session',
        name: 'calling-state-changed',
        data: { callingState: 'joined', mappedStage: 'listening' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:40.462Z',
        category: 'stream-custom',
        name: 'sophia.user_transcript',
        data: { text: 'leave it, it actually happened.' },
      }),
      buildEvent({
        at: '2026-04-02T02:26:59.900Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'user_ended' },
      }),
      buildEvent({
        at: '2026-04-02T02:27:00.000Z',
        category: 'stream-custom',
        name: 'sophia.turn',
        data: { phase: 'agent_started' },
      }),
      buildEvent({
        at: '2026-04-02T02:27:01.000Z',
        category: 'stream-custom',
        name: 'sophia.transcript',
        data: { is_final: true, text: 'I heard the pause. Keep going.' },
      }),
      buildEvent({
        at: '2026-04-02T02:27:01.100Z',
        category: 'stream-custom',
        name: 'sophia.artifact',
        data: {
          active_tone_band: 'engagement',
          voice_emotion_primary: 'content',
          voice_speed: 'normal',
        },
      }),
      buildEvent({
        at: '2026-04-02T02:27:01.200Z',
        category: 'stream-custom',
        name: 'sophia.turn_diagnostic',
        data: {
          reason: 'completed',
          raw_false_end_count: 1,
          duplicate_phase_counts: {},
          first_text_ms: 19538,
          backend_complete_ms: 20500,
          first_audio_ms: 21000,
        },
      }),
    ]);

    const report = analyzeVoiceBenchmarkCapture({ capture, definition });

    expect(report.metrics.first_committed_user_transcript_at).toBe('2026-04-02T02:26:40.462Z');
    expect(report.metrics.first_user_ended_at).toBe('2026-04-02T02:26:59.900Z');
    expect(report.metrics.turn_close_ms).toBe(19538);
    expect(report.metrics.raw_turn_close_ms).toBe(19538);
    expect(report.metrics.turn_close_metric_source).toBe('committed_user_transcript');
    expect(report.metrics.terminal_reason).toBe('completed');
    expect(report.classification.auto).toBe('completed');
  });

  it('summarizes suite medians and hit rates from case reports', () => {
    const mixedDefinition: VoiceBenchmarkCaseDefinition = {
      id: 'map_03_mixed',
      label: 'Mixed',
      category: 'mapping',
      audioFile: 'map_03_mixed.wav',
      expected: {
        emotionFamilies: ['challenging'],
        toneBand: 'engagement',
      },
    };
    const griefDefinition: VoiceBenchmarkCaseDefinition = {
      id: 'map_01_grief',
      label: 'Grief',
      category: 'mapping',
      audioFile: 'map_01_grief.wav',
      expected: {
        emotionFamilies: ['supportive'],
        toneBand: 'grief_fear',
      },
    };
    const success = analyzeVoiceBenchmarkCapture({
      capture: buildCapture([
        buildEvent({
          at: '2026-04-02T02:28:55.274Z',
          category: 'voice-session',
          name: 'start-talking-requested',
        }),
        buildEvent({
          at: '2026-04-02T02:28:57.274Z',
          category: 'voice-session',
          name: 'calling-state-changed',
          data: { callingState: 'joined' },
        }),
        buildEvent({
          at: '2026-04-02T02:29:13.269Z',
          category: 'stream-custom',
          name: 'sophia.turn',
          data: { phase: 'user_ended' },
        }),
        buildEvent({
          at: '2026-04-02T02:29:15.269Z',
          category: 'stream-custom',
          name: 'sophia.turn',
          data: { phase: 'agent_started' },
        }),
        buildEvent({
          at: '2026-04-02T02:29:16.269Z',
          category: 'stream-custom',
          name: 'sophia.transcript',
          data: { is_final: true, text: 'Response.' },
        }),
        buildEvent({
          at: '2026-04-02T02:29:16.369Z',
          category: 'stream-custom',
          name: 'sophia.artifact',
          data: { active_tone_band: 'engagement', voice_emotion_primary: 'determined' },
        }),
      ]),
      definition: mixedDefinition,
    });
    const failure = analyzeVoiceBenchmarkCapture({
      capture: buildCapture([
        buildEvent({
          at: '2026-04-02T02:27:17.190Z',
          category: 'voice-session',
          name: 'start-talking-requested',
        }),
        buildEvent({
          at: '2026-04-02T02:27:19.500Z',
          category: 'voice-session',
          name: 'calling-state-changed',
          data: { callingState: 'joined' },
        }),
        buildEvent({
          at: '2026-04-02T02:27:25.000Z',
          category: 'stream-custom',
          name: 'sophia.turn',
          data: { phase: 'user_ended' },
        }),
      ]),
      definition: griefDefinition,
    });

    const summary = summarizeVoiceBenchmarkReports({
      manifest,
      reports: [success, failure],
    });

    expect(summary.total_cases).toBe(2);
    expect(summary.completed_cases).toBe(1);
    expect(summary.completion_rate).toBe(0.5);
    expect(summary.median_false_user_ended_count).toBe(1);
    expect(summary.median_raw_turn_close_ms).toBeNull();
    expect(summary.median_turn_close_ms).toBe(2000);
    expect(summary.emotion_family_hit_rate).toBe(1);
    expect(summary.tone_band_hit_rate).toBe(1);
    expect(summary.auto_class_counts).toEqual({
      completed: 1,
      harness_input_missing: 0,
      no_turn_closure: 1,
      wrong_emitted_artifact: 0,
    });
    expect(summary.harness_input_detected_cases).toBe(2);
    expect(summary.harness_input_missing_cases).toBe(0);
  });
});