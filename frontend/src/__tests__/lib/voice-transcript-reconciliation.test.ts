import { describe, expect, it } from 'vitest';

import { reconcileVoiceTranscript } from '../../app/lib/voice-transcript-reconciliation';

describe('reconcileVoiceTranscript', () => {
  it('prefers the longer cumulative transcript when the new text contains the prior text', () => {
    expect(
      reconcileVoiceTranscript('Good good evening, Sofia.', 'Good good evening, Sofia. How are you?'),
    ).toEqual({
      text: 'Good good evening, Sofia. How are you?',
      changed: true,
      incremental: true,
    });
  });

  it('keeps the prior transcript when the new text is only a trailing residue replay', () => {
    expect(
      reconcileVoiceTranscript('Good good evening, Sofia. How are you?', 'How are you?'),
    ).toEqual({
      text: 'Good good evening, Sofia. How are you?',
      changed: false,
      incremental: true,
    });
  });

  it('merges suffix-prefix overlap without duplicating the shared clause', () => {
    expect(
      reconcileVoiceTranscript('Actually, I wanna', 'I wanna try something different.'),
    ).toEqual({
      text: 'Actually, I wanna try something different.',
      changed: true,
      incremental: true,
    });
  });

  it('treats unrelated transcripts as a fresh turn candidate instead of concatenating them', () => {
    expect(
      reconcileVoiceTranscript('How are you?', 'Well, as you know, I enjoy talking to you.'),
    ).toEqual({
      text: 'Well, as you know, I enjoy talking to you.',
      changed: true,
      incremental: false,
    });
  });
});