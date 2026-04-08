import { describe, expect, it } from 'vitest';

import { shouldBlockOutboundDuplicate, shouldBlockSubmitDuplicate, type SendFingerprint } from '../../app/session/send-gate';

describe('send-gate', () => {
  it('blocks submit duplicates within submit window', () => {
    const previous: SendFingerprint = { text: 'hello', at: 1000 };
    expect(shouldBlockSubmitDuplicate(previous, 'hello', 1500)).toBe(true);
    expect(shouldBlockSubmitDuplicate(previous, 'hello', 2301)).toBe(false);
  });

  it('blocks outbound duplicates only when stream is active', () => {
    const previous: SendFingerprint = { text: 'hello', at: 1000 };
    expect(shouldBlockOutboundDuplicate(previous, 'hello', 1500, true)).toBe(true);
    expect(shouldBlockOutboundDuplicate(previous, 'hello', 1500, false)).toBe(false);
  });

  it('does not block when text differs', () => {
    const previous: SendFingerprint = { text: 'hello', at: 1000 };
    expect(shouldBlockSubmitDuplicate(previous, 'hello again', 1200)).toBe(false);
    expect(shouldBlockOutboundDuplicate(previous, 'hello again', 1200, true)).toBe(false);
  });
});
