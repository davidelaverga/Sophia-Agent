/**
 * Sophia Presence System
 * Sprint 1+ - UX Polish
 * 
 * Makes Sophia feel alive through contextual status messages
 * and subtle presence indicators. The goal is to make the AI
 * feel like a thoughtful companion, not a chatbot.
 */

import type { PresetType, ContextMode } from './session-types';
import { getTimeOfDay } from './time-greetings';

// ============================================================================
// TYPES
// ============================================================================

export type PresenceState = 
  | 'ready'      // Waiting for user
  | 'listening'  // User is typing/speaking
  | 'thinking'   // Processing response
  | 'speaking'   // Delivering response
  | 'away'       // Tab not focused (future)
  | 'connecting' // Initial load
  | 'offline';   // Backend unavailable

export interface PresenceDisplay {
  /** Status text shown below mic */
  status: string;
  /** Color token for the dot */
  dotColor: 'green' | 'purple' | 'amber' | 'gray' | 'red';
  /** Whether dot should pulse */
  shouldPulse: boolean;
  /** ARIA label for accessibility */
  ariaLabel: string;
}

// ============================================================================
// STATUS MESSAGES - Contextual & Time-Aware
// ============================================================================

const READY_MESSAGES: Record<PresetType, Record<'day' | 'night', string[]>> = {
  prepare: {
    day: [
      "Sophia — Ready to help you focus",
      "Sophia — Here when you are",
      "Sophia — Ready to prep",
    ],
    night: [
      "Sophia — Ready for tonight",
      "Sophia — Here when you need",
      "Sophia — Let's get you ready",
    ],
  },
  debrief: {
    day: [
      "Sophia — Ready to listen",
      "Sophia — Here to help you reflect",
      "Sophia — Ready when you are",
    ],
    night: [
      "Sophia — Ready to hear how it went",
      "Sophia — Here to help process",
      "Sophia — Ready to reflect together",
    ],
  },
  reset: {
    day: [
      "Sophia — Here to help you reset",
      "Sophia — Ready to calm the noise",
      "Sophia — Take your time",
    ],
    night: [
      "Sophia — Here if you need to reset",
      "Sophia — Ready to help you unwind",
      "Sophia — No rush",
    ],
  },
  vent: {
    day: [
      "Sophia — Safe space, always",
      "Sophia — Here to listen",
      "Sophia — No judgment, just support",
    ],
    night: [
      "Sophia — Here to listen",
      "Sophia — Let it out when ready",
      "Sophia — Safe space",
    ],
  },
  open: {
    day: [
      "Sophia — Ready",
      "Sophia — Here for whatever",
      "Sophia — What's on your mind?",
    ],
    night: [
      "Sophia — Still here",
      "Sophia — Ready when you are",
      "Sophia — Here for you",
    ],
  },
  chat: {
    day: [
      "Sophia — Ready",
      "Sophia — Here for whatever",
      "Sophia — What's on your mind?",
    ],
    night: [
      "Sophia — Still here",
      "Sophia — Ready when you are",
      "Sophia — Here for you",
    ],
  },
};

const LISTENING_MESSAGES = [
  "Listening...",
  "I'm here...",
  "Go on...",
];

const THINKING_MESSAGES: Record<PresetType, string[]> = {
  prepare: [
    "Thinking about your focus...",
    "Processing...",
    "Considering...",
  ],
  debrief: [
    "Reflecting on that...",
    "Taking that in...",
    "Processing...",
  ],
  reset: [
    "Finding the right words...",
    "Thinking...",
    "Processing...",
  ],
  vent: [
    "I hear you...",
    "Taking that in...",
    "Processing...",
  ],
  open: [
    "Thinking...",
    "Processing...",
    "Considering...",
  ],
  chat: [
    "Thinking...",
    "Processing...",
    "Considering...",
  ],
};

const SPEAKING_MESSAGES = [
  "Sophia is responding",
  "Sharing thoughts...",
  "Speaking...",
];

// ============================================================================
// CORE FUNCTION
// ============================================================================

/**
 * Get presence display based on current state and context
 */
