import { describe, expect, it } from 'vitest';

import { parseJournalEnvelope } from '../../app/lib/memory-pool-envelope';

import { poolFixture } from './pool-fixture';

describe('Pool management authority envelope', () => {
  it('keeps exact canonical whitespace and large valid revisions', () => {
    const value = poolFixture();
    value.entries[0].content = '  EXACT_CANONICAL_TEXT  ';
    value.entries[0].metadata.memory_governance_revision = 50001;
    expect(parseJournalEnvelope(value, 'user-123', 'active').entries[0].content).toBe('  EXACT_CANONICAL_TEXT  ');
  });
  it('distinguishes filtered enumeration from the total complete shelf snapshot', () => {
    const value = poolFixture([]);
    value.snapshot_count = 1005; value.filters.category = 'relationship';
    expect(parseJournalEnvelope(value, 'user-123').count).toBe(0);
    value.filters.category = null;
    expect(() => parseJournalEnvelope(value, 'user-123')).toThrow();
  });
  it('never treats explicit legacy provider results as complete canonical Pool', () => {
    const value = { schema: 'sophia.journal-legacy.v1', owner_id: 'legacy-owner', authority: 'legacy_provider',
      enumeration_complete: false, count: 1, entries: [{ id: 'legacy-id', content: 'LEGACY_SCOPED_TEXT', category: null, metadata: null, created_at: null }] };
    expect(parseJournalEnvelope(value, 'legacy-owner').enumeration_complete).toBe(false);
    expect(() => parseJournalEnvelope(value, 'other-owner')).toThrow();
    expect(() => parseJournalEnvelope({ ...value, enumeration_complete: true }, 'legacy-owner')).toThrow();
    expect(() => parseJournalEnvelope({ ...value, entries: poolFixture().entries }, 'legacy-owner')).toThrow();
  });
});
