import { useSessionValidation } from '../hooks/useSessionValidation';
import { debugWarn } from '../lib/debug-logger';

export function useSessionValidationState() {
  const {
    isExpired,
    isMultiTab,
    takeOverSession,
    clearError,
  } = useSessionValidation({
    autoValidate: true,
    onExpired: () => {
      debugWarn('Session', 'Session expired');
    },
    onMultiTab: () => {
      debugWarn('Session', 'Multi-tab conflict detected');
    },
  });

  return {
    sessionExpired: isExpired,
    sessionMultiTab: isMultiTab,
    takeOverSession,
    clearSessionError: clearError,
  };
}
