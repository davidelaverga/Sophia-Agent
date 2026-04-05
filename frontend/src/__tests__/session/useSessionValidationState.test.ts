import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionValidationState } from '../../app/session/useSessionValidationState';

const useSessionValidationMock = vi.fn();

vi.mock('../../app/hooks/useSessionValidation', () => ({
  useSessionValidation: (...args: unknown[]) => useSessionValidationMock(...args),
}));

describe('useSessionValidationState', () => {
  it('maps validation outputs to page-oriented fields', () => {
    const takeOverSession = vi.fn();
    const clearError = vi.fn();

    useSessionValidationMock.mockReturnValue({
      isExpired: true,
      isMultiTab: false,
      takeOverSession,
      clearError,
    });

    const { result } = renderHook(() => useSessionValidationState());

    expect(result.current.sessionExpired).toBe(true);
    expect(result.current.sessionMultiTab).toBe(false);
    expect(result.current.takeOverSession).toBe(takeOverSession);
    expect(result.current.clearSessionError).toBe(clearError);
  });
});
