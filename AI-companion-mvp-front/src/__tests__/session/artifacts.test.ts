import { describe, expect, it } from 'vitest';

import { mergeRitualArtifacts, normalizeMemoryCandidates } from '../../app/session/artifacts';

describe('session artifacts helpers', () => {
  it('normalizes memory candidates and filters non-string tags', () => {
    const normalized = normalizeMemoryCandidates([
      {
        text: 'I feel focused after short breaks',
        category: 'emotional_patterns',
        confidence: 0.9,
        tags: ['focus', 123, 'breaks'],
      },
    ]);

    expect(normalized).toEqual([
      {
        memory: 'I feel focused after short breaks',
        category: 'emotional_patterns',
        confidence: 0.9,
        tags: ['focus', 'breaks'],
      },
    ]);
  });

  it('ignores non-object incoming payload in merge', () => {
    const result = mergeRitualArtifacts({ takeaway: 'Existing takeaway' }, 'invalid-payload');

    expect(result.merged.takeaway).toBe('Existing takeaway');
    expect(result.normalizedMemoryCandidates).toEqual([]);
  });
});
