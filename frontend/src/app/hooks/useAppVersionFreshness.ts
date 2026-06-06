'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ShowToastFn = (args: {
  message: string;
  variant: 'info' | 'success' | 'error' | 'warning';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}) => void;

type AppVersionResponse = {
  build_id?: string;
  deployment_id?: string | null;
};

type FreshnessCheckOptions = {
  reason?: string;
  reloadIfStale?: boolean;
};

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 12) : null;
}

const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_APP_BUILD_ID || 'development';

export function useAppVersionFreshness({
  enabled,
  showToast,
  sessionId,
  threadId,
  canAutoReload,
}: {
  enabled: boolean;
  showToast: ShowToastFn;
  sessionId?: string;
  threadId?: string;
  canAutoReload: boolean;
}) {
  const [stale, setStale] = useState(false);
  const notifiedRef = useRef(false);
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  const notifyStale = useCallback((payload: AppVersionResponse, reason: string) => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    console.warn('[app-version] stale client detected', {
      reason,
      loaded_build_id: shortId(CLIENT_BUILD_ID),
      server_build_id: shortId(payload.build_id),
      deployment_id: shortId(payload.deployment_id),
      session_id: shortId(sessionId),
      thread_id: shortId(threadId),
    });
    showToast({
      message: 'Sophia updated. Refresh to continue.',
      variant: 'warning',
      durationMs: 12_000,
      action: {
        label: 'Refresh',
        onClick: () => {
          window.location.reload();
        },
      },
    });
  }, [sessionId, showToast, threadId]);

  const checkFreshness = useCallback(async (options?: FreshnessCheckOptions): Promise<boolean> => {
    if (!enabled || typeof window === 'undefined') return true;
    const inFlight = inFlightRef.current;
    if (inFlight !== null) return inFlight;

    const reason = options?.reason ?? 'unknown';
    const promise = Promise.resolve(fetch('/api/app-version', { cache: 'no-store' }))
      .then(async (response) => {
        if (!response?.ok) return true;
        const payload = await response.json() as AppVersionResponse;
        const serverBuildId = payload.build_id?.trim();
        const isStale = Boolean(
          serverBuildId
          && CLIENT_BUILD_ID
          && serverBuildId !== CLIENT_BUILD_ID,
        );
        console.warn('[app-version] freshness check', {
          reason,
          stale: isStale,
          loaded_build_id: shortId(CLIENT_BUILD_ID),
          server_build_id: shortId(serverBuildId),
          deployment_id: shortId(payload.deployment_id),
          session_id: shortId(sessionId),
          thread_id: shortId(threadId),
        });
        if (!isStale) {
          setStale(false);
          notifiedRef.current = false;
          return true;
        }

        setStale(true);
        notifyStale(payload, reason);
        if (options?.reloadIfStale && canAutoReload) {
          window.location.reload();
        }
        return false;
      })
      .catch((error) => {
        console.warn('[app-version] freshness check failed', {
          reason,
          error: error instanceof Error ? error.name : 'unknown',
          session_id: shortId(sessionId),
          thread_id: shortId(threadId),
        });
        return true;
      })
      .finally(() => {
        inFlightRef.current = null;
      });

    inFlightRef.current = promise;
    return promise;
  }, [canAutoReload, enabled, notifyStale, sessionId, threadId]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    void checkFreshness({ reason: 'session-mount' });

    const onFocus = () => {
      void checkFreshness({ reason: 'window-focus' });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkFreshness({ reason: 'visibility-visible' });
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [checkFreshness, enabled]);

  return {
    stale,
    checkFreshness,
  };
}
