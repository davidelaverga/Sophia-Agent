export interface RefreshInterruptHint {
  sessionId: string;
  assistantMessageId: string;
  interruptedAt: number;
  responseMode?: 'text' | 'voice';
}

const STORAGE_KEY = 'sophia-refresh-interrupt-hint';
const HINT_TTL_MS = 2 * 60 * 1000;

export function persistRefreshInterruptHint(hint: RefreshInterruptHint): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hint));
  } catch {
    // ignore localStorage failures
  }
}

export function consumeRefreshInterruptHint(sessionId: string): RefreshInterruptHint | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    localStorage.removeItem(STORAGE_KEY);

    const parsed = JSON.parse(raw) as Partial<RefreshInterruptHint>;
    if (
      !parsed ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.assistantMessageId !== 'string' ||
      typeof parsed.interruptedAt !== 'number'
    ) {
      return null;
    }

    if (parsed.sessionId !== sessionId) return null;
    if (Date.now() - parsed.interruptedAt > HINT_TTL_MS) return null;

    return {
      sessionId: parsed.sessionId,
      assistantMessageId: parsed.assistantMessageId,
      interruptedAt: parsed.interruptedAt,
      responseMode: parsed.responseMode === 'voice' ? 'voice' : 'text',
    };
  } catch {
    return null;
  }
}