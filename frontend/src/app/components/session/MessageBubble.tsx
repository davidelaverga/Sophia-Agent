/**
 * MessageBubble Component
 * Sprint 1+ - Enhanced with Markdown & Message Type Detection
 * 
 * Premium message bubble with Sophia styling.
 * - Parses inline markdown (bold, italic, code)
 * - Detects message type for visual differentiation
 * - Supports user/assistant roles, animations, incomplete indicators, and feedback.
 */

'use client';

import { Sparkles, Clock, Mic, Volume2 } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';

import { humanizeTime } from '../../lib/humanize-time';
import { parseInlineMarkdown } from '../../lib/parse-inline-markdown';
import type { SessionMessage } from '../../lib/session-types';
import { cn } from '../../lib/utils';
import type { FeedbackType } from '../../types/sophia-ui-message';

// ============================================================================
// TYPES
// ============================================================================

export interface UIMessage extends SessionMessage {
  /** True for newly added messages (for animation) */
  isNew?: boolean;
  /** Metadata from backend */
  meta?: {
    runId?: string;
    invokeType?: string;
    artifactsStatus?: 'none' | 'partial' | 'ready';
    /** True if message is queued for offline sending */
    queued?: boolean;
  };
  /** User feedback on this message */
  feedback?: FeedbackType;
  /** True when user message comes from voice transcript */
  voiceTranscript?: boolean;
  /** True when assistant message was generated in voice flow */
  voiceResponse?: boolean;
}

interface MessageBubbleProps { 
  message: UIMessage; 
  /** True if this is the most recent assistant message */
  isLatest: boolean;
  /** Callback when user gives feedback */
  onFeedback?: (messageId: string, feedback: FeedbackType) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function MessageBubble({ message, isLatest }: MessageBubbleProps) {
  const [isVisible, setIsVisible] = useState(!message.isNew);
  
  useEffect(() => {
    if (message.isNew) {
      const timer = setTimeout(() => setIsVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [message.isNew]);
  
  const isUser = message.role === 'user';
  const isIncomplete = message.incomplete && !isUser;
  const isQueued = message.meta?.queued === true;
  const isVoiceTranscript = isUser && message.voiceTranscript === true;
  const isVoiceResponse = !isUser && message.voiceResponse === true;
  
  // Parse markdown content for Sophia messages
  const renderedContent = useMemo(() => {
    if (isUser) return message.content;
    return parseInlineMarkdown(message.content);
  }, [isUser, message.content]);
  
  // Format timestamp for display - humanized
  const timeInfo = useMemo(() => {
    return humanizeTime(message.createdAt, 'relative');
  }, [message.createdAt]);
  
  // Auto-update timestamps if needed (for "just now" messages)
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!timeInfo.shouldUpdate) return;
    const timer = setInterval(() => forceUpdate(n => n + 1), 30000); // Update every 30s
    return () => clearInterval(timer);
  }, [timeInfo.shouldUpdate]);
  
  return (
    <div
      role="article"
      aria-label={isUser ? 'You said' : 'Sophia replied'}
      className={cn(
        'flex items-start transition-all duration-300',
        isUser ? 'justify-end' : 'justify-start',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
      )}
    >
      {/* Sophia Avatar - visible for assistant messages */}
      {!isUser && (
        <div className={cn(
          'shrink-0 w-7 h-7 rounded-full flex items-center justify-center mr-2.5 mt-3',
        )}
        style={{
          background: isLatest
            ? 'color-mix(in srgb, var(--sophia-purple) 14%, var(--cosmic-panel-soft))'
            : 'var(--cosmic-panel-soft)',
          border: '1px solid var(--cosmic-border-soft)',
        }}
        >
          <Sparkles className={cn(
            'w-3 h-3 transition-all duration-500',
            isLatest && 'animate-[sparkle_2s_ease-in-out_infinite]',
          )}
          style={{ color: isLatest ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)' }} />
        </div>
      )}
      
      <div
        className={cn(
          'max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl relative group min-w-0',
          isUser
            ? cn(
                'border',
                isQueued && 'border-dashed opacity-70'
              )
            : cn(
                'border font-light'
              ),
          // Subtle glow for assistant's latest message
          !isUser && isLatest && 'shadow-[0_0_24px_var(--cosmic-border-soft)]',
          // Dashed border for incomplete messages
          isIncomplete && 'border-dashed border-amber-400/50'
        )}
        style={isUser ? {
          background: 'var(--user-bubble)',
          borderColor: isQueued ? 'var(--cosmic-text-faint)' : 'color-mix(in srgb, var(--cosmic-teal) 8%, var(--cosmic-border-soft))',
          backdropFilter: 'blur(12px) saturate(1.1)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.1)',
        } : {
          background: 'var(--sophia-bubble)',
          borderColor: 'var(--cosmic-border-soft)',
          borderLeftColor: isLatest ? 'color-mix(in srgb, var(--sophia-purple) 30%, transparent)' : undefined,
          borderLeftWidth: isLatest ? '2px' : undefined,
          backdropFilter: 'blur(16px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.15)',
        }}
      >
        {(isVoiceTranscript || isVoiceResponse) && (
          <span
            className="absolute top-2 right-2 pointer-events-none"
            style={{ color: 'var(--cosmic-text-whisper)' }}
            title={isVoiceTranscript ? 'Voice transcript' : 'Voice reply'}
            aria-hidden="true"
          >
            {isVoiceTranscript ? <Mic className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
          </span>
        )}

        <div className={cn(
          'leading-relaxed whitespace-pre-wrap break-words overflow-hidden',
          // Sophia's text slightly different - more elegant
          !isUser && 'text-[15px]',
          // Dim incomplete text slightly
          isIncomplete && 'opacity-80'
        )}
        style={{
          color: 'var(--cosmic-text-strong)',
          textShadow: '0 1px 6px rgba(0,0,0,0.18)',
        }}
        >
          {renderedContent}
        </div>
        
        {/* Incomplete indicator */}
        {isIncomplete && (
          <span className="block mt-2 text-[11px] text-amber-500/80 italic">
            Response interrupted
          </span>
        )}
        
        {/* Queued message indicator */}
        {isQueued && (
          <span className="mt-2 flex items-center gap-1 text-[11px] italic" style={{ color: 'var(--cosmic-text-whisper)' }}>
            <Clock className="w-3 h-3" />
            Queued - will send when online
          </span>
        )}
        
        {/* Timestamp - revealed on hover, humanized */}
        <span 
          className={cn(
            'absolute -bottom-5 text-[10px] opacity-0 transition-opacity cursor-default group-hover:opacity-100',
            isUser ? 'right-2' : 'left-2'
          )}
          style={{ color: 'var(--cosmic-text-faint)' }}
          title={timeInfo.tooltip}
        >
          {timeInfo.text}
        </span>
      </div>
    </div>
  );
}
