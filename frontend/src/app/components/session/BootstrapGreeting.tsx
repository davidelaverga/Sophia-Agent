/**
 * Bootstrap Greeting
 * Session Bootstrap Experience - "Sophia is present instantly"
 * 
 * The warm start layer that renders BEFORE any chat streaming.
 * Shows:
 * - Personalized greeting from Sophia
 * - Memory highlight cards (max 3)
 * - Resume banner (if applicable)
 * 
 * This makes the session screen feel "alive" immediately.
 */

'use client';

import { useEffect, useRef, memo } from 'react';
import { cn } from '../../lib/utils';
import { MemoryHighlightCards } from './MemoryHighlightCard';
import { ResumeBanner } from './ResumeBanner';
import type { MemoryHighlight, PresetType, ContextMode } from '../../types/session';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapGreetingProps {
  /** The greeting message from Sophia */
  greetingMessage: string;
  /** Message ID for persistence */
  messageId: string;
  /** Memory highlights to display */
  memoryHighlights?: MemoryHighlight[];
  /** Whether this is a resumed session */
  isResumed?: boolean;
  /** Callback when greeting is rendered (for deduplication) */
  onGreetingRendered?: () => void;
  /** Session type for resume banner */
  sessionType?: PresetType;
  /** Context mode for resume banner */
  contextMode?: ContextMode;
  /** Resume callbacks */
  onResume?: () => void;
  onStartFresh?: () => void;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show resume banner */
  showResumeBanner?: boolean;
}

// =============================================================================
// GREETING MESSAGE COMPONENT (looks like a chat bubble but marked as bootstrap)
// =============================================================================

interface GreetingBubbleProps {
  message: string;
  messageId: string;
  className?: string;
}

const GreetingBubble = memo(function GreetingBubble({ 
  message, 
  messageId,
  className 
}: GreetingBubbleProps) {
  return (
    <div 
      className={cn(
        'bootstrap-greeting',
        // Bubble styling (matches assistant message style)
        'max-w-[85%] sm:max-w-[75%] md:max-w-[70%]',
        'px-4 py-3 rounded-2xl',
        'bg-sophia-surface',
        'border border-sophia-surface-border',
        'shadow-soft',
        // Animation - fade in from left
        'opacity-0 -translate-x-2',
        'animate-[slideInLeft_0.4s_ease-out_forwards]',
        className
      )}
      data-message-id={messageId}
      data-bootstrap="true"
    >
      {/* Sophia indicator */}
      <div className="flex items-center gap-2 mb-2">
        <div className={cn(
          'w-6 h-6 rounded-full',
          'bg-gradient-to-br from-sophia-purple to-sophia-purple/70',
          'flex items-center justify-center',
          'shadow-sm'
        )}>
          <span className="text-xs text-white font-medium">S</span>
        </div>
        <span className="text-xs text-sophia-text2 font-medium">Sophia</span>
      </div>
      
      {/* Greeting text */}
      <p className={cn(
        'text-sm sm:text-base leading-relaxed',
        'text-sophia-text'
      )}>
        {message}
      </p>
    </div>
  );
});

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function BootstrapGreeting({
  greetingMessage,
  messageId,
  memoryHighlights = [],
  isResumed = false,
  onGreetingRendered,
  sessionType,
  contextMode,
  onResume,
  onStartFresh,
  className,
  showResumeBanner = false,
}: BootstrapGreetingProps) {
  // Track if we've fired the rendered callback
  const hasCalledRenderedRef = useRef(false);
  
  // Call onGreetingRendered once when component mounts
  useEffect(() => {
    if (hasCalledRenderedRef.current) return;
    hasCalledRenderedRef.current = true;
    
    // Small delay to ensure DOM has painted
    const timer = setTimeout(() => {
      onGreetingRendered?.();
    }, 100);
    
    return () => clearTimeout(timer);
  }, [onGreetingRendered]);
  
  const hasMemories = memoryHighlights.length > 0;
  
  return (
    <div 
      className={cn(
        'bootstrap-greeting-container',
        'space-y-4',
        'animate-fadeIn',
        className
      )}
      role="region"
      aria-label="Session start"
    >
      {/* Resume Banner (if applicable) */}
      {showResumeBanner && isResumed && sessionType && onResume && onStartFresh && (
        <ResumeBanner
          sessionType={sessionType}
          contextMode={contextMode}
          onResume={onResume}
          onStartFresh={onStartFresh}
          className="mb-4"
        />
      )}
      
      {/* Memory Highlights Cards (shown BEFORE greeting) */}
      {hasMemories && (
        <MemoryHighlightCards
          highlights={memoryHighlights}
          maxDisplay={3}
          className="mb-2"
        />
      )}
      
      {/* Greeting Message */}
      <GreetingBubble
        message={greetingMessage}
        messageId={messageId}
      />
    </div>
  );
}

// =============================================================================
// SKELETON LOADER (for instant visual)
// =============================================================================

export function BootstrapGreetingSkeleton() {
  return (
    <div className="bootstrap-greeting-skeleton space-y-4 animate-pulse">
      {/* Memory card skeleton */}
      <div className="space-y-2">
        <div className="h-3 w-32 bg-sophia-surface-hover rounded" />
        <div className="h-20 bg-sophia-surface/50 rounded-2xl border border-sophia-surface-border/50" />
      </div>
      
      {/* Greeting skeleton */}
      <div className="max-w-[70%] px-4 py-3 rounded-2xl bg-sophia-surface border border-sophia-surface-border">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-sophia-surface-hover" />
          <div className="h-3 w-12 bg-sophia-surface-hover rounded" />
        </div>
        <div className="space-y-2">
          <div className="h-4 bg-sophia-surface-hover rounded w-full" />
          <div className="h-4 bg-sophia-surface-hover rounded w-3/4" />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// EMPTY STATE (fallback when no bootstrap data)
// =============================================================================

export function BootstrapEmptyState({ sessionType }: { sessionType?: PresetType }) {
  const fallbackMessages: Record<PresetType, string> = {
    prepare: "Let's get you ready. What's on your mind?",
    debrief: "How did it go? I'm here to listen.",
    reset: "Take a breath. Let's reset together.",
    vent: "I'm here. Let it out.",
    open: "I'm here with you. What's on your mind?",
    chat: "Hey! What's going on?",
  };
  
  const message = sessionType 
    ? fallbackMessages[sessionType] 
    : "I'm here with you. What's on your mind?";
  
  return (
    <GreetingBubble
      message={message}
      messageId="fallback-greeting"
    />
  );
}

export default BootstrapGreeting;
