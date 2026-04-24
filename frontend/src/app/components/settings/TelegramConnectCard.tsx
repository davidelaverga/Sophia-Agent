'use client';

import { ArrowUpRight, Check, Copy, Loader2, MessageCircle, Unlink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { useAuth } from '../../providers';
import { useUiStore } from '../../stores/ui-store';

type LinkStatus =
  | { linked: false; botUsername: string }
  | {
      linked: true;
      botUsername: string;
      telegramUsername: string | null;
      telegramChatId: string | null;
    };

type PendingLink = {
  url: string;
  token: string;
  expiresAt: number;
  botUsername: string;
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 10 * 60 * 1000; // 10 min — matches server TTL

function extractStatus(raw: unknown): LinkStatus | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const botUsername = typeof value.bot_username === 'string' ? value.bot_username : '';
  if (!botUsername) {
    return null;
  }
  if (value.linked === true) {
    return {
      linked: true,
      botUsername,
      telegramUsername: typeof value.telegram_username === 'string' ? value.telegram_username : null,
      telegramChatId: typeof value.telegram_chat_id === 'string' ? value.telegram_chat_id : null,
    };
  }
  return { linked: false, botUsername };
}

function extractPending(raw: unknown): PendingLink | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const url = typeof value.url === 'string' ? value.url : '';
  const token = typeof value.token === 'string' ? value.token : '';
  const expiresAt = typeof value.expires_at === 'number' ? value.expires_at : 0;
  const botUsername = typeof value.bot_username === 'string' ? value.bot_username : '';
  if (!url || !token || !botUsername || expiresAt <= 0) {
    return null;
  }
  return { url, token, expiresAt, botUsername };
}

export function TelegramConnectCard() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const showToast = useUiStore((s) => s.showToast);

  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [busy, setBusy] = useState<'idle' | 'creating' | 'polling' | 'revoking'>('idle');
  const [copied, setCopied] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<LinkStatus | null> => {
    if (!userId) {
      return null;
    }
    try {
      const response = await fetch(`/api/sophia/${encodeURIComponent(userId)}/telegram/link`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as unknown;
      return extractStatus(data);
    } catch {
      return null;
    }
  }, [userId]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchStatus();
      if (!cancelled) {
        setStatus(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => clearPollTimer();
  }, [clearPollTimer]);

  const stopPolling = useCallback(() => {
    clearPollTimer();
    pollDeadlineRef.current = 0;
    setBusy('idle');
  }, [clearPollTimer]);

  const schedulePoll = useCallback(
    (runner: () => Promise<void>) => {
      clearPollTimer();
      if (Date.now() >= pollDeadlineRef.current) {
        stopPolling();
        return;
      }
      pollTimerRef.current = setTimeout(() => {
        void runner();
      }, POLL_INTERVAL_MS);
    },
    [clearPollTimer, stopPolling],
  );

  const pollForBinding = useCallback(async () => {
    const next = await fetchStatus();
    if (next?.linked) {
      setStatus(next);
      setPending(null);
      stopPolling();
      showToast({
        message: next.telegramUsername
          ? `Connected to Telegram as @${next.telegramUsername}`
          : 'Connected to Telegram',
        variant: 'success',
        durationMs: 2800,
      });
      return;
    }
    schedulePoll(pollForBinding);
  }, [fetchStatus, schedulePoll, showToast, stopPolling]);

  const handleConnect = useCallback(async () => {
    if (!userId || busy !== 'idle') {
      return;
    }
    haptic('light');
    setBusy('creating');
    try {
      const response = await fetch(`/api/sophia/${encodeURIComponent(userId)}/telegram/link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const data = (await response.json()) as unknown;
      const next = extractPending(data);
      if (!next) {
        throw new Error('Invalid response payload');
      }
      setPending(next);
      pollDeadlineRef.current = Date.now() + MAX_POLL_MS;
      setBusy('polling');
      try {
        window.open(next.url, '_blank', 'noopener,noreferrer');
      } catch {
        // If popup blocked, the user can still click the visible link.
      }
      schedulePoll(pollForBinding);
    } catch {
      showToast({
        message: 'Could not generate a Telegram link. Please try again.',
        variant: 'error',
        durationMs: 3200,
      });
      setBusy('idle');
    }
  }, [busy, pollForBinding, schedulePoll, showToast, userId]);

  const handleCopy = useCallback(async () => {
    if (!pending?.url) {
      return;
    }
    try {
      await navigator.clipboard.writeText(pending.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      showToast({ message: 'Copy failed — select and copy manually.', variant: 'error' });
    }
  }, [pending, showToast]);

  const handleCancel = useCallback(() => {
    setPending(null);
    stopPolling();
  }, [stopPolling]);

  const handleDisconnect = useCallback(async () => {
    if (!userId || busy !== 'idle') {
      return;
    }
    haptic('medium');
    setBusy('revoking');
    try {
      const response = await fetch(`/api/sophia/${encodeURIComponent(userId)}/telegram/link`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Request failed with ${response.status}`);
      }
      setStatus((prev) => (prev ? { linked: false, botUsername: prev.botUsername } : null));
      showToast({ message: 'Telegram disconnected', variant: 'success', durationMs: 2400 });
    } catch {
      showToast({ message: 'Could not disconnect. Please try again.', variant: 'error' });
    } finally {
      setBusy('idle');
    }
  }, [busy, showToast, userId]);

  const bodyCopy = useMemo(() => {
    if (!status) {
      return 'Loading…';
    }
    if (status.linked) {
      return status.telegramUsername
        ? `Connected as @${status.telegramUsername}`
        : 'Connected — Sophia will remember you across Telegram and the webapp.';
    }
    return `Open a chat with @${status.botUsername} and keep your memories in sync.`;
  }, [status]);

  if (!userId) {
    return null;
  }

  return (
    <section className="cosmic-surface-panel-strong rounded-[1.6rem] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-sophia-purple" />
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
              Telegram
            </p>
            <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
              {bodyCopy}
            </p>
          </div>
        </div>
        {status?.linked ? (
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={busy !== 'idle'}
            className="cosmic-ghost-pill cosmic-focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-300 disabled:opacity-45"
          >
            {busy === 'revoking' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Unlink className="h-3 w-3" />
            )}
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy !== 'idle' || !status}
            className="cosmic-accent-pill cosmic-focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-300 disabled:opacity-45"
          >
            {busy === 'creating' || busy === 'polling' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ArrowUpRight className="h-3 w-3" />
            )}
            {busy === 'polling' ? 'Waiting…' : 'Connect Telegram'}
          </button>
        )}
      </div>

      {pending && !status?.linked && (
        <div
          className="mt-4 flex flex-col gap-2 rounded-2xl border p-3"
          style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }}
        >
          <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
            Didn&apos;t auto-open? Click the link below, or copy it to Telegram.
          </p>
          <div className="flex items-center gap-2">
            <a
              href={pending.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate rounded-xl border px-3 py-2 text-[12px] font-mono transition-colors hover:bg-[color-mix(in_srgb,var(--sophia-purple)_6%,transparent)]"
              style={{ borderColor: 'var(--cosmic-border-soft)', color: 'var(--cosmic-text-strong)' }}
            >
              {pending.url}
            </a>
            <button
              type="button"
              onClick={handleCopy}
              className="cosmic-ghost-pill cosmic-focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium"
              aria-label="Copy link"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="cosmic-ghost-pill cosmic-focus-ring self-start rounded-full px-3 py-1 text-[11px] font-medium"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
