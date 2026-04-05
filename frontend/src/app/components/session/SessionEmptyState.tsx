/**
 * SessionEmptyState Component
 * Sprint 1 - Week 1
 * 
 * Empty state shown when conversation hasn't started yet.
 * Context-aware messaging based on preset and context mode.
 */

'use client';

import { useMemo } from 'react';
import { MessageCircle, Sparkles, Mic } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { PresetType, ContextMode } from '../../lib/session-types';

// ============================================================================
// TYPES
// ============================================================================

interface SessionEmptyStateProps {
  presetType: PresetType;
  contextMode: ContextMode;
  onPromptSelect?: (prompt: string) => void;
  className?: string;
}

// ============================================================================
// COPY MATRIX
// ============================================================================

const EMPTY_STATE_COPY: Record<PresetType, Record<ContextMode, {
  heading: string;
  subheading: string;
  prompts: string[];
}>> = {
  prepare: {
    gaming: {
      heading: "Let's lock in.",
      subheading: "Tell Sophia what you're playing and what matters this session.",
      prompts: [
        "I'm about to play ranked, help me focus",
        "I want to work on my positioning",
        "Last game tilted me, reset my mindset",
      ],
    },
    work: {
      heading: "Let's set your intention.",
      subheading: "Share what you're working on and what you want to accomplish.",
      prompts: [
        "I have a big meeting today, help me prepare",
        "I'm feeling scattered, help me prioritize",
        "I want to focus deeply for the next 2 hours",
      ],
    },
    life: {
      heading: "What's on your mind?",
      subheading: "Share what you want to prepare for or think through.",
      prompts: [
        "I have a difficult conversation coming up",
        "I need to make a decision about something",
        "Help me think through my week",
      ],
    },
  },
  debrief: {
    gaming: {
      heading: "How'd it go?",
      subheading: "Let's process that session. What happened?",
      prompts: [
        "I played well but we still lost",
        "I tilted and threw the game",
        "That was a great session, let me break it down",
      ],
    },
    work: {
      heading: "Let's reflect.",
      subheading: "How was your work session? What's worth noting?",
      prompts: [
        "I got a lot done today",
        "I struggled to focus, not sure why",
        "Something at work is bothering me",
      ],
    },
    life: {
      heading: "Let's talk about it.",
      subheading: "What happened that you want to process?",
      prompts: [
        "I had an interesting conversation today",
        "Something happened and I need to think it through",
        "I want to reflect on how I handled something",
      ],
    },
  },
  reset: {
    gaming: {
      heading: "Let's reset.",
      subheading: "Shake off the last game. What's going on?",
      prompts: [
        "I'm tilted and need to calm down",
        "Bad teammates are getting to me",
        "I keep making the same mistakes",
      ],
    },
    work: {
      heading: "Take a breath.",
      subheading: "Let's reset your mental state. What's weighing on you?",
      prompts: [
        "I'm stressed about a deadline",
        "I can't focus on anything",
        "Work drama is affecting me",
      ],
    },
    life: {
      heading: "Let's pause.",
      subheading: "Take a moment to reset. What do you need right now?",
      prompts: [
        "I'm feeling overwhelmed",
        "I need to calm my anxiety",
        "Help me ground myself",
      ],
    },
  },
  vent: {
    gaming: {
      heading: "Let it out.",
      subheading: "I'm here to listen. What's frustrating you?",
      prompts: [
        "My teammates are so bad",
        "This game is so unfair sometimes",
        "I'm done with ranked for today",
      ],
    },
    work: {
      heading: "I'm listening.",
      subheading: "Vent freely. No judgment here.",
      prompts: [
        "My coworker is driving me crazy",
        "I hate this project",
        "I'm so burned out",
      ],
    },
    life: {
      heading: "Say what you need to say.",
      subheading: "This is a safe space. Let it out.",
      prompts: [
        "I'm so frustrated right now",
        "No one understands what I'm going through",
        "I just need someone to listen",
      ],
    },
  },
  open: {
    gaming: {
      heading: "Hey. What's on your mind?",
      subheading: "No agenda. Just talk.",
      prompts: [
        "Just wanted to chat",
        "Something's on my mind",
        "How's your day going?",
      ],
    },
    work: {
      heading: "Hey. I'm here.",
      subheading: "No structure needed. What's up?",
      prompts: [
        "I just need to think out loud",
        "Something happened today",
        "Can we just talk?",
      ],
    },
    life: {
      heading: "Hey. Talk to me.",
      subheading: "I'm listening. No agenda.",
      prompts: [
        "I don't know where to start",
        "Just wanted to talk to someone",
        "What's on my mind today...",
      ],
    },
  },
  chat: {
    gaming: {
      heading: "Hey. What's on your mind?",
      subheading: "No agenda. Just talk.",
      prompts: [
        "Just wanted to chat",
        "Something's on my mind",
        "How's your day going?",
      ],
    },
    work: {
      heading: "Hey. I'm here.",
      subheading: "No structure needed. What's up?",
      prompts: [
        "I just need to think out loud",
        "Something happened today",
        "Can we just talk?",
      ],
    },
    life: {
      heading: "Hey. Talk to me.",
      subheading: "I'm listening. No agenda.",
      prompts: [
        "I don't know where to start",
        "Just wanted to talk to someone",
        "What's on my mind today...",
      ],
    },
  },
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SessionEmptyState({ 
  presetType, 
  contextMode, 
  onPromptSelect,
  className 
}: SessionEmptyStateProps) {
  const copy = useMemo(() => {
    return EMPTY_STATE_COPY[presetType]?.[contextMode] || EMPTY_STATE_COPY.prepare.life;
  }, [presetType, contextMode]);
  
  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center px-6 py-12',
      className
    )}>
      {/* Icon */}
      <div className="relative mb-6">
        <div className="w-16 h-16 rounded-2xl bg-sophia-purple/10 flex items-center justify-center">
          <MessageCircle className="w-8 h-8 text-sophia-purple" />
        </div>
        <Sparkles className="absolute -top-1 -right-1 w-5 h-5 text-sophia-purple animate-pulse" />
      </div>
      
      {/* Heading */}
      <h2 className="text-xl font-semibold text-sophia-text mb-2">
        {copy.heading}
      </h2>
      
      {/* Subheading */}
      <p className="text-sophia-text2 text-sm max-w-xs mb-8">
        {copy.subheading}
      </p>
      
      {/* Quick Prompts */}
      {onPromptSelect && (
        <div className="w-full max-w-sm space-y-2">
          <p className="text-xs text-sophia-text2 uppercase tracking-wide mb-3">
            Quick starters
          </p>
          {copy.prompts.map((prompt, index) => (
            <button
              key={prompt}
              onClick={() => {
                haptic('light');
                onPromptSelect(prompt);
              }}
              className={cn(
                'w-full text-left px-4 py-3 rounded-xl text-sm transition-all duration-200',
                'bg-sophia-surface border border-sophia-surface-border',
                'hover:bg-sophia-button-hover',
                'active:scale-[0.98]',
                'text-sophia-text hover:text-sophia-purple',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                'animate-fadeIn opacity-0'
              )}
              style={{ 
                animationDelay: `${index * 100}ms`,
                animationFillMode: 'forwards'
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      
      {/* Voice hint */}
      <div className="mt-8 flex items-center gap-2 text-xs text-sophia-text2">
        <Mic className="w-3.5 h-3.5" />
        <span>Or just start talking — voice is coming soon</span>
      </div>
    </div>
  );
}

export default SessionEmptyState;
