import { useCallback, useEffect, useRef, useState } from 'react';

const RESTORE_RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000];

interface UseSessionPageGuardsParams {
  hasSession: boolean;
  isEnding: boolean;
  isNavigatingToRecap: boolean;
  navigateTo: (path: string) => void;
  attemptRestore?: () => Promise<boolean>;
}

export function useSessionPageGuards({
  hasSession,
  isEnding,
  isNavigatingToRecap,
  navigateTo,
  attemptRestore,
}: UseSessionPageGuardsParams) {
  const [isRestoring, setIsRestoring] = useState(false);
  const restoreCycleStartedRef = useRef(false);

  const navigateHome = useCallback(() => {
    navigateTo('/');
  }, [navigateTo]);

  useEffect(() => {
    if (hasSession || isEnding || isNavigatingToRecap) {
      restoreCycleStartedRef.current = false;
      if (isRestoring) {
        setIsRestoring(false);
      }
      return;
    }

    if (!attemptRestore) {
      navigateHome();
      return;
    }

    if (restoreCycleStartedRef.current) {
      return;
    }

    restoreCycleStartedRef.current = true;
    let cancelled = false;

    setIsRestoring(true);

    void (async () => {
      let restored = false;

      for (const delayMs of RESTORE_RETRY_DELAYS_MS) {
        if (cancelled) {
          return;
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        restored = await attemptRestore();
        if (restored) {
          break;
        }
      }

      if (!cancelled && !restored) {
        restoreCycleStartedRef.current = false;
        navigateHome();
      }

      if (!cancelled) {
        setIsRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attemptRestore, hasSession, isEnding, isNavigatingToRecap, isRestoring, navigateHome]);

  return {
    shouldShowLoading: !hasSession || isRestoring,
    navigateHome,
  };
}
