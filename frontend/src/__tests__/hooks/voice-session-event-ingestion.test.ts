import { describe, expect, it, vi } from 'vitest';

import {
  applyAssistantTranscriptUpdate,
  applyPacedAssistantTranscriptUpdate,
  createAssistantTranscriptPacingState,
  createAssistantTranscriptStaleGuardState,
  markAssistantTranscriptGenerationStarted,
  markAssistantTranscriptUserInputStarted,
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
      providerReceivedAt: null,
    });
    expect(parseAssistantTranscriptUpdate({
      text: 'Hello',
      final: true,
      source_sequence: 12,
      response_id: 'response-1',
      segment_id: 'gemini-segment-0',
      provider_received_at: '2026-05-24T12:00:00.000Z',
    })).toEqual({
      text: 'Hello',
      isFinal: true,
      sourceSequence: 12,
      responseId: 'response-1',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:00.000Z',
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

  it('rejects later transcript fragments for an assistant segment interrupted by user input', () => {
    const guard = createAssistantTranscriptStaleGuardState();

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'Done and ready.',
      isFinal: false,
      sourceSequence: 18,
      responseId: 'response-stale',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:01.000Z',
    }, guard)).toBe(true);

    expect(markAssistantTranscriptUserInputStarted(guard, Date.parse('2026-05-24T12:00:02.000Z'))).toEqual([
      'response-stale:gemini-segment-0',
    ]);

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'Done and ready. I can keep going.',
      isFinal: false,
      sourceSequence: 19,
      responseId: 'response-stale',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:02.250Z',
    }, guard)).toBe(false);
    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'Done and ready. Final stale tail.',
      isFinal: true,
      sourceSequence: 20,
      responseId: 'response-stale',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:03.000Z',
    }, guard)).toBe(false);
  });

  it('uses provider receive timestamps to reject queued stale transcript fragments after barge-in', () => {
    const guard = createAssistantTranscriptStaleGuardState();

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'I will summarize this.',
      isFinal: false,
      sourceSequence: 21,
      responseId: null,
      segmentId: null,
      providerReceivedAt: '2026-05-24T12:00:01.000Z',
    }, guard)).toBe(true);
    markAssistantTranscriptUserInputStarted(guard, Date.parse('2026-05-24T12:00:04.000Z'));
    markAssistantTranscriptGenerationStarted(guard);

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'I will summarize this. Queued old tail.',
      isFinal: false,
      sourceSequence: 22,
      responseId: null,
      segmentId: null,
      providerReceivedAt: '2026-05-24T12:00:03.750Z',
    }, guard)).toBe(false);
    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'New answer after your Spanish turn.',
      isFinal: false,
      sourceSequence: 23,
      responseId: null,
      segmentId: null,
      providerReceivedAt: '2026-05-24T12:00:05.000Z',
    }, guard)).toBe(true);
  });

  it('keeps assistant transcript updates valid when raw mic frames never confirm intent', () => {
    const guard = createAssistantTranscriptStaleGuardState();

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'I can keep going here.',
      isFinal: false,
      sourceSequence: 30,
      responseId: 'response-valid',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:01.000Z',
    }, guard)).toBe(true);

    expect(shouldApplyAssistantTranscriptUpdate({
      text: 'I can keep going here with the rest of the sentence.',
      isFinal: false,
      sourceSequence: 31,
      responseId: 'response-valid',
      segmentId: 'gemini-segment-0',
      providerReceivedAt: '2026-05-24T12:00:02.000Z',
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
