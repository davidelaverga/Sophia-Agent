/**
 * Tests for Zod API Schemas
 * Validates schema parsing for all session-related API responses
 */

import { describe, it, expect, vi } from 'vitest';

import {
  SessionStartResponseSchema,
  SessionEndResponseSchema,
  ActiveSessionResponseSchema,
  MicroBriefingResponseSchema,
  InterruptPayloadSchema,
  validateResponse,
  parseWithFallback,
  parseOrThrow,
} from '../../app/lib/schemas/session-schemas';

describe('SessionStartResponseSchema', () => {
  it('should parse valid session start response', () => {
    const validResponse = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      thread_id: '123e4567-e89b-12d3-a456-426614174001',
      greeting_message: 'Hello! Ready to start?',
      message_id: 'msg_123',
      memory_highlights: [],
      is_resumed: false,
      briefing_source: 'fallback',
      has_memory: false,
      session_type: 'prepare',
      preset_context: 'gaming',
      started_at: '2024-01-15T10:00:00Z',
    };

    const result = SessionStartResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe(validResponse.session_id);
      expect(result.data.greeting_message).toBe(validResponse.greeting_message);
    }
  });

  it('should apply defaults for missing optional fields', () => {
    const minimalResponse = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      thread_id: '123e4567-e89b-12d3-a456-426614174001',
      session_type: 'prepare',
      preset_context: 'gaming',
      started_at: '2024-01-15T10:00:00Z',
    };

    const result = SessionStartResponseSchema.safeParse(minimalResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.greeting_message).toBe('Hey! Ready to get started?');
      expect(result.data.memory_highlights).toEqual([]);
      expect(result.data.is_resumed).toBe(false);
    }
  });

  it('should reject invalid session_id', () => {
    const invalidResponse = {
      session_id: '', // empty string, invalid
      thread_id: '123e4567-e89b-12d3-a456-426614174001',
      session_type: 'prepare',
      preset_context: 'gaming',
      started_at: '2024-01-15T10:00:00Z',
    };

    const result = SessionStartResponseSchema.safeParse(invalidResponse);
    expect(result.success).toBe(false);
  });

  it('should parse memory highlights array', () => {
    const responseWithMemories = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      thread_id: '123e4567-e89b-12d3-a456-426614174001',
      session_type: 'prepare',
      preset_context: 'gaming',
      started_at: '2024-01-15T10:00:00Z',
      memory_highlights: [
        { id: 'mem_1', text: 'Previous session highlight', category: 'goals' },
        { id: 'mem_2', text: 'Another highlight', salience: 0.8 },
      ],
    };

    const result = SessionStartResponseSchema.safeParse(responseWithMemories);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory_highlights).toHaveLength(2);
      expect(result.data.memory_highlights[0].text).toBe('Previous session highlight');
    }
  });

  it('should accept null recency_label in memory highlights', () => {
    const responseWithNullRecency = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      thread_id: '123e4567-e89b-12d3-a456-426614174001',
      session_type: 'prepare',
      preset_context: 'gaming',
      started_at: '2024-01-15T10:00:00Z',
      memory_highlights: [
        { id: 'mem_1', text: 'Previous session highlight', recency_label: null },
      ],
    };

    const result = SessionStartResponseSchema.safeParse(responseWithNullRecency);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory_highlights[0].recency_label).toBeUndefined();
    }
  });
});

describe('SessionEndResponseSchema', () => {
  it('should parse valid session end response', () => {
    const validResponse = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      ended_at: '2024-01-15T11:30:00Z',
      duration_minutes: 90,
      turn_count: 15,
      recap_artifacts: {
        takeaway: 'Great session!',
        memories_created: 3,
      },
      offer_debrief: true,
      debrief_prompt: 'Would you like to debrief?',
    };

    const result = SessionEndResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.duration_minutes).toBe(90);
      expect(result.data.offer_debrief).toBe(true);
    }
  });

  it('should accept null recap_artifacts', () => {
    const responseWithNull = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      ended_at: '2024-01-15T11:30:00Z',
      duration_minutes: 0,
      turn_count: 0,
      recap_artifacts: null,
    };

    const result = SessionEndResponseSchema.safeParse(responseWithNull);
    expect(result.success).toBe(true);
  });

  it('should parse builder artifacts inside recap_artifacts', () => {
    const responseWithBuilderArtifact = {
      session_id: '123e4567-e89b-12d3-a456-426614174000',
      ended_at: '2024-01-15T11:30:00Z',
      duration_minutes: 22,
      turn_count: 9,
      recap_artifacts: {
        takeaway: 'You finished with a concrete deliverable.',
        builder_artifact: {
          artifactTitle: 'Investor memo',
          artifactType: 'document',
          artifactPath: 'mnt/user-data/outputs/investor-memo.md',
          decisionsMade: ['Cut the pricing appendix'],
        },
      },
    };

    const result = SessionEndResponseSchema.safeParse(responseWithBuilderArtifact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recap_artifacts?.builder_artifact?.artifactTitle).toBe('Investor memo');
      expect(result.data.recap_artifacts?.builder_artifact?.decisionsMade).toEqual(['Cut the pricing appendix']);
    }
  });
});

