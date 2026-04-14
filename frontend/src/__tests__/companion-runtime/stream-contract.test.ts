import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitTimingMock = vi.fn();

vi.mock('../../app/lib/telemetry', () => ({
  emitTiming: (...args: unknown[]) => emitTimingMock(...args),
}));

import { useCompanionStreamContract } from '../../app/companion-runtime/stream-contract';

describe('useCompanionStreamContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ingests artifact data parts through the canonical stream contract', () => {
    const ingestArtifacts = vi.fn();

    const { result } = renderHook(() =>
      useCompanionStreamContract({
        ingestArtifacts,
        setBuilderArtifact: vi.fn(),
        setBuilderTask: vi.fn(),
        setInterrupt: vi.fn(),
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        sessionId: 'session-1',
      })
    );

    act(() => {
      result.current.handleDataPart({
        type: 'data-artifactsV1',
        data: { takeaway: 'done' },
      });
    });

    expect(ingestArtifacts).toHaveBeenCalledWith({ takeaway: 'done' }, 'stream');
  });

  it('routes interrupt payloads to the caller', () => {
    const setInterrupt = vi.fn();

    const { result } = renderHook(() =>
      useCompanionStreamContract({
        ingestArtifacts: vi.fn(),
        setBuilderArtifact: vi.fn(),
        setBuilderTask: vi.fn(),
        setInterrupt,
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        sessionId: 'session-1',
      })
    );

    act(() => {
      result.current.handleDataPart({
        type: 'data-interrupt',
        data: {
          kind: 'DEBRIEF_OFFER',
          title: 'Debrief?',
          message: 'Want a short debrief?',
          options: [{ id: 'accept', label: 'Yes', style: 'primary' }],
        },
      });
    });

    expect(setInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'DEBRIEF_OFFER' })
    );
  });

  it('persists metadata and emits turn timing on finish', () => {
    const setCurrentContext = vi.fn();
    const setMessageMetadata = vi.fn();

    const { result } = renderHook(() =>
      useCompanionStreamContract({
        ingestArtifacts: vi.fn(),
        setBuilderArtifact: vi.fn(),
        setBuilderTask: vi.fn(),
        setInterrupt: vi.fn(),
        setCurrentContext,
        setMessageMetadata,
        sessionId: 'session-1',
        activeSessionId: 'session-active',
        activeThreadId: 'thread-fallback',
      })
    );

    act(() => {
      result.current.markStreamTurnStarted(1234);
      result.current.handleDataPart({
        type: 'data-sophia_meta',
        data: {
          thread_id: 'thread-1',
          run_id: 'run-1',
          session_id: 'session-1',
          skill_used: 'reflect',
          emotion_detected: 'calm',
        },
      });
      result.current.handleFinish({ message: { id: 'assistant-1' } });
    });

    expect(setCurrentContext).toHaveBeenNthCalledWith(1, 'thread-1', 'session-active', 'run-1');
    expect(setCurrentContext).toHaveBeenNthCalledWith(2, 'thread-1', 'session-1', 'run-1');
    expect(setMessageMetadata).toHaveBeenCalledWith(
      'assistant-1',
      expect.objectContaining({
        thread_id: 'thread-1',
        run_id: 'run-1',
        session_id: 'session-1',
        skill_used: 'reflect',
        emotion_detected: 'calm',
      })
    );
    expect(emitTimingMock).toHaveBeenCalledWith('session.stream.turn_ms', 1234, {
      session_id: 'session-active',
    });
  });

  it('routes builder artifact data parts to the caller', () => {
    const setBuilderArtifact = vi.fn();

    const { result } = renderHook(() =>
      useCompanionStreamContract({
        ingestArtifacts: vi.fn(),
        setBuilderArtifact,
        setBuilderTask: vi.fn(),
        setInterrupt: vi.fn(),
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        sessionId: 'session-1',
      })
    );

    act(() => {
      result.current.handleDataPart({
        type: 'data-builderArtifactV1',
        data: {
          artifact_title: 'Sprint brief',
          artifact_type: 'document',
          artifact_path: 'outputs/sprint-brief.md',
          decisions_made: [],
        },
      });
    });

    expect(setBuilderArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactTitle: 'Sprint brief',
        artifactPath: 'mnt/user-data/outputs/sprint-brief.md',
      })
    );
  });

  it('routes builder task data parts to the caller', () => {
    const setBuilderTask = vi.fn();

    const { result } = renderHook(() =>
      useCompanionStreamContract({
        ingestArtifacts: vi.fn(),
        setBuilderArtifact: vi.fn(),
        setBuilderTask,
        setInterrupt: vi.fn(),
        setCurrentContext: vi.fn(),
        setMessageMetadata: vi.fn(),
        sessionId: 'session-1',
      })
    );

    act(() => {
      result.current.handleDataPart({
        type: 'data-builderTaskV1',
        data: {
          phase: 'failed',
          task_id: 'task-builder-1',
          label: 'Builder: document about the dangers of war',
          detail: 'Timed out while preparing the draft.',
        },
      });
    });

    expect(setBuilderTask).toHaveBeenCalledWith({
      phase: 'failed',
      taskId: 'task-builder-1',
      label: 'Builder: document about the dangers of war',
      detail: 'Timed out while preparing the draft.',
    });
  });
});