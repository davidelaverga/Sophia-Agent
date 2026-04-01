import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let capturedOnError: ((error: Error) => void) | undefined;
const stopMock = vi.fn();

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn((options: { onError?: (error: Error) => void }) => {
    capturedOnError = options.onError;
    return {
      messages: [],
      sendMessage: vi.fn(),
      status: 'ready',
      error: undefined,
      setMessages: vi.fn(),
      stop: stopMock,
    };
  }),
}));

vi.mock('ai', () => ({
  DefaultChatTransport: class MockTransport {
    constructor(_config: unknown) {}
  },
}));

vi.mock('../../app/lib/usage-limit-parser', () => ({
  parseUsageLimitFromError: vi.fn(),
}));

vi.mock('../../app/lib/debug-logger', () => ({
  debugWarn: vi.fn(),
}));

import { parseUsageLimitFromError } from '../../app/lib/usage-limit-parser';
import { useSessionChatRuntime } from '../../app/session/useSessionChatRuntime';

describe('useSessionChatRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnError = undefined;
  });

  it('shows usage limit modal when parser detects usage limit', () => {
    vi.mocked(parseUsageLimitFromError).mockReturnValue({ info: { reason: 'text' } } as never);

    const showUsageLimitModal = vi.fn();
    const recordConnectivityFailure = vi.fn();
    const showToast = vi.fn();

    renderHook(() =>
      useSessionChatRuntime({
        chatRequestBody: { session_id: 's1' },
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        showUsageLimitModal,
        recordConnectivityFailure,
        showToast,
      })
    );

    capturedOnError?.(new Error('limit reached'));

    expect(showUsageLimitModal).toHaveBeenCalledWith({ reason: 'text' });
    expect(recordConnectivityFailure).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('records connectivity failure and warning toast for offline/backend-unavailable errors', () => {
    vi.mocked(parseUsageLimitFromError).mockReturnValue(null as never);

    const showUsageLimitModal = vi.fn();
    const recordConnectivityFailure = vi.fn();
    const showToast = vi.fn();

    renderHook(() =>
      useSessionChatRuntime({
        chatRequestBody: { session_id: 's1' },
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        showUsageLimitModal,
        recordConnectivityFailure,
        showToast,
      })
    );

    capturedOnError?.(new Error('Backend unavailable 503'));

    expect(recordConnectivityFailure).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'warning' })
    );
    expect(showUsageLimitModal).not.toHaveBeenCalled();
  });

  it('shows generic error toast for other errors', () => {
    vi.mocked(parseUsageLimitFromError).mockReturnValue(null as never);

    const showUsageLimitModal = vi.fn();
    const recordConnectivityFailure = vi.fn();
    const showToast = vi.fn();

    renderHook(() =>
      useSessionChatRuntime({
        chatRequestBody: { session_id: 's1' },
        handleDataPart: vi.fn(),
        handleFinish: vi.fn(),
        showUsageLimitModal,
        recordConnectivityFailure,
        showToast,
      })
    );

    capturedOnError?.(new Error('unexpected server exception'));

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error' })
    );
    expect(recordConnectivityFailure).not.toHaveBeenCalled();
    expect(showUsageLimitModal).not.toHaveBeenCalled();
  });
});
