import { describe, expect, it } from 'vitest';

import {
  extractStreamMetadata,
  normalizeStreamDataPart,
  parseArtifactsPayload,
  parseBuilderArtifactPayload,
  parseBuilderTaskPayload,
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

  it('preserves legacy reflection fields for downstream artifact normalization', () => {
    const payload = parseArtifactsPayload({
      takeaway: 'Takeaway',
      reflection: 'What do you want to keep from this moment?',
    });

    expect(payload).toEqual({
      takeaway: 'Takeaway',
      reflection: 'What do you want to keep from this moment?',
    });
  });

  it('normalizes builder artifact payloads and file paths', () => {
    const payload = parseBuilderArtifactPayload({
      artifact_title: 'Sprint brief',
      artifact_type: 'document',
      artifact_path: 'outputs/sprint-brief.md',
      supporting_files: ['/mnt/user-data/outputs/notes.txt'],
      companion_summary: 'The sprint brief is ready.',
      decisions_made: ['Kept the scope tight'],
    });

    expect(payload).toEqual({
      artifactTitle: 'Sprint brief',
      artifactType: 'document',
      artifactPath: 'mnt/user-data/outputs/sprint-brief.md',
      supportingFiles: ['mnt/user-data/outputs/notes.txt'],
      companionSummary: 'The sprint brief is ready.',
      decisionsMade: ['Kept the scope tight'],
    });
  });

  it('parses builder task payloads from stream parts', () => {
    const payload = parseBuilderTaskPayload({
      phase: 'running',
      task_id: 'task-builder-1',
      label: 'Builder: document about the dangers of war',
      detail: 'Working through step 2 of 4.',
      message_index: 2,
      total_messages: 4,
    });

    expect(payload).toEqual({
      phase: 'running',
      taskId: 'task-builder-1',
      label: 'Builder: document about the dangers of war',
      detail: 'Working through step 2 of 4.',
      messageIndex: 2,
      totalMessages: 4,
    });
  });

  it('normalizes raw builder task lifecycle events from voice transport', () => {
    const payload = parseBuilderTaskPayload({
      type: 'task_started',
      task_id: 'task-builder-1',
      description: 'Builder: document about the dangers of war',
    });

    expect(payload).toEqual({
      phase: 'running',
      taskId: 'task-builder-1',
      label: 'Builder: document about the dangers of war',
    });
  });

  it('falls back to a generic detail when a task_started event has no label', () => {
    const payload = parseBuilderTaskPayload({
      type: 'task_started',
      task_id: 'task-builder-1',
    });

    expect(payload).toEqual({
      phase: 'running',
      taskId: 'task-builder-1',
      detail: 'Builder is working on the deliverable.',
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
