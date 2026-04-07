import { beforeEach, describe, expect, it } from 'vitest';

import {
  extractMetadataFromResponse,
  useMessageMetadataStore,
} from '../../app/stores/message-metadata-store';

describe('message-metadata-store', () => {
  beforeEach(() => {
    useMessageMetadataStore.getState().clearAll();
  });

  it('stores message metadata and updates current context', () => {
    useMessageMetadataStore.getState().setMessageMetadata('m1', {
      thread_id: 'thread-1',
      session_id: 'session-1',
      run_id: 'run-1',
    });

    const state = useMessageMetadataStore.getState();

    expect(state.getMessageMetadata('m1')).toEqual({
      thread_id: 'thread-1',
      session_id: 'session-1',
      run_id: 'run-1',
    });
    expect(state.currentThreadId).toBe('thread-1');
    expect(state.currentSessionId).toBe('session-1');
    expect(state.currentRunId).toBe('run-1');
  });

  it('extracts and filters metadata fields from backend response safely', () => {
    const metadata = extractMetadataFromResponse({
      metadata: {
        thread_id: 'thread-2',
        session_id: 'session-2',
        session_type: 'prepare',
        preset_context: 'gaming',
        invoke_type: 'voice',
        artifacts_status: 'pending',
        memory_sources_used: ['flash', 'invalid-source', 42],
        computed_at: '2026-03-02T08:00:00Z',
      },
    });

    expect(metadata).toEqual({
      thread_id: 'thread-2',
      run_id: undefined,
      session_id: 'session-2',
      session_type: 'prepare',
      preset_context: 'gaming',
      invoke_type: 'voice',
      artifacts_status: 'pending',
      memory_sources_used: ['flash'],
      computed_at: '2026-03-02T08:00:00Z',
    });
  });

  it('returns null when metadata envelope is missing or invalid', () => {
    expect(extractMetadataFromResponse({})).toBeNull();
    expect(extractMetadataFromResponse({ metadata: 'invalid' })).toBeNull();
  });
});
