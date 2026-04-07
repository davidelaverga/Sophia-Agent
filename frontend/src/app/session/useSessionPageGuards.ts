import { useCallback, useEffect } from 'react';

interface UseSessionPageGuardsParams {
  hasSession: boolean;
  isEnding: boolean;
  isNavigatingToRecap: boolean;
  navigateTo: (path: string) => void;
}

export function useSessionPageGuards({
  hasSession,
  isEnding,
  isNavigatingToRecap,
  navigateTo,
}: UseSessionPageGuardsParams) {
  const navigateHome = useCallback(() => {
    navigateTo('/');
  }, [navigateTo]);

  useEffect(() => {
    if (!hasSession && !isEnding && !isNavigatingToRecap) {
      navigateHome();
    }
  }, [hasSession, isEnding, isNavigatingToRecap, navigateHome]);

  return {
    shouldShowLoading: !hasSession,
    navigateHome,
  };
}
