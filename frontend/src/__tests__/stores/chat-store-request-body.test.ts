import { describe, expect, it } from 'vitest';

import { buildChatRouteBody } from '../../app/chat/useChatRouteExperience';

describe('buildChatRouteBody', () => {
  it('builds the canonical /chat payload shape', () => {
    const payload = buildChatRouteBody({
      conversationId: 'conv-1',
      userId: 'user-1',
    });

    expect(payload).toEqual({
      session_id: 'conv-1',
      session_type: 'chat',
      context_mode: 'life',
      user_id: 'user-1',
    });
  });

  it('does not include skill-selection fields in chat payload', () => {
    const payload = buildChatRouteBody({
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
