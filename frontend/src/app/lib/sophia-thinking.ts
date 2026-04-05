/**
 * Sophia Thinking States
 * Sprint 1+ - Make Sophia feel alive while thinking
 * 
 * This module creates dynamic, contextual thinking indicators
 * that respond to:
 * - Session type (prepare, debrief, reset, vent, open)
 * - Context mode (gaming, work, life)
 * - Time of day
 * - Conversation depth (turn count)
 * - Message content hints (emotional keywords)
 * 
 * The goal: Sophia isn't "loading" - she's PRESENT and ENGAGED.
 */

import type { PresetType, ContextMode } from './session-types';

// =============================================================================
// TYPES
// =============================================================================

export interface ThinkingState {
  /** Primary message shown */
  message: string;
  /** Optional emoji/icon */
  emoji?: string;
  /** Visual style hint */
  style?: 'calm' | 'focused' | 'warm' | 'energizing';
  /** Animation variant */
  animation?: 'breathe' | 'pulse' | 'gentle' | 'still';
}

type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'lateNight';

// =============================================================================
// THINKING MESSAGE POOLS - Curated for emotional resonance
// =============================================================================

/**
 * Base thinking messages by preset type
 * These are contextual to what the user is doing
 */
const PRESET_THINKING: Record<PresetType, ThinkingState[]> = {
  prepare: [
    { message: "Tuning into your intention...", style: 'focused', animation: 'breathe' },
    { message: "Getting clear with you...", style: 'calm', animation: 'gentle' },
    { message: "Focusing on what matters...", style: 'focused', animation: 'breathe' },
    { message: "Aligning with your goal...", style: 'energizing', animation: 'pulse' },
    { message: "Sharpening the focus...", style: 'focused', animation: 'gentle' },
  ],
  debrief: [
    { message: "Processing with you...", style: 'warm', animation: 'breathe' },
    { message: "Sitting with what happened...", style: 'calm', animation: 'still' },
    { message: "Reflecting on this...", style: 'calm', animation: 'gentle' },
    { message: "Taking it in...", style: 'warm', animation: 'breathe' },
    { message: "Holding space for this...", style: 'warm', animation: 'still' },
  ],
  reset: [
    { message: "Breathing with you...", emoji: "🌬️", style: 'calm', animation: 'breathe' },
    { message: "Finding stillness...", style: 'calm', animation: 'still' },
    { message: "Centering...", style: 'calm', animation: 'breathe' },
    { message: "Grounding together...", style: 'calm', animation: 'still' },
    { message: "Creating space...", style: 'calm', animation: 'gentle' },
  ],
  vent: [
    { message: "I'm here...", style: 'warm', animation: 'still' },
    { message: "Listening...", style: 'warm', animation: 'gentle' },
    { message: "Taking that in...", style: 'warm', animation: 'breathe' },
    { message: "Hearing you...", style: 'warm', animation: 'still' },
    { message: "With you on this...", style: 'warm', animation: 'gentle' },
  ],
  open: [
    { message: "Thinking...", style: 'calm', animation: 'gentle' },
    { message: "Considering this...", style: 'calm', animation: 'breathe' },
    { message: "Let me think...", style: 'focused', animation: 'gentle' },
    { message: "Processing...", style: 'calm', animation: 'breathe' },
    { message: "Hmm...", style: 'calm', animation: 'still' },
  ],
  chat: [
    { message: "Thinking...", style: 'calm', animation: 'gentle' },
    { message: "Considering this...", style: 'calm', animation: 'breathe' },
    { message: "Let me think...", style: 'focused', animation: 'gentle' },
    { message: "Processing...", style: 'calm', animation: 'breathe' },
    { message: "Hmm...", style: 'calm', animation: 'still' },
  ],
};

/**
 * Context-specific modifiers (gaming, work, life)
 * These add flavor based on the user's world
 */
const CONTEXT_THINKING: Record<ContextMode, ThinkingState[]> = {
  gaming: [
    { message: "Loading mental clarity...", style: 'energizing', animation: 'pulse' },
    { message: "Buffering focus...", style: 'focused', animation: 'gentle' },
    { message: "Queueing thoughts...", style: 'focused', animation: 'pulse' },
    { message: "Respawning clarity...", style: 'energizing', animation: 'gentle' },
  ],
  work: [
    { message: "Organizing my thoughts...", style: 'focused', animation: 'gentle' },
    { message: "Structuring this...", style: 'focused', animation: 'breathe' },
    { message: "Processing the priority...", style: 'calm', animation: 'gentle' },
    { message: "Sorting through this...", style: 'calm', animation: 'breathe' },
  ],
  life: [
    { message: "Being present with you...", style: 'warm', animation: 'still' },
    { message: "Holding this moment...", style: 'warm', animation: 'breathe' },
    { message: "Feeling into this...", style: 'warm', animation: 'gentle' },
    { message: "Here with you...", style: 'warm', animation: 'still' },
  ],
};

/**
 * Time-of-day variants
 * Sophia is aware of when you're talking
 */