describe('ActiveSessionResponseSchema', () => {
  it('should parse response with no active session', () => {
    const noSession = {
      has_active_session: false,
      session: null,
    };

    const result = ActiveSessionResponseSchema.safeParse(noSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.has_active_session).toBe(false);
      expect(result.data.session).toBeNull();
    }
  });

  it('should parse response with active session', () => {
    const withSession = {
      has_active_session: true,
      session: {
        session_id: '123e4567-e89b-12d3-a456-426614174000',
        thread_id: '123e4567-e89b-12d3-a456-426614174001',
        session_type: 'gaming_prepare',
        preset_context: 'gaming',
        status: 'active',
        started_at: '2024-01-15T10:00:00Z',
        turn_count: 5,
      },
    };

    const result = ActiveSessionResponseSchema.safeParse(withSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.has_active_session).toBe(true);
      expect(result.data.session?.status).toBe('active');
    }
  });
});

describe('InterruptPayloadSchema', () => {
  it('should parse DEBRIEF_OFFER interrupt', () => {
    const debriefOffer = {
      kind: 'DEBRIEF_OFFER' as const,
      title: 'Session Complete',
      message: 'Would you like to debrief?',
      options: [
        { id: 'start_debrief', label: 'Start Debrief', style: 'primary' as const },
        { id: 'skip', label: 'Skip', style: 'ghost' as const },
      ],
      snooze: true,
    };

    const result = InterruptPayloadSchema.safeParse(debriefOffer);
    expect(result.success).toBe(true);
  });

  it('should parse MICRO_DIALOG interrupt', () => {
    const microDialog = {
      kind: 'MICRO_DIALOG' as const,
      dialogKind: 'feedback',
      title: 'Quick Check',
      message: 'How are you feeling?',
      options: [
        { id: 'good', label: '👍 Good' },
        { id: 'meh', label: '😐 Okay' },
        { id: 'bad', label: '👎 Not great' },
      ],
    };

    const result = InterruptPayloadSchema.safeParse(microDialog);
    expect(result.success).toBe(true);
  });

  it('should reject unknown interrupt kind', () => {
    const invalidInterrupt = {
      kind: 'UNKNOWN_KIND',
      title: 'Test',
      message: 'Test message',
      options: [],
    };

    const result = InterruptPayloadSchema.safeParse(invalidInterrupt);
    expect(result.success).toBe(false);
  });
});

describe('Validation Helpers', () => {
  describe('validateResponse', () => {
    it('should return success with valid data', () => {
      const result = validateResponse(
        MicroBriefingResponseSchema,
        {
          message_id: 'msg_1',
          assistant_text: 'Hello!',
          highlights: [],
        },
        'MicroBriefing'
      );

      expect(result.success).toBe(true);
      expect(result.data?.assistant_text).toBe('Hello!');
    });

    it('should return error for invalid data', () => {
      const result = validateResponse(
        MicroBriefingResponseSchema,
        { invalid: 'data' },
        'MicroBriefing'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.issues).toBeDefined();
    });
  });

  describe('parseWithFallback', () => {
    it('should return parsed data on success', () => {
      const data = parseWithFallback(
        MicroBriefingResponseSchema,
        { message_id: 'msg_1', assistant_text: 'Hello!' },
        { message_id: 'fallback', assistant_text: 'Fallback', highlights: [], briefing_source: 'fallback', has_memory: false },
        'Test'
      );

      expect(data.assistant_text).toBe('Hello!');
    });

    it('should return fallback on failure', () => {
      const fallback = {
        message_id: 'fallback',
        assistant_text: 'Fallback message',
        highlights: [],
        briefing_source: 'fallback' as const,
        has_memory: false,
      };

      const data = parseWithFallback(
        MicroBriefingResponseSchema,
        { invalid: 'data' },
        fallback,
        'Test'
      );

      expect(data.assistant_text).toBe('Fallback message');
    });
  });

  describe('parseOrThrow', () => {
    it('should return data on success', () => {
      const data = parseOrThrow(
        MicroBriefingResponseSchema,
        { message_id: 'msg_1', assistant_text: 'Hello!' },
        'Test'
      );

      expect(data.assistant_text).toBe('Hello!');
    });

    it('should throw on invalid data', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() => {
        parseOrThrow(
          MicroBriefingResponseSchema,
          { invalid: 'data' },
          'Test'
        );
      }).toThrow('[Test] Invalid response');
      errorSpy.mockRestore();
    });
  });
});
