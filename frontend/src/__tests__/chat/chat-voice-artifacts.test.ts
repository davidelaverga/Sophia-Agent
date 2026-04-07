import { describe, expect, it, vi } from 'vitest';

import {
  applyChatRouteArtifacts,
  ingestChatVoiceArtifacts,
  mapRecapArtifactsToRitualArtifacts,
  resolveChatArtifactsSessionId,
} from '../../app/chat/chat-voice-artifacts';

describe('applyChatRouteArtifacts', () => {
  it('updates emotion and stores mapped artifacts in one step', () => {
    const setArtifacts = vi.fn();
    const setEmotion = vi.fn();

    const stored = applyChatRouteArtifacts({
      artifacts: {
        session_id: 'session-from-route',
        takeaway: 'You recovered after a hard pivot.',
        voice_emotion_primary: 'warm',
      },
      setArtifacts,
      setEmotion,
    });

    expect(stored).toBe(true);
    expect(setEmotion).toHaveBeenCalledWith('warm');
    expect(setArtifacts).toHaveBeenCalledWith(
      'session-from-route',
      expect.objectContaining({
        sessionId: 'session-from-route',
        takeaway: 'You recovered after a hard pivot.',
      })
    );
  });
});

describe('ingestChatVoiceArtifacts', () => {
  it('stores mapped artifacts using payload session_id when available', () => {
    const setArtifacts = vi.fn();

    const stored = ingestChatVoiceArtifacts({
      artifacts: {
        session_id: 'session-from-voice',
        takeaway: 'Great reset after tilt.',
        memory_candidates: [{ id: 'm1', text: 'You recover quickly after short breaks.' }],
      },
      setArtifacts,
    });

    expect(stored).toBe(true);
    expect(setArtifacts).toHaveBeenCalledTimes(1);
    expect(setArtifacts).toHaveBeenCalledWith(
      'session-from-voice',
      expect.objectContaining({
        sessionId: 'session-from-voice',
        takeaway: 'Great reset after tilt.',
      })
    );
  });

  it('falls back to conversationId when payload has no session_id', () => {
    const setArtifacts = vi.fn();

    const stored = ingestChatVoiceArtifacts({
      artifacts: {
        takeaway: 'You kept calm under pressure.',
        reflection_candidate: { prompt: 'What helped you stay composed?' },
      },
      conversationId: 'chat-conv-123',
      setArtifacts,
    });

    expect(stored).toBe(true);
    expect(setArtifacts).toHaveBeenCalledWith(
      'chat-conv-123',
      expect.objectContaining({
        sessionId: 'chat-conv-123',
      })
    );
  });

  it('does not store when neither payload nor conversation provides an id', () => {
    const setArtifacts = vi.fn();

    const stored = ingestChatVoiceArtifacts({
      artifacts: {
        takeaway: 'No target id available.',
      },
      setArtifacts,
    });

    expect(stored).toBe(false);
    expect(setArtifacts).not.toHaveBeenCalled();
  });

  it('resolves the session id with the same fallback rules used by the route hook', () => {
    expect(resolveChatArtifactsSessionId({ session_id: 'payload-session' }, 'chat-session')).toBe('payload-session');
    expect(resolveChatArtifactsSessionId({ takeaway: 'fallback' }, 'chat-session')).toBe('chat-session');
    expect(resolveChatArtifactsSessionId({ takeaway: 'missing' })).toBeNull();
  });

  it('maps recap artifacts to ritual artifacts for ArtifactsPanel', () => {
    const mapped = mapRecapArtifactsToRitualArtifacts({
      sessionId: 'chat-conv-123',
      sessionType: 'chat',
      contextMode: 'gaming',
      takeaway: 'You stayed composed in the match.',
      reflectionCandidate: {
        prompt: 'What thought helped you stay calm?',
      },
      memoryCandidates: [
        {
          id: 'm1',
          text: 'Short breathing resets help you recover focus.',
          category: 'emotional_patterns',
          confidence: 0.9,
        },
      ],
      status: 'ready',
    });

    expect(mapped).toEqual(
      expect.objectContaining({
        takeaway: 'You stayed composed in the match.',
        session_type: 'chat',
        preset_context: 'gaming',
        reflection_candidate: expect.objectContaining({
          prompt: 'What thought helped you stay calm?',
        }),
      })
    );

    expect(mapped?.memory_candidates?.[0]).toEqual(
      expect.objectContaining({
        memory: 'Short breathing resets help you recover focus.',
        category: 'emotional_patterns',
      })
    );
  });
});