const TIME_THINKING: Record<TimeOfDay, ThinkingState[]> = {
  morning: [
    { message: "Morning thoughts gathering...", style: 'energizing', animation: 'gentle' },
    { message: "Waking up my thoughts...", style: 'warm', animation: 'breathe' },
  ],
  afternoon: [
    { message: "Considering this...", style: 'calm', animation: 'gentle' },
  ],
  evening: [
    { message: "Settling into this thought...", style: 'calm', animation: 'breathe' },
    { message: "Winding down to clarity...", style: 'calm', animation: 'still' },
  ],
  lateNight: [
    { message: "Quiet thinking...", style: 'calm', animation: 'still' },
    { message: "In this moment with you...", style: 'warm', animation: 'breathe' },
    { message: "Late night clarity...", style: 'calm', animation: 'still' },
  ],
};

/**
 * Depth-based thinking (conversation gets deeper)
 * After more turns, Sophia shows she's really engaged
 */
const DEPTH_THINKING: ThinkingState[] = [
  { message: "Going deeper...", style: 'focused', animation: 'breathe' },
  { message: "This is important...", style: 'warm', animation: 'still' },
  { message: "Really sitting with this...", style: 'warm', animation: 'breathe' },
  { message: "Feeling the weight of this...", style: 'warm', animation: 'still' },
  { message: "Connecting the dots...", style: 'focused', animation: 'gentle' },
];

/**
 * Emotion-triggered thinking (when user message has emotional content)
 * Keywords that trigger warmer responses
 */
const EMOTIONAL_KEYWORDS = [
  'frustrated', 'angry', 'sad', 'anxious', 'stressed', 'worried',
  'scared', 'overwhelmed', 'lost', 'confused', 'hurt', 'tired',
  'exhausted', 'hopeless', 'alone', 'failed', 'terrible', 'worst',
];

const EMOTIONAL_THINKING: ThinkingState[] = [
  { message: "I hear you...", style: 'warm', animation: 'still' },
  { message: "That's real...", style: 'warm', animation: 'breathe' },
  { message: "Feeling this with you...", style: 'warm', animation: 'still' },
  { message: "I'm right here...", style: 'warm', animation: 'breathe' },
  { message: "Taking this seriously...", style: 'warm', animation: 'still' },
];

// =============================================================================
// HELPER: Get time of day
// =============================================================================

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'lateNight';
}

// =============================================================================
// HELPER: Detect emotional content
// =============================================================================

function hasEmotionalContent(message: string): boolean {
  const lower = message.toLowerCase();
  return EMOTIONAL_KEYWORDS.some(keyword => lower.includes(keyword));
}

// =============================================================================
// MAIN FUNCTION: Get contextual thinking state
// =============================================================================

interface GetThinkingOptions {
  presetType?: PresetType;
  contextMode?: ContextMode;
  turnCount?: number;
  lastUserMessage?: string;
}

/**
 * Get a thinking state that's contextual and feels alive
 * 
 * Priority logic:
 * 1. If user's last message had emotional content → warm response
 * 2. If conversation is deep (7+ turns) → depth-aware response
 * 3. Random chance (20%) for time-of-day awareness
 * 4. Random chance (30%) for context-specific
 * 5. Default to preset-specific
 */
export function getThinkingState(options: GetThinkingOptions = {}): ThinkingState {
  const { 
    presetType = 'open', 
    contextMode = 'life',
    turnCount = 0,
    lastUserMessage = '',
  } = options;
  
  // Priority 1: Emotional content in last message
  if (lastUserMessage && hasEmotionalContent(lastUserMessage)) {
    return pickRandom(EMOTIONAL_THINKING);
  }
  
  // Priority 2: Deep conversation (7+ turns)
  if (turnCount >= 7 && Math.random() < 0.4) {
    return pickRandom(DEPTH_THINKING);
  }
  
  // Priority 3: Time of day (20% chance)
  if (Math.random() < 0.2) {
    const timeStates = TIME_THINKING[getTimeOfDay()];
    if (timeStates.length > 0) {
      return pickRandom(timeStates);
    }
  }
  
  // Priority 4: Context-specific (30% chance)
  if (Math.random() < 0.3) {
    return pickRandom(CONTEXT_THINKING[contextMode]);
  }
  
  // Default: Preset-specific
  return pickRandom(PRESET_THINKING[presetType]);
}

/**
 * Simple version for backward compatibility
 */
export function getThinkingMessage(
  presetType?: PresetType,
  contextMode?: ContextMode,
  turnCount?: number,
  lastUserMessage?: string
): string {
  const state = getThinkingState({ presetType, contextMode, turnCount, lastUserMessage });
  return state.emoji ? `${state.emoji} ${state.message}` : state.message;
}

// =============================================================================
// HELPER: Random picker with seed option
// =============================================================================

function pickRandom<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// =============================================================================
// SEQUENCE THINKING: For longer waits, cycle through messages
// =============================================================================

/**
 * Returns a sequence of thinking states for longer waits
 * Useful if response takes > 3 seconds - shows Sophia is still engaged
 */
export function getThinkingSequence(
  options: GetThinkingOptions,
  count: number = 3
): ThinkingState[] {
  const sequence: ThinkingState[] = [];
  const usedMessages = new Set<string>();
  
  for (let i = 0; i < count; i++) {
    let state = getThinkingState(options);
    let attempts = 0;
    
    // Avoid repeats
    while (usedMessages.has(state.message) && attempts < 10) {
      state = getThinkingState(options);
      attempts++;
    }
    
    usedMessages.add(state.message);
    sequence.push(state);
  }
  
  return sequence;
}
