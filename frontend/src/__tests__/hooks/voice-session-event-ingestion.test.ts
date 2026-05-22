import { describe, expect, it, vi } from 'vitest';

import {
  applyAssistantTranscriptUpdate,
  applyPacedAssistantTranscriptUpdate,
  createAssistantTranscriptPacingState,
  createAssistantTranscriptStaleGuardState,
  parseAssistantTranscriptUpdate,
  shouldApplyAssistantTranscriptUpdate,
} from '../../app/hooks/voice-session-event-ingestion';

describe('voice-session-event-ingestion', () => {
  it('parses normalized assistant transcript events from the public sophia contract', () => {
    expect(parseAssistantTranscriptUpdate({ text: 'Hello', is_final: false })).toEqual({
      text: 'Hello',
      isFinal: false,
      sourceSequence: null,
      responseId: null,
      segmentId: null,
    });
    expect(parseAssistantTranscriptUpdate({
      text: 'Hello',
      final: true,
      source_sequence: 12,
      response_id: 'response-1',
      segment_id: 'gemini-segment-0',
    })).toEqual({
      text: 'Hello',
      isFinal: true,
      sourceSequence: 12,
      responseId: 'response-1',
      segmentId: 'gemini-segment-0',
    });
    expect(parseAssistantTranscriptUpdate({ text: 123 })).toBeNull();
  });

  it('rejects stale assistant transcript snapshots for the same response segment', () => {
    const guard = createAssistantTranscriptStaleGuardState();

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'You ready to lock',
      isFinal: false,
      sourceSequence: 11,
      responseId: 'response-1',
      segmentId: 'gemini-segment-0',
    }, guard)).toBe(true);
    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'to lock',
      isFinal: false,
      sourceSequence: 10,
      responseId: 'response-1',
      segmentId: 'gemini-segment-0',
    }, guard)).toBe(false);
    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'Different response can start over.',
      isFinal: false,
      sourceSequence: 1,
      responseId: 'response-2',
      segmentId: 'gemini-segment-0',
    }, guard)).toBe(true);
  });

  it('forwards partial assistant transcripts into the Session message path', () => {
    const handlers = {
      setFinalReply: vi.fn(),
      setPartialReply: vi.fn(),
      addVoiceMessage: vi.fn(),
      onAssistantResponse: vi.fn(),
    };

    applyAssistantTranscriptUpdate(
      { text: 'That sounds heavy.', isFinal: false },
      handlers,
    );

    expect(handlers.setPartialReply).toHaveBeenCalledWith('That sounds heavy.');
    expect(handlers.onAssistantResponse).toHaveBeenCalledWith('That sounds heavy.');
    expect(handlers.setFinalReply).not.toHaveBeenCalled();
    expect(handlers.addVoiceMessage).not.toHaveBeenCalled();
  });

  it('keeps final assistant transcripts as the only voice-store history append', () => {
    const handlers = {
      setFinalReply: vi.fn(),
      setPartialReply: vi.fn(),
      addVoiceMessage: vi.fn(),
      onAssistantResponse: vi.fn(),
    };

    applyAssistantTranscriptUpdate(
      { text: 'That sounds heavy. I am here with you.', isFinal: true },
      handlers,
    );

    expect(handlers.setFinalReply).toHaveBeenCalledWith('That sounds heavy. I am here with you.');
    expect(handlers.setPartialReply).toHaveBeenCalledWith('');
    expect(handlers.addVoiceMessage).toHaveBeenCalledWith('That sounds heavy. I am here with you.');
    expect(handlers.onAssistantResponse).toHaveBeenCalledWith('That sounds heavy. I am here with you.');
  });

  it('treats public assistant partials as replaceable snapshots', () => {
    const handlers = {
      setFinalReply: vi.fn(),
      setPartialReply: vi.fn(),
      addVoiceMessage: vi.fn(),
      onAssistantResponse: vi.fn(),
    };

    applyAssistantTranscriptUpdate(
      { text: 'Yeah, I hear', isFinal: false },
      handlers,
    );
    applyAssistantTranscriptUpdate(
      { text: 'Yeah, I hear you.', isFinal: false },
      handlers,
    );
    applyAssistantTranscriptUpdate(
      { text: 'Yeah, I can hear you fine.', isFinal: false },
      handlers,
    );

    expect(handlers.setPartialReply).toHaveBeenNthCalledWith(1, 'Yeah, I hear');
    expect(handlers.setPartialReply).toHaveBeenNthCalledWith(2, 'Yeah, I hear you.');
    expect(handlers.setPartialReply).toHaveBeenNthCalledWith(3, 'Yeah, I can hear you fine.');
    expect(handlers.onAssistantResponse).toHaveBeenNthCalledWith(3, 'Yeah, I can hear you fine.');
    expect(handlers.addVoiceMessage).not.toHaveBeenCalled();
  });

  it('paces Gemini-style partials while always flushing the exact final transcript', () => {
    const handlers = {
      setFinalReply: vi.fn(),
      setPartialReply: vi.fn(),
      addVoiceMessage: vi.fn(),
      onAssistantResponse: vi.fn(),
    };
    const pacingState = createAssistantTranscriptPacingState();

    expect(applyPacedAssistantTranscriptUpdate(
      { text: 'That', isFinal: false },
      handlers,
      pacingState,
      { nowMs: 1000 },
    )).toBe(false);
    expect(applyPacedAssistantTranscriptUpdate(
      { text: 'That sounds like a lot', isFinal: false },
      handlers,
      pacingState,
      { nowMs: 1100 },
    )).toBe(false);
    expect(applyPacedAssistantTranscriptUpdate(
      { text: 'That sounds like a lot to carry today.', isFinal: false },
      handlers,
      pacingState,
      { nowMs: 1300 },
    )).toBe(true);

    expect(handlers.setPartialReply).toHaveBeenCalledTimes(1);
    expect(handlers.setPartialReply).toHaveBeenCalledWith('That sounds like a lot to carry today.');
    expect(handlers.onAssistantResponse).toHaveBeenCalledTimes(1);

    applyPacedAssistantTranscriptUpdate(
      { text: 'That sounds like a lot to carry today. I am here.', isFinal: true },
      handlers,
      pacingState,
      { nowMs: 1600 },
    );

    expect(handlers.setFinalReply).toHaveBeenCalledWith('That sounds like a lot to carry today. I am here.');
    expect(handlers.setPartialReply).toHaveBeenLastCalledWith('');
    expect(handlers.addVoiceMessage).toHaveBeenCalledWith('That sounds like a lot to carry today. I am here.');
    expect(handlers.onAssistantResponse).toHaveBeenLastCalledWith('That sounds like a lot to carry today. I am here.');
  });
});
