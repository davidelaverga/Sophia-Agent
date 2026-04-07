'use client';

const RECENT_SESSION_END_KEY = 'sophia.recent-session-end';
const RECENT_SESSION_END_TTL_MS = 2 * 60 * 1000;

export interface RecentSessionEndHint {
  sessionId: string;
  endedAtMs: number;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function markRecentSessionEnd(sessionId: string): void {
  if (!sessionId || !canUseStorage()) return;

  try {
    const hint: RecentSessionEndHint = {
      sessionId,
      endedAtMs: Date.now(),
    };
    window.localStorage.setItem(RECENT_SESSION_END_KEY, JSON.stringify(hint));
  } catch {
    // Ignore storage failures.
  }
}

export function getRecentSessionEndHint(): RecentSessionEndHint | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(RECENT_SESSION_END_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<RecentSessionEndHint>;
    if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.endedAtMs !== 'number') {
      window.localStorage.removeItem(RECENT_SESSION_END_KEY);
      return null;
    }

    if (Date.now() - parsed.endedAtMs > RECENT_SESSION_END_TTL_MS) {
      window.localStorage.removeItem(RECENT_SESSION_END_KEY);
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      endedAtMs: parsed.endedAtMs,
    };
  } catch {
    return null;
  }
}

export function clearRecentSessionEndHint(): void {
  if (!canUseStorage()) return;

  try {
    window.localStorage.removeItem(RECENT_SESSION_END_KEY);
  } catch {
    // Ignore storage failures.
  }
}
