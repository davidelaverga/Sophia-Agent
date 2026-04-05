import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecapArtifactsV1 } from '../../app/types/recap';
import { useChatArtifactsPanelActions } from '../../app/chat/useChatArtifactsPanelActions';

describe('useChatArtifactsPanelActions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('routes reflection tap to prompt select and forces text mode from voice mode', () => {
    const setMode = vi.fn();
    const setManualOverride = vi.fn();
    const handlePromptSelect = vi.fn();

    const { result } = renderHook(() => useChatArtifactsPanelActions({
      focusMode: 'voice',
      setMode,
      setManualOverride,
      handlePromptSelect,
      conversationId: 'conv-1',
      recapArtifacts: undefined,
      setRecapArtifacts: vi.fn(),
    }));

    act(() => {
      result.current.handleReflectionTap({ prompt: 'What did you learn this turn?' });
    });

    expect(handlePromptSelect).toHaveBeenCalledWith('What did you learn this turn?');
    expect(setMode).toHaveBeenCalledWith('text');
    expect(setManualOverride).toHaveBeenCalledWith(true);
  });

  it('approves memory candidate and updates recap store', async () => {
    vi.useFakeTimers();
    const setRecapArtifacts = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const recapArtifacts: RecapArtifactsV1 = {
      sessionId: 'conv-2',
      sessionType: 'chat',
      contextMode: 'gaming',
      status: 'ready',
      memoryCandidates: [
        { id: 'm1', text: 'Stay calm in clutch rounds.', category: 'emotional_patterns' },
        { id: 'm2', text: 'Use 10-second reset between matches.' },
      ],
    };

    const { result } = renderHook(() => useChatArtifactsPanelActions({
      focusMode: 'text',
      setMode: vi.fn(),
      setManualOverride: vi.fn(),
      handlePromptSelect: vi.fn(),
      conversationId: 'conv-2',
      recapArtifacts,
      setRecapArtifacts,
    }));

    await act(async () => {
      await result.current.handleMemoryApprove(0);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/memory/save', expect.objectContaining({ method: 'POST' }));
    expect(setRecapArtifacts).toHaveBeenCalledWith('conv-2', expect.objectContaining({
      memoryCandidates: [expect.objectContaining({ id: 'm2' })],
    }));
    expect(result.current.memoryInlineFeedback).toEqual({ index: 0, message: 'Saved.', variant: 'success' });

    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.memoryInlineFeedback).toBeNull();
  });

  it('rejects memory candidate and updates recap store', async () => {
    vi.useFakeTimers();
    const setRecapArtifacts = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const recapArtifacts: RecapArtifactsV1 = {
      sessionId: 'conv-3',
      sessionType: 'chat',
      contextMode: 'gaming',
      status: 'ready',
      memoryCandidates: [
        { id: 'm1', text: 'Avoid queueing while tilted.', category: 'emotional_patterns' },
      ],
    };

    const { result } = renderHook(() => useChatArtifactsPanelActions({
      focusMode: 'text',
      setMode: vi.fn(),
      setManualOverride: vi.fn(),
      handlePromptSelect: vi.fn(),
      conversationId: 'conv-3',
      recapArtifacts,
      setRecapArtifacts,
    }));

    await act(async () => {
      await result.current.handleMemoryReject(0);
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/memory/feedback', expect.objectContaining({ method: 'POST' }));
    expect(setRecapArtifacts).toHaveBeenCalledWith('conv-3', expect.objectContaining({ memoryCandidates: [] }));
    expect(result.current.memoryInlineFeedback).toEqual({ index: 0, message: 'Skipped.', variant: 'info' });
  });
});
