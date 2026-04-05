import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionPageGuards } from '../../app/session/useSessionPageGuards';

describe('useSessionPageGuards', () => {
  it('redirects to home when session is missing and page is not ending/navigating', () => {
    const navigateTo = vi.fn();

    renderHook(() => useSessionPageGuards({
      hasSession: false,
      isEnding: false,
      isNavigatingToRecap: false,
      navigateTo,
    }));

    expect(navigateTo).toHaveBeenCalledWith('/');
  });

  it('does not redirect when ending or navigating to recap', () => {
    const navigateTo = vi.fn();

    const { rerender } = renderHook(
      ({ isEnding, isNavigatingToRecap }: { isEnding: boolean; isNavigatingToRecap: boolean }) =>
        useSessionPageGuards({
          hasSession: false,
          isEnding,
          isNavigatingToRecap,
          navigateTo,
        }),
      {
        initialProps: {
          isEnding: true,
          isNavigatingToRecap: false,
        },
      }
    );

    expect(navigateTo).not.toHaveBeenCalled();

    rerender({
      isEnding: false,
      isNavigatingToRecap: true,
    });

    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('exposes navigateHome helper that routes to /', () => {
    const navigateTo = vi.fn();

    const { result } = renderHook(() => useSessionPageGuards({
      hasSession: true,
      isEnding: false,
      isNavigatingToRecap: false,
      navigateTo,
    }));

    act(() => {
      result.current.navigateHome();
    });

    expect(navigateTo).toHaveBeenCalledWith('/');
  });
});
