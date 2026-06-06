import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionLeaveGuardAnnotationSuppressionForTests,
  suppressSessionLeaveGuardForAnnotation,
  suppressSessionLeaveGuardForCoreviewBuilderUpdate,
} from '../../app/session/session-annotation-navigation-guard';
import { useSessionExitProtection } from '../../app/session/useSessionExitProtection';

const messages = [
  {
    id: 'm1',
    role: 'user' as const,
    content: 'please review this',
    createdAt: '2026-06-04T12:00:00.000Z',
  },
  {
    id: 'm2',
    role: 'assistant' as const,
    content: 'reviewing now',
    createdAt: '2026-06-04T12:00:01.000Z',
  },
];

describe('useSessionExitProtection annotation guard', () => {
  afterEach(() => {
    clearSessionLeaveGuardAnnotationSuppressionForTests();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('suppresses the leave confirmation while an annotation command is in flight', () => {
    const updateMessages = vi.fn();
    const openExitConfirm = vi.fn();
    const pushState = vi.spyOn(window.history, 'pushState');
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    renderHook(() => useSessionExitProtection({
      sessionId: 'session-1',
      responseMode: 'voice',
      isSophiaResponding: true,
      messages,
      updateMessages,
      openExitConfirm,
    }));

    suppressSessionLeaveGuardForAnnotation();
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(openExitConfirm).not.toHaveBeenCalled();
    expect(updateMessages).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({ sophiaResponding: true }, '');
  });

  it('does not arm beforeunload when annotation navigation suppression is active', () => {
    const updateMessages = vi.fn();
    const openExitConfirm = vi.fn();
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    renderHook(() => useSessionExitProtection({
      sessionId: 'session-1',
      responseMode: 'voice',
      isSophiaResponding: true,
      messages,
      updateMessages,
      openExitConfirm,
    }));

    suppressSessionLeaveGuardForAnnotation();
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    const notCanceled = window.dispatchEvent(event);

    expect(notCanceled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(updateMessages).not.toHaveBeenCalled();
    expect(openExitConfirm).not.toHaveBeenCalled();
  });

  it('suppresses leave confirmation while a Coreview builder update starts', () => {
    const updateMessages = vi.fn();
    const openExitConfirm = vi.fn();
    const pushState = vi.spyOn(window.history, 'pushState');
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    renderHook(() => useSessionExitProtection({
      sessionId: 'session-1',
      responseMode: 'voice',
      isSophiaResponding: true,
      messages,
      updateMessages,
      openExitConfirm,
    }));

    suppressSessionLeaveGuardForCoreviewBuilderUpdate();
    window.dispatchEvent(new PopStateEvent('popstate'));
    const beforeUnload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    const notCanceled = window.dispatchEvent(beforeUnload);

    expect(openExitConfirm).not.toHaveBeenCalled();
    expect(updateMessages).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({ sophiaResponding: true }, '');
    expect(notCanceled).toBe(true);
    expect(beforeUnload.defaultPrevented).toBe(false);
  });
});
