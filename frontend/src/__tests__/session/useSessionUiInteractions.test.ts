import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UIMessage } from '../../app/components/session';
import { useSessionUiInteractions } from '../../app/session/useSessionUiInteractions';

function createMessage(id: string, content: string): UIMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  };
}

function buildParams(messages: UIMessage[], isTyping: boolean) {
  return {
    messages,
    isTyping,
    isReadOnly: false,
    showArtifacts: false,
    showArtifactsUi: true,
    hasSessionFiles: false,
    showSessionFiles: false,
    mobileDrawerOpen: false,
    setShowArtifacts: vi.fn(),
    setShowSessionFiles: vi.fn(),
    setMobileDrawerOpen: vi.fn(),
    setUserOpenedArtifacts: vi.fn(),
    setShowScaffold: vi.fn(),
    triggerLightHaptic: vi.fn(),
    onBaseMicClick: vi.fn(),
  };
}

describe('useSessionUiInteractions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses auto scroll for token-by-token streaming updates', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const scrollIntoView = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages, isTyping }) => useSessionUiInteractions(buildParams(messages, isTyping)),
      {
        initialProps: {
          messages: [createMessage('a1', 'Hello')],
          isTyping: true,
        },
      },
    );

    act(() => {
      result.current.messagesEndRef.current = { scrollIntoView } as unknown as HTMLDivElement;
    });

    scrollIntoView.mockClear();

    rerender({
      messages: [createMessage('a1', 'Hello there')],
      isTyping: true,
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' });
  });

  it('uses smooth scroll when a settled new message arrives', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const scrollIntoView = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages, isTyping }) => useSessionUiInteractions(buildParams(messages, isTyping)),
      {
        initialProps: {
          messages: [createMessage('a1', 'Hello there')],
          isTyping: true,
        },
      },
    );

    act(() => {
      result.current.messagesEndRef.current = { scrollIntoView } as unknown as HTMLDivElement;
    });

    scrollIntoView.mockClear();

    rerender({
      messages: [createMessage('a1', 'Hello there'), createMessage('a2', 'Second reply')],
      isTyping: false,
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
  });
});