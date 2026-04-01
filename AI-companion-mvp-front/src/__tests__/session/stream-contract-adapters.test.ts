import { describe, expect, it } from 'vitest';

import {
  extractStreamMetadata,
  normalizeStreamDataPart,
  parseArtifactsPayload,
  parseInterruptPayload,
} from '../../app/session/stream-contract-adapters';

describe('stream-contract-adapters', () => {
  it('normalizes data-prefixed stream part types', () => {
    const normalized = normalizeStreamDataPart({
      type: 'data-artifactsV1',
      data: { takeaway: 'done' },
    });

    expect(normalized).toEqual({
      type: 'artifactsV1',
      data: { takeaway: 'done' },
    });
  });

  it('parses interrupt payload with snake_case aliases', () => {
    const payload = parseInterruptPayload({
      kind: 'DEBRIEF_OFFER',
      title: 'Debrief?',
      message: 'Want a short debrief?',
      options: [{ id: 'accept', label: 'Yes', style: 'primary' }],
      snooze_enabled: true,
      expires_at: '2026-03-01T00:00:00Z',
    });

    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe('DEBRIEF_OFFER');
    expect(payload && 'snooze' in payload ? payload.snooze : undefined).toBe(true);
    expect(payload && 'expiresAt' in payload ? payload.expiresAt : undefined).toBe('2026-03-01T00:00:00Z');
  });

  it('normalizes artifacts payload and drops invalid known fields', () => {
    const payload = parseArtifactsPayload({
      takeaway: 123,
      reflection_candidate: { prompt: 'Reflect' },
      memory_candidates: 'invalid',
      custom: true,
    });

    expect(payload).toEqual({
      reflection_candidate: { prompt: 'Reflect' },
      custom: true,
    });
  });

  it('keeps previous stream metadata when incoming fields are missing', () => {
    const previous = {
      thread_id: 'thread-1',
      run_id: 'run-1',
      session_id: 'session-1',
      skill_used: 'reflect',
      emotion_detected: 'calm',
    };

    const next = extractStreamMetadata({ run_id: 'run-2' }, previous);

    expect(next).toEqual({
      thread_id: 'thread-1',
      run_id: 'run-2',
      session_id: 'session-1',
      skill_used: 'reflect',
      emotion_detected: 'calm',
    });
  });
});
