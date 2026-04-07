import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useCompanionChatRuntimeMock = vi.fn();
const useCompanionStreamContractMock = vi.fn();
const useCompanionArtifactsRuntimeMock = vi.fn();
const useCompanionVoiceRuntimeMock = vi.fn();

vi.mock('../../app/companion-runtime/chat-runtime', () => ({
  useCompanionChatRuntime: (...args: unknown[]) => useCompanionChatRuntimeMock(...args),
}));

vi.mock('../../app/companion-runtime/stream-contract', () => ({
  useCompanionStreamContract: (...args: unknown[]) => useCompanionStreamContractMock(...args),
}));

vi.mock('../../app/companion-runtime/artifacts-runtime', () => ({
  useCompanionArtifactsRuntime: (...args: unknown[]) => useCompanionArtifactsRuntimeMock(...args),
}));

vi.mock('../../app/companion-runtime/voice-runtime', () => ({
  useCompanionVoiceRuntime: (...args: unknown[]) => useCompanionVoiceRuntimeMock(...args),
}));

import { COMPANION_ROUTE_PROFILES } from '../../app/companion-runtime/route-profiles';
import { useCompanionRuntime } from '../../app/companion-runtime/useCompanionRuntime';

describe('useCompanionRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCompanionChatRuntimeMock.mockReturnValue({ chatStatus: 'ready' });
    useCompanionStreamContractMock.mockReturnValue({ handleDataPart: vi.fn() });
    useCompanionArtifactsRuntimeMock.mockReturnValue({ artifactStatus: { takeaway: 'waiting' } });
    useCompanionVoiceRuntimeMock.mockReturnValue({ voiceStatus: 'ready' });
  });

  it('resolves the requested route profile and composes the canonical runtime parts', () => {
    const chat = { chatRequestBody: { session_id: 's1' } } as never;
    const stream = { sessionId: 's1' } as never;
    const artifacts = { sessionId: 's1' } as never;
    const voice = { userId: 'user-1' } as never;

    const { result } = renderHook(() =>
      useCompanionRuntime({
        routeProfile: 'ritual',
        chat,
        stream,
        artifacts,
        voice,
      })
    );

    expect(result.current.routeProfile).toEqual(COMPANION_ROUTE_PROFILES.ritual);
    expect(useCompanionChatRuntimeMock).toHaveBeenCalledWith(chat);
    expect(useCompanionStreamContractMock).toHaveBeenCalledWith(stream);
    expect(useCompanionArtifactsRuntimeMock).toHaveBeenCalledWith(artifacts);
    expect(useCompanionVoiceRuntimeMock).toHaveBeenCalledWith(voice);
  });

  it('accepts an explicit route profile object without re-mapping it', () => {
    const profile = {
      ...COMPANION_ROUTE_PROFILES.chat,
      description: 'test chat profile',
    };

    const { result } = renderHook(() =>
      useCompanionRuntime({
        routeProfile: profile,
        chat: {} as never,
        stream: {} as never,
        artifacts: {} as never,
        voice: {} as never,
      })
    );

    expect(result.current.routeProfile).toBe(profile);
  });
});