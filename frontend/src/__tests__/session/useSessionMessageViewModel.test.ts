import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionMessageViewModel } from '../../app/session/useSessionMessageViewModel';

describe('useSessionMessageViewModel', () => {
  it('exposes latest assistant message derived from mapped UI messages', () => {
    const markOffline = vi.fn();

    const { result } = renderHook(() =>
      useSessionMessageViewModel({
        chatMessages: [
          { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
          { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'first reply' }] },
          { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
          { id: 'a-2', role: 'assistant', parts: [{ type: 'text', text: 'latest reply' }] },
        ],
        greetingAnchorId: null,
        markOffline,
      })
    );

    expect(result.current.latestAssistantMessage).toEqual({
      id: 'a-2',
      content: 'latest reply',
    });
  });
});
