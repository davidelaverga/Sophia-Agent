import { describe, expect, it } from 'vitest';

import {
  getLiveArtifactStatus,
  mergeRitualArtifacts,
  normalizeMemoryCandidates,
} from '../../app/session/artifacts';

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

  it('normalizes legacy reflection artifacts into the canonical reflection candidate shape', () => {
    const result = mergeRitualArtifacts(
      { takeaway: '' },
      {
        takeaway: 'You stayed with the hard part instead of rushing past it.',
        reflection: 'What feels different now that you named it directly?',
      },
      {
        filterFallbackReflection: true,
        filterFallbackTakeaway: true,
      }
    );

    expect(result.merged.reflection_candidate).toEqual({
      prompt: 'What feels different now that you named it directly?',
    });
    expect(getLiveArtifactStatus(result.merged).reflection).toBe('ready');
  });
});
