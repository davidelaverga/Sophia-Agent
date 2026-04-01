/**
 * ReflectionBubble Component
 *
 * A visually distinct chat bubble rendered when the user taps "Tap to reflect"
 * from the ArtifactsPanel. Replaces the generic MessageBubble with a premium
 * card that makes the reflection moment feel intentional and special.
 *
 * Two variants:
 *   - prompt  – the user-side "invitation to reflect" card
 *   - response – Sophia's answer, wrapped in a glowing reflection frame
 */

'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Sparkles, Feather } from 'lucide-react';
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
  const [bubbleSize, setBubbleSize] = useState({ width: 0, height: 0 });

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

  useEffect(() => {
    const element = bubbleRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const updateSize = (nextWidth: number, nextHeight: number) => {
      const width = Math.max(0, Math.round(nextWidth));
      const height = Math.max(0, Math.round(nextHeight));
      setBubbleSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };

    const initialRect = element.getBoundingClientRect();
    updateSize(initialRect.width, initialRect.height);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const strokeInset = 1;
  const strokeWidth = Math.max(0, bubbleSize.width - strokeInset * 2);
  const strokeHeight = Math.max(0, bubbleSize.height - strokeInset * 2);
  const hasStrokePath = strokeWidth > 0 && strokeHeight > 0;
  const strokeRadius = Math.max(
    8,
    Math.min(16, strokeWidth / 2, strokeHeight / 2),
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
        {/* Theme border (same visual language as app cards) */}
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{
            padding: '1px',
            background:
              'linear-gradient(135deg, var(--sophia-purple), var(--sophia-glow), var(--sophia-purple))',
            WebkitMask:
              'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            opacity: 0.85,
          }}
        />

        {/* Traveling streak blended into the themed rounded border */}
        <div
          className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none"
          aria-hidden="true"
        >
          {hasStrokePath && (
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${bubbleSize.width} ${bubbleSize.height}`}
            >
              <rect
                x={strokeInset}
                y={strokeInset}
                width={strokeWidth}
                height={strokeHeight}
                rx={strokeRadius}
                ry={strokeRadius}
                fill="none"
                stroke="color-mix(in srgb, var(--sophia-purple) 58%, var(--sophia-glow))"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeDasharray="14 86"
                pathLength="100"
                opacity="0.2"
                style={{ filter: 'blur(1.1px)' }}
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="-100"
                  dur="9.6s"
                  repeatCount="indefinite"
                />
              </rect>
              <rect
                x={strokeInset}
                y={strokeInset}
                width={strokeWidth}
                height={strokeHeight}
                rx={strokeRadius}
                ry={strokeRadius}
                fill="none"
                stroke="var(--sophia-glow)"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeDasharray="7 93"
                pathLength="100"
                opacity="0.88"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="0"
                  to="-100"
                  dur="9.6s"
                  repeatCount="indefinite"
                />
              </rect>
              <rect
                x={strokeInset}
                y={strokeInset}
                width={strokeWidth}
                height={strokeHeight}
                rx={strokeRadius}
                ry={strokeRadius}
                fill="none"
                stroke="color-mix(in srgb, var(--sophia-purple) 35%, var(--sophia-glow))"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeDasharray="3 97"
                pathLength="100"
                opacity="0.95"
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from="-2"
                  to="-102"
                  dur="9.6s"
                  repeatCount="indefinite"
                />
              </rect>
            </svg>
          )}
        </div>

        {/* Card body */}
        <div
          className="relative rounded-2xl px-4 py-3.5"
          style={{
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--sophia-purple) 8%, var(--sophia-user)), color-mix(in srgb, var(--sophia-glow) 5%, var(--sophia-user)))',
          }}
        >
          {/* Label */}
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-5 h-5 rounded-lg flex items-center justify-center"
              style={{
                background:
                  'linear-gradient(135deg, color-mix(in srgb, var(--sophia-purple) 22%, transparent), color-mix(in srgb, var(--sophia-glow) 16%, transparent))',
              }}
            >
              <Feather className="w-3 h-3 text-sophia-purple" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-sophia-purple">
              Reflecting
            </span>
          </div>

          {/* Prompt text */}
          <p className="text-[14px] leading-relaxed text-sophia-text font-medium">
            {reflectionPrompt}
          </p>

          {/* Why line */}
          {reflectionWhy && (
            <p
              className="mt-1.5 text-[11px] leading-relaxed italic"
              style={{
                color:
                  'color-mix(in srgb, var(--sophia-purple) 65%, var(--sophia-text2))',
              }}
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
      {/* Avatar with glow ring */}
      <div
        className={cn(
          'shrink-0 w-8 h-8 rounded-full flex items-center justify-center mr-2 mt-3',
          'bg-sophia-surface border border-sophia-surface-border',
          'ring-2 ring-sophia-purple/40 ring-offset-2 ring-offset-sophia-bg',
        )}
      >
        <Sparkles className="w-4 h-4 text-sophia-purple animate-pulse-slow" />
      </div>

      <div className="relative max-w-[85%] sm:max-w-[75%] group">
        {/* Gradient border */}
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none"
          style={{
            padding: '1px',
            background:
              'linear-gradient(135deg, var(--sophia-purple), var(--sophia-glow), var(--sophia-purple))',
            WebkitMask:
              'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            opacity: 0.7,
          }}
        />

        {/* Glow orb */}
        <div
          className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-3xl pointer-events-none animate-pulse-slow"
          style={{
            background:
              'radial-gradient(circle, color-mix(in srgb, var(--sophia-glow) 14%, transparent), transparent 70%)',
          }}
        />

        {/* Card body */}
        <div
          className="relative rounded-2xl px-4 py-4 min-w-0"
          style={{
            background:
              'linear-gradient(145deg, color-mix(in srgb, var(--sophia-purple) 5%, var(--card-bg)), color-mix(in srgb, var(--sophia-glow) 3%, var(--card-bg)))',
          }}
        >
          {/* Reflection label bar */}
          <div className="flex items-center gap-2 mb-3 pb-2 border-b" style={{ borderColor: 'color-mix(in srgb, var(--sophia-purple) 15%, transparent)' }}>
            <Sparkles className="w-3.5 h-3.5 text-sophia-purple" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-sophia-purple">
              Sophia&apos;s Reflection
            </span>
          </div>

          {/* Response text – slightly larger, more spacious */}
          <div className="text-[15px] leading-[1.75] text-sophia-text whitespace-pre-wrap break-words">
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
