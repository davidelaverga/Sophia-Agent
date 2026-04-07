import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionStreamPersistence } from '../../app/session/useSessionStreamPersistence';

describe('useSessionStreamPersistence', () => {
  it('persists through updateMessages without direct localStorage writes', () => {
    const updateMessages = vi.fn();
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem');

    renderHook(() =>
      useSessionStreamPersistence({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'hello',
            createdAt: new Date().toISOString(),
          },
        ],
        chatStatus: 'streaming',
        updateMessages,
      })
    );

    expect(updateMessages).toHaveBeenCalledTimes(1);
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
