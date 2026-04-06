/**
 * ReflectionBubble Component
 *
 * Cosmic reflection bubbles — part of the presence field.
 * No solid card backgrounds. Text materialises from the void.
 * The nebula shows through everything.
 *
 * Two variants:
 *   - prompt  – the user-side reflection question, floating in the field
 *   - response – Sophia's reflection, emerging like a constellation
 */

'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { humanizeTime } from '../../lib/humanize-time';
import { parseInlineMarkdown } from '../../lib/parse-inline-markdown';
import { MessageFeedback } from './MessageFeedback';
import type { UIMessage } from './MessageBubble';
import type { FeedbackType } from '../../types/sophia-ui-message';

// ============================================================================
// REFLECTION PROMPT BUBBLE (replaces the user message)
// ============================================================================

interface ReflectionPromptBubbleProps {
  message: UIMessage;
  reflectionPrompt: string;
  reflectionWhy?: string;
}

export function ReflectionPromptBubble({
  message,
  reflectionPrompt,
  reflectionWhy,
}: ReflectionPromptBubbleProps) {
  const [isVisible, setIsVisible] = useState(!message.isNew);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (message.isNew) {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [message.isNew]);

  const timeInfo = useMemo(
    () => humanizeTime(message.createdAt, 'relative'),
    [message.createdAt],
  );

  return (
    <div
      role="article"
      aria-label="You chose to reflect"
      className={cn(
        'flex justify-end transition-all duration-500',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
      )}
    >
      <div ref={bubbleRef} className="relative max-w-[85%] sm:max-w-[75%] group">
        {/* Cosmic bloom halo — replaces solid border */}
        <div
          className="absolute -inset-3 rounded-3xl pointer-events-none transition-opacity duration-[2000ms]"
          style={{
            background:
              'radial-gradient(ellipse 90% 80% at 50% 50%, color-mix(in srgb, var(--sophia-glow) 10%, transparent) 0%, transparent 70%)',
            filter: 'blur(20px)',
            opacity: isVisible ? 0.8 : 0,
          }}
        />

        {/* Card body — near-transparent, nebula shows through */}
        <div
          className="relative rounded-2xl px-4 py-3.5 border border-white/[0.04]"
          style={{
            background:
              'linear-gradient(135deg, rgba(232,228,239,0.03), rgba(184,164,232,0.02))',
            backdropFilter: 'blur(8px)',
          }}
        >
          {/* Label — whisper-thin */}
          <div className="flex items-center gap-2 mb-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'color-mix(in srgb, var(--sophia-glow) 40%, rgba(232,228,239,0.15))' }}
            />
            <span className="text-[9px] tracking-[0.18em] lowercase text-white/[0.20]">
              reflecting
            </span>
          </div>

          {/* Prompt text — Cormorant, the question floats */}
          <p className="font-cormorant text-[16px] leading-[1.7] font-light" style={{ color: 'rgba(232,228,239,0.55)', textShadow: '0 1px 8px rgba(0,0,0,0.25)' }}>
            {reflectionPrompt}
          </p>

          {/* Why line */}
          {reflectionWhy && (
            <p
              className="mt-1.5 font-cormorant text-[13px] italic leading-relaxed"
              style={{ color: 'rgba(232,228,239,0.20)' }}
            >
              {reflectionWhy}
            </p>
          )}
        </div>

        {/* Timestamp */}
        <span
          className="absolute -bottom-5 right-2 text-[10px] text-sophia-text2/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-default"
          title={timeInfo.tooltip}
        >
          {timeInfo.text}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// REFLECTION RESPONSE BUBBLE (replaces Sophia's reply MessageBubble)
// ============================================================================

interface ReflectionResponseBubbleProps {
  message: UIMessage;
  isLatest: boolean;
  onFeedback?: (messageId: string, feedback: FeedbackType) => void;
}

export function ReflectionResponseBubble({
  message,
  isLatest: _isLatest,
  onFeedback,
}: ReflectionResponseBubbleProps) {
  const [isVisible, setIsVisible] = useState(!message.isNew);

  useEffect(() => {
    if (message.isNew) {
      const timer = setTimeout(() => setIsVisible(true), 80);
      return () => clearTimeout(timer);
    }
  }, [message.isNew]);

  const renderedContent = useMemo(() => {
    const normalizedContent = message.content.replace(/^\s*\n+/, '');
    return parseInlineMarkdown(normalizedContent);
  }, [message.content]);

  const timeInfo = useMemo(
    () => humanizeTime(message.createdAt, 'relative'),
    [message.createdAt],
  );

  // Re-render stale timestamps
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!timeInfo.shouldUpdate) return;
    const timer = setInterval(() => forceUpdate((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, [timeInfo.shouldUpdate]);

  return (
    <div
      role="article"
      aria-label="Sophia reflects"
      className={cn(
        'flex items-start justify-start transition-all duration-500',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
      )}
    >
      {/* Avatar — cosmic dot, not a card */}
      <div
        className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center mr-2.5 mt-3"
        style={{
          background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 25%, transparent), transparent 70%)',
        }}
      >
        <Sparkles className="w-3 h-3 text-white/[0.25]" />
      </div>

      <div className="relative max-w-[85%] sm:max-w-[75%] group">
        {/* Bloom halo behind the response */}
        <div
          className="absolute -inset-4 rounded-3xl pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 85% 75% at 50% 45%, color-mix(in srgb, var(--sophia-purple) 8%, transparent) 0%, transparent 70%)',
            filter: 'blur(25px)',
            opacity: isVisible ? 0.7 : 0,
            transition: 'opacity 2s ease',
          }}
        />

        {/* Card body — transparent, nebula bleeds through */}
        <div
          className="relative rounded-2xl px-4 py-4 min-w-0 border border-white/[0.03]"
          style={{
            background: 'linear-gradient(145deg, rgba(232,228,239,0.02), rgba(184,164,232,0.015))',
            backdropFilter: 'blur(6px)',
          }}
        >
          {/* Reflection label — whisper-thin, cosmic dust divider */}
          <div className="flex items-center gap-2 mb-3 pb-2" style={{ borderBottom: '1px solid rgba(232,228,239,0.04)' }}>
            <span
              className="w-1 h-1 rounded-full"
              style={{ background: 'color-mix(in srgb, var(--sophia-purple) 35%, rgba(232,228,239,0.12))' }}
            />
            <span className="text-[9px] tracking-[0.18em] lowercase text-white/[0.18]">
              sophia&apos;s reflection
            </span>
          </div>

          {/* Response text — Cormorant, floating in the void */}
          <div className="font-cormorant text-[16px] leading-[1.80] font-light whitespace-pre-wrap break-words" style={{ color: 'rgba(232,228,239,0.55)', textShadow: '0 1px 8px rgba(0,0,0,0.25)' }}>
            {renderedContent}
          </div>

          {/* Incomplete indicator */}
          {message.incomplete && (
            <span className="block mt-2 text-[11px] text-amber-500/80 italic">
              Response interrupted
            </span>
          )}
        </div>

        {/* Timestamp */}
        <span
          className="absolute -bottom-5 left-2 text-[10px] text-sophia-text2/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-default"
          title={timeInfo.tooltip}
        >
          {timeInfo.text}
        </span>

        {/* Feedback */}
        {onFeedback && (
          <div className="absolute -bottom-5 right-2">
            <MessageFeedback
              messageId={message.id}
              currentFeedback={message.feedback}
              onFeedback={onFeedback}
              compact
            />
          </div>
        )}
      </div>
    </div>
  );
}
