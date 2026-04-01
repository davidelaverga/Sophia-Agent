import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSessionPageLocalState } from '../../app/session/useSessionPageLocalState';

describe('useSessionPageLocalState', () => {
  it('initializes expected local defaults', () => {
    const { result } = renderHook(() => useSessionPageLocalState({ sessionId: 's1' }));

    expect(result.current.input).toBe('');
    expect(result.current.showArtifacts).toBe(false);
    expect(result.current.mobileDrawerOpen).toBe(false);
    expect(result.current.userOpenedArtifacts).toBe(false);
    expect(result.current.justSent).toBe(false);
    expect(result.current.showScaffold).toBe(true);
    expect(result.current.dismissedError).toBe(false);
    expect(result.current.showFeedbackToast).toBeNull();
  });

  it('resets artifact panel visibility state when session changes', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionPageLocalState({ sessionId }),
      { initialProps: { sessionId: 's1' } },
    );

    act(() => {
      result.current.setShowArtifacts(true);
      result.current.setMobileDrawerOpen(true);
      result.current.setUserOpenedArtifacts(true);
      result.current.setShowScaffold(false);
    });

    expect(result.current.showArtifacts).toBe(true);
    expect(result.current.mobileDrawerOpen).toBe(true);
    expect(result.current.userOpenedArtifacts).toBe(true);
    expect(result.current.showScaffold).toBe(false);

    rerender({ sessionId: 's2' });

    expect(result.current.showArtifacts).toBe(false);
    expect(result.current.mobileDrawerOpen).toBe(false);
    expect(result.current.userOpenedArtifacts).toBe(false);
    expect(result.current.showScaffold).toBe(false);
  });

  it('marks stream errors dismissed when reconnecting online', () => {
    const { result } = renderHook(() => useSessionPageLocalState({ sessionId: 's1' }));

    expect(result.current.dismissedError).toBe(false);

    act(() => {
      result.current.handleReconnectOnline();
    });

    expect(result.current.dismissedError).toBe(true);
  });

  it('owns feedback toast state transitions', () => {
    const { result } = renderHook(() => useSessionPageLocalState({ sessionId: 's1' }));

    expect(result.current.showFeedbackToast).toBeNull();

    act(() => {
      result.current.setShowFeedbackToast('helpful');
    });

    expect(result.current.showFeedbackToast).toBe('helpful');

    act(() => {
      result.current.setShowFeedbackToast(null);
    });

    expect(result.current.showFeedbackToast).toBeNull();
  });
});
