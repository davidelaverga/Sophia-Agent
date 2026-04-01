import { describe, expect, it } from 'vitest';

import { buildChatRequestBody } from '../../app/stores/chat-store';

describe('buildChatRequestBody', () => {
  it('builds a minimal payload with only allowed keys', () => {
    const payload = buildChatRequestBody({
      message: '  hello  ',
      conversationId: ' conv-1 ',
      userId: ' user-1 ',
    });

    expect(payload).toEqual({
      message: 'hello',
      conversationId: 'conv-1',
      user_id: 'user-1',
      platform: 'voice',
    });
  });

  it('does not include skill-selection fields in chat payload', () => {
    const payload = buildChatRequestBody({
      message: 'voice turn',
      conversationId: 'conv-voice',
      userId: 'user-voice',
    }) as Record<string, unknown>;

    expect(payload.skill).toBeUndefined();
    expect(payload.skills).toBeUndefined();
    expect(payload.skill_used).toBeUndefined();
    expect(payload.selected_skill).toBeUndefined();
    expect(payload.selected_skills).toBeUndefined();
  });
});