export function getPresenceDisplay(
  state: PresenceState,
  presetType: PresetType = 'open',
  turnCount: number = 0
): PresenceDisplay {
  const timeOfDay = getTimeOfDay();
  const isNight = timeOfDay === 'evening' || timeOfDay === 'lateNight';
  const timeKey = isNight ? 'night' : 'day';
  
  switch (state) {
    case 'ready': {
      // Vary message occasionally for returning users
      const messages = READY_MESSAGES[presetType][timeKey];
      const index = turnCount % messages.length;
      return {
        status: messages[index],
        dotColor: 'green',
        shouldPulse: true,
        ariaLabel: 'Sophia is ready and listening',
      };
    }
    
    case 'listening': {
      const index = Math.min(turnCount, LISTENING_MESSAGES.length - 1);
      return {
        status: LISTENING_MESSAGES[index],
        dotColor: 'purple',
        shouldPulse: true,
        ariaLabel: 'Sophia is listening to you',
      };
    }
    
    case 'thinking': {
      const messages = THINKING_MESSAGES[presetType];
      const index = turnCount % messages.length;
      return {
        status: messages[index],
        dotColor: 'amber',
        shouldPulse: false,
        ariaLabel: 'Sophia is thinking',
      };
    }
    
    case 'speaking': {
      const index = turnCount % SPEAKING_MESSAGES.length;
      return {
        status: SPEAKING_MESSAGES[index],
        dotColor: 'amber',
        shouldPulse: false,
        ariaLabel: 'Sophia is responding',
      };
    }
    
    case 'connecting':
      return {
        status: 'Connecting...',
        dotColor: 'gray',
        shouldPulse: true,
        ariaLabel: 'Connecting to Sophia',
      };
    
    case 'offline':
      return {
        status: 'Sophia — Offline mode',
        dotColor: 'red',
        shouldPulse: false,
        ariaLabel: 'Sophia is in offline mode',
      };
    
    case 'away':
      return {
        status: 'Sophia — Away',
        dotColor: 'gray',
        shouldPulse: false,
        ariaLabel: 'Sophia is waiting',
      };
    
    default:
      return {
        status: 'Sophia — Ready',
        dotColor: 'green',
        shouldPulse: true,
        ariaLabel: 'Sophia is ready',
      };
  }
}

/**
 * Get the dot color class based on color token
 */
export function getPresenceDotColor(color: PresenceDisplay['dotColor']): {
  outer: string;
  inner: string;
} {
  switch (color) {
    case 'green':
      return {
        outer: 'bg-green-400',
        inner: 'bg-green-500',
      };
    case 'purple':
      return {
        outer: 'bg-sophia-purple',
        inner: 'bg-sophia-purple',
      };
    case 'amber':
      return {
        outer: 'bg-amber-400',
        inner: 'bg-amber-400',
      };
    case 'red':
      return {
        outer: 'bg-red-400',
        inner: 'bg-red-500',
      };
    case 'gray':
      return {
        outer: 'bg-gray-400',
        inner: 'bg-gray-500',
      };
  }
}

// ============================================================================
// CONTEXTUAL PLACEHOLDER MESSAGES
// ============================================================================

/**
 * Get a contextual placeholder for the input field
 */
export function getContextualPlaceholder(
  presetType: PresetType,
  contextMode: ContextMode,
  turnCount: number
): string {
  // First turn - welcoming
  if (turnCount === 0) {
    const firstTurnMessages: Record<PresetType, Record<ContextMode, string>> = {
      prepare: {
        gaming: "What game are you about to play?",
        work: "What's the focus for today?",
        life: "What's on your mind?",
      },
      debrief: {
        gaming: "How did your session go?",
        work: "How was your day?",
        life: "What happened?",
      },
      reset: {
        gaming: "What's got you tilted?",
        work: "What's stressing you out?",
        life: "What do you need to release?",
      },
      vent: {
        gaming: "Let it out...",
        work: "What's bothering you?",
        life: "I'm listening...",
      },
      open: {
        gaming: "What's up?",
        work: "What's on your mind?",
        life: "Talk to me...",
      },
      chat: {
        gaming: "What's up?",
        work: "What's on your mind?",
        life: "Talk to me...",
      },
    };
    return firstTurnMessages[presetType][contextMode];
  }
  
  // Subsequent turns - continuing conversation
  const continuingMessages = [
    "Continue the conversation...",
    "Say more...",
    "What else?",
    "Tell me more...",
    "Go on...",
  ];
  
  return continuingMessages[turnCount % continuingMessages.length];
}
