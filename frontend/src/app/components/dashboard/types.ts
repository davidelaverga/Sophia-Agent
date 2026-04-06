/**
 * Dashboard Component Types & Configs
 * Extracted from VoiceFirstDashboard for reusability
 */

import { 
  Target, 
  MessageCircle, 
  RefreshCw, 
  Wind,
  Gamepad2,
  Briefcase,
  Heart,
} from 'lucide-react';

import type { PresetType, ContextMode } from '../../types/session';

// ============================================================================
// TYPES
// ============================================================================

export type MicState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface RitualConfig {
  type: PresetType;
  icon: typeof Target;
  labels: Record<ContextMode, { title: string; description: string }>;
  floatDelay: string;
}

export interface ContextConfig {
  value: ContextMode;
  label: string;
  icon: typeof Gamepad2;
  title: string;
  subtitle: string;
  greetings: {
    morning: string;
    afternoon: string;
    evening: string;
  };
  ritualPrompts: Record<Extract<PresetType, 'prepare' | 'debrief' | 'reset' | 'vent'>, string>;
}

// ============================================================================
// RITUAL CONFIGS
// ============================================================================

export const RITUALS: RitualConfig[] = [
  {
    type: 'prepare',
    icon: Target,
    floatDelay: '0s',
    labels: {
      gaming: { title: 'Pre-game', description: 'to get your head right before you play' },
      work: { title: 'Pre-work', description: 'to set your intention before the day starts' },
      life: { title: 'Prepare', description: 'to get clear on what matters today' },
    },
  },
  {
    type: 'debrief',
    icon: MessageCircle,
    floatDelay: '0.12s',
    labels: {
      gaming: { title: 'Post-game', description: 'to process what just happened in-game' },
      work: { title: 'Post-work', description: 'to process your important work events' },
      life: { title: 'Debrief', description: 'to talk through what just happened' },
    },
  },
  {
    type: 'reset',
    icon: RefreshCw,
    floatDelay: '0.25s',
    labels: {
      gaming: { title: 'Reset', description: 'to clear your mind between sessions' },
      work: { title: 'Stress Reset', description: 'to calm the overwhelm and refocus' },
      life: { title: 'Grounding', description: 'to come back to yourself for a moment' },
    },
  },
  {
    type: 'vent',
    icon: Wind,
    floatDelay: '0.38s',
    labels: {
      gaming: { title: 'Vent', description: 'to let the frustration out, no filter' },
      work: { title: 'Unload', description: 'to release the pressure without judgment' },
      life: { title: 'Let it out', description: 'to say what you need to say, unfiltered' },
    },
  },
];

// ============================================================================
// CONTEXT CONFIGS
// ============================================================================

export const CONTEXTS: ContextConfig[] = [
  { 
    value: 'gaming', 
    label: 'Gaming', 
    icon: Gamepad2,
    title: "Let's lock in.",
    subtitle: "Pick a ritual or just talk — no pressure.",
    greetings: {
      morning: 'Morning grind?',
      afternoon: "Let's lock in.",
      evening: 'Late session?',
    },
    ritualPrompts: {
      prepare: 'Set your intention before you queue.',
      debrief: 'Cool down and learn from the session.',
      reset: 'Reset your tilt in under a minute.',
      vent: 'Let it out, then get steady.',
    },
  },
  { 
    value: 'work', 
    label: 'Work', 
    icon: Briefcase,
    title: "Let's get clear.",
    subtitle: 'Set your focus or just talk.',
    greetings: {
      morning: 'Good morning.',
      afternoon: "Let's get clear.",
      evening: 'Still at it?',
    },
    ritualPrompts: {
      prepare: 'Set the tone before the work begins.',
      debrief: 'Process the important work moments.',
      reset: 'Clear the overload and refocus.',
      vent: 'Unload the pressure without spinning.',
    },
  },
  { 
    value: 'life', 
    label: 'Life', 
    icon: Heart,
    title: "I'm here.",
    subtitle: 'Talk to me — whatever it is.',
    greetings: {
      morning: 'Good morning.',
      afternoon: "I'm here.",
      evening: 'How was today?',
    },
    ritualPrompts: {
      prepare: 'Get clear on what matters today.',
      debrief: 'Talk through what just happened.',
      reset: 'Come back to yourself for a moment.',
      vent: 'Say it how it feels, unfiltered.',
    },
  },
];

// ============================================================================
// PRESENCE STATES
// ============================================================================

export const PRESENCE_STATES: Record<MicState | 'offline' | 'connecting' | 'starting', { label: string; dotClass: string }> = {
  idle: { label: 'Ready', dotClass: 'bg-emerald-400' },
  listening: { label: 'Listening...', dotClass: 'bg-sophia-purple animate-pulse' },
  thinking: { label: 'Thinking...', dotClass: 'bg-amber-400 animate-pulse' },
  speaking: { label: 'Speaking', dotClass: 'bg-sophia-purple' },
  offline: { label: 'Offline', dotClass: 'bg-red-400' },
  connecting: { label: 'Connecting...', dotClass: 'bg-amber-400 animate-pulse' },
  starting: { label: 'Waking Sophia...', dotClass: 'bg-sophia-purple animate-pulse' },
};
