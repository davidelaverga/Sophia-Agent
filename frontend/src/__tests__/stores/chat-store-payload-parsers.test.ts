import { describe, expect, it } from 'vitest'

import {
  parseDonePayload,
  parseFeedbackGateMeta,
  parsePresenceMeta,
  parseUsageLimitInfoMeta,
} from '../../app/stores/chat-store-payload-parsers'

describe('chat-store-payload-parsers', () => {
  it('parses presence from nested presence object and top-level fallback', () => {
    const nested = parsePresenceMeta({ presence: { status: 'thinking', detail: 'analyzing' } })
    const topLevel = parsePresenceMeta({ status: 'speaking', detail: 'replying' })

    expect(nested).toEqual({ status: 'thinking', detail: 'analyzing' })
    expect(topLevel).toEqual({ status: 'speaking', detail: 'replying' })
  })

  it('parses feedback gate metadata with fallback turn id', () => {
    const parsed = parseFeedbackGateMeta(
      { feedback_allowed: true, emotional_weight: 0.72 },
      'reply-1',
    )

    expect(parsed).toEqual({
      turnId: 'reply-1',
      allowed: true,
      emotionalWeight: 0.72,
    })
  })

  it('parses usage limit info metadata into normalized shape', () => {
    const parsed = parseUsageLimitInfoMeta({
      usage_info: {
        used: 85,
        limit: 100,
        reason: 'text',
        plan_tier: 'FREE',
      },
    })

    expect(parsed).toEqual({
      used: 85,
      limit: 100,
      reason: 'text',
      plan_tier: 'FREE',
    })
  })

  it('parses done payload aliases and validates backend usage payload', () => {
    const parsed = parseDonePayload(
      {
        message: 'Done',
        audio_url: 'https://audio.example/reply.wav',
        conversation_id: 'conv-1',
        turn_id: 'turn-1',
        usage: {
          plan_tier: 'FREE',
          today: { text_messages: 3, text_tokens: 120, voice_seconds: 0 },
          limits: { daily_text_messages: 100, daily_text_tokens: 10000, daily_voice_seconds: 600 },
          remaining: { text_messages: 97, text_tokens: 9880, voice_seconds: 600 },
        },
      },
      'fallback-turn',
    )

    expect(parsed.turnId).toBe('turn-1')
    expect(parsed.audioUrl).toBe('https://audio.example/reply.wav')
    expect(parsed.conversationId).toBe('conv-1')
    expect(parsed.usage?.today.text_messages).toBe(3)
  })
})
