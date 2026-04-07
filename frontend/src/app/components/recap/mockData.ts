/**
 * Mock Data for Recap Development
 * Remove this file before production
 */

import type { RecapArtifactsV1, MemoryCandidateV1 } from '../../lib/recap-types';

export const mockMemoryCandidates: MemoryCandidateV1[] = [
  {
    id: 'mem-1',
    text: 'My mother\'s birthday is May 15th. I always call her early in the morning.',
    category: 'relationships',
    confidence: 0.92,
    reason: 'Mentioned multiple times with consistent detail about the early morning call routine.'
  },
  {
    id: 'mem-2', 
    text: 'I feel most anxious when I have back-to-back meetings without breaks.',
    category: 'emotions',
    confidence: 0.87,
    reason: 'Expressed during discussion about work stress, aligned with previous mentions of needing alone time.'
  },
  {
    id: 'mem-3',
    text: 'Weekly journaling on Sunday evenings helps me process the week.',
    category: 'preferences',
    confidence: 0.85,
    reason: 'User described this as an established practice that brings clarity.'
  }
];

export const mockRecapArtifacts: RecapArtifactsV1 = {
  sessionId: 'demo-session-123',
  sessionType: 'debrief',
  contextMode: 'life',
  status: 'ready',
  takeaway: 'Setting boundaries with your work schedule isn\'t selfish—it\'s how you show up better for the people who matter. Small changes, like protecting one lunch break this week, can build into bigger shifts.',
  reflectionCandidate: {
    prompt: 'What would it look like to protect just 30 minutes tomorrow for yourself?',
    tag: 'boundaries',
  },
  memoryCandidates: mockMemoryCandidates,
};

export const mockEmptyRecap: RecapArtifactsV1 = {
  sessionId: 'demo-empty-123',
  sessionType: 'open',
  contextMode: 'work',
  status: 'unavailable',
  takeaway: undefined,
  reflectionCandidate: undefined,
  memoryCandidates: [],
};
