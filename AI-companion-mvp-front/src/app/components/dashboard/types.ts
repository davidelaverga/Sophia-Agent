/**
 * Dashboard Component Types & Configs
 * Extracted from VoiceFirstDashboard for reusability
 */

import type { PresetType, ContextMode } from '../../types/session';
import { 
  Target, 
  MessageCircle, 
  RefreshCw, 
  Wind,
  Gamepad2,
  Briefcase,
  Heart,
} from 'lucide-react';

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
  glowClass: string;
  auraClass: string;
  breatheSpeed: string;
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
      gaming: { title: 'Pre-game', description: 'Lock in before you play.' },
      work: { title: 'Pre-work', description: 'Set your intention.' },
      life: { title: 'Prepare', description: 'Get clear on what matters.' },
    },
  },
  {
    type: 'debrief',
    icon: MessageCircle,
    floatDelay: '0.12s',
    labels: {
      gaming: { title: 'Post-game', description: 'Process and learn.' },
      work: { title: 'Post-work', description: 'Reflect on the day.' },
      life: { title: 'Debrief', description: 'Talk through what happened.' },
    },
  },
  {
    type: 'reset',
    icon: RefreshCw,
    floatDelay: '0.25s',
    labels: {
      gaming: { title: 'Reset', description: 'Quick mental reset.' },
      work: { title: 'Stress Reset', description: 'Calm the overwhelm.' },
      life: { title: 'Grounding', description: 'Come back to center.' },
    },
  },
  {
    type: 'vent',
    icon: Wind,
    floatDelay: '0.38s',
    labels: {
      gaming: { title: 'Vent', description: 'Let it out. Feel lighter.' },
      work: { title: 'Unload', description: 'Release the pressure.' },
      life: { title: 'Let it out', description: 'No filter needed.' },
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
    subtitle: "Reset the tilt.",
    glowClass: 'glow-gaming',
    auraClass: 'aura-gaming',
    breatheSpeed: '6s',
  },
  { 
    value: 'work', 
    label: 'Work', 
    icon: Briefcase,
    title: "Let's get clear.",
    subtitle: "One step at a time.",
    glowClass: 'glow-work',
    auraClass: 'aura-work',
    breatheSpeed: '7s',
  },
  { 
    value: 'life', 
    label: 'Life', 
    icon: Heart,
    title: "I'm here.",
    subtitle: "Talk to me.",
    glowClass: 'glow-life',
    auraClass: 'aura-life',
    breatheSpeed: '8s',
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

// ============================================================================
// EMBRACE DIRECTIONS (for mic beam animation)
// ============================================================================

export const EMBRACE_DIRECTIONS: Record<PresetType, { x: number; y: number; rotation: string }> = {
  'prepare': { x: -1, y: -1, rotation: '-135deg' },
  'debrief': { x: 1, y: -1, rotation: '-45deg' },
  'reset': { x: -1, y: 1, rotation: '135deg' },
  'vent': { x: 1, y: 1, rotation: '45deg' },
  'open': { x: 0, y: 0, rotation: '0deg' },
  'chat': { x: 0, y: 0, rotation: '0deg' },
};
