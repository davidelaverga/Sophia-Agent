import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRecentSessionEndHint,
  getRecentSessionEndHint,
  markRecentSessionEnd,
} from '../../app/lib/recent-session-end';

describe('recent-session-end hint', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('stores and retrieves a fresh session end hint', () => {
    markRecentSessionEnd('sess-123');

    const hint = getRecentSessionEndHint();

    expect(hint).not.toBeNull();
    expect(hint?.sessionId).toBe('sess-123');
    expect(typeof hint?.endedAtMs).toBe('number');
  });

  it('expires stale hints based on TTL', () => {
    vi.useFakeTimers();
    const base = new Date('2026-03-05T10:00:00.000Z');
    vi.setSystemTime(base);

    markRecentSessionEnd('sess-old');

    vi.setSystemTime(new Date(base.getTime() + (2 * 60 * 1000) + 1));

    const hint = getRecentSessionEndHint();

    expect(hint).toBeNull();
  });

  it('clears hint explicitly', () => {
    markRecentSessionEnd('sess-clear');
    clearRecentSessionEndHint();

    expect(getRecentSessionEndHint()).toBeNull();
  });
});
