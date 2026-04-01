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

import { useState, useEffect, useMemo } from 'react';
import { Sparkles, Clock, Mic, Volume2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { humanizeTime } from '../../lib/humanize-time';
import { parseInlineMarkdown } from '../../lib/parse-inline-markdown';
import { detectMessageType, getMessageTypeStyle } from '../../lib/message-type-detection';
import { MessageFeedback } from './MessageFeedback';
import type { SessionMessage } from '../../lib/session-types';
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

export function MessageBubble({ message, isLatest, onFeedback }: MessageBubbleProps) {
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
  
  // Detect message type for Sophia messages (for visual differentiation)
  const messageType = useMemo(() => {
    if (isUser) return null;
    return detectMessageType(message.content);
  }, [isUser, message.content]);
  
  const messageTypeStyle = useMemo(() => {
    if (!messageType) return null;
    return getMessageTypeStyle(messageType);
  }, [messageType]);
  
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
          'shrink-0 w-8 h-8 rounded-full flex items-center justify-center mr-2 mt-3',
          'bg-sophia-surface',
          'border border-sophia-surface-border',
          isLatest && 'ring-2 ring-sophia-purple/30 ring-offset-2 ring-offset-sophia-bg'
        )}>
          <Sparkles className={cn(
            'w-4 h-4 text-sophia-purple transition-all duration-500',
            isLatest && 'animate-[sparkle_2s_ease-in-out_infinite]',
            !isLatest && 'opacity-60'
          )} />
        </div>
      )}
      
      <div
        className={cn(
          'max-w-[85%] sm:max-w-[75%] p-4 rounded-2xl relative group min-w-0',
          isUser
            ? cn(
                'bg-sophia-user text-sophia-text',
                // Queued message styling - dashed border and reduced opacity
                isQueued && 'border border-dashed border-sophia-text2/30 opacity-70'
              )
            // Sophia bubble - always has left border for type indication
            : cn(
                'bg-sophia-bubble text-sophia-text border border-sophia-surface-border',
                // Message type accent - 3px left border with color
                'border-l-[3px]',
                messageTypeStyle?.accentClass || 'border-l-transparent'
              ),
          // Subtle glow for assistant's latest message
          !isUser && isLatest && 'shadow-soft',
          // Dashed border for incomplete messages
          isIncomplete && 'border-dashed border-amber-400/50'
        )}
      >
        {(isVoiceTranscript || isVoiceResponse) && (
          <span
            className="absolute top-2 right-2 text-sophia-text2/45 pointer-events-none"
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
        )}>
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
          <span className="flex items-center gap-1 mt-2 text-[11px] text-sophia-text2/70 italic">
            <Clock className="w-3 h-3" />
            Queued - will send when online
          </span>
        )}
        
        {/* Timestamp - revealed on hover, humanized */}
        <span 
          className={cn(
            'absolute -bottom-5 text-[10px] text-sophia-text2/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-default',
            isUser ? 'right-2' : 'left-2'
          )}
          title={timeInfo.tooltip}
        >
          {timeInfo.text}
        </span>
        
        {/* Feedback buttons - only for assistant messages */}
        {!isUser && onFeedback && (
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
