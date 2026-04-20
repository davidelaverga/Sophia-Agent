'use client';

import type { ContextMode, PresetType } from '../../types/session';

import { MicCTA } from './MicCTA';
import { RitualNode } from './RitualNode';
import { RITUALS, type MicState } from './types';

type OrbitPosition = {
  left?: string;
  right?: string;
  top?: string;
  bottom?: string;
};

/** The centering translate each cardinal node needs at rest */
type RitualPosition = {
  css: OrbitPosition;
  /** e.g. 'translateX(-50%)' or 'translateY(-50%)' — the centering offset */
  baseTransform: string;
};

// Prototype-exact cardinal positions
const POSITIONS: Record<'prepare' | 'debrief' | 'reset' | 'vent', RitualPosition> = {
  prepare: {
    css: { top: '-8px', left: '50%' },
    baseTransform: 'translateX(-50%)',
  },
  debrief: {
    css: { top: '50%', right: '-24px' },
    baseTransform: 'translateY(-50%)',
  },
  reset: {
    css: { bottom: '-8px', left: '50%' },
    baseTransform: 'translateX(-50%)',
  },
  vent: {
    css: { top: '50%', left: '-24px' },
    baseTransform: 'translateY(-50%)',
  },
};

interface RitualOrbitProps {
  context: ContextMode;
  selectedRitual: PresetType | null;
  suggestedRitual?: PresetType | null;
  micState: MicState;
  isOffline?: boolean;
  isConnecting?: boolean;
  isStartingSession?: boolean;
  onSelectRitual: (ritual: PresetType) => void;
  onCallSophia: () => void;
  onContinueSession: () => void;
  /** Staggered reveal of ritual nodes (entrance + context switch) */
  revealed?: boolean;
  /** Instant collapse of ritual nodes (context switch out) */
  switching?: boolean;
  /** Short glow pulse after context switch to signal that rituals changed */
  contextPulse?: boolean;
}

export function RitualOrbit({
  context,
  selectedRitual,
  suggestedRitual,
  micState,
  isOffline,
  isConnecting,
  isStartingSession,
  onSelectRitual,
  onCallSophia,
  onContinueSession,
  revealed = true,
  switching = false,
  contextPulse = false,
}: RitualOrbitProps) {
  // Stagger delays matching prototype: 0.6s, 0.75s, 0.9s, 1.05s
  const STAGGER_DELAYS = [0.6, 0.75, 0.9, 1.05];

  return (
    <div className="relative mx-auto aspect-square w-[clamp(320px,50vmin,440px)]">
      {/* Orbit trace rings */}
      <div className="absolute inset-1/2 h-[10rem] w-[10rem] -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ borderColor: 'var(--cosmic-border)' }} />
      <div className="absolute inset-1/2 h-[15rem] w-[15rem] -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ borderColor: 'var(--cosmic-border-soft)' }} />
      <div className="absolute inset-1/2 h-[18.5rem] w-[18.5rem] -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ borderColor: 'color-mix(in srgb, var(--sophia-purple) 6%, transparent)' }} />

      {/* Thread is rendered by RitualThread canvas overlay (EnhancedFieldDashboard) */}

      {RITUALS.map((ritual, index) => {
        const position = POSITIONS[ritual.type as keyof typeof POSITIONS];
        if (!position) return null;

        return (
          <RitualNode
            key={ritual.type}
            ritual={ritual}
            context={context}
            isSelected={selectedRitual === ritual.type}
            isSuggested={suggestedRitual === ritual.type}
            isPreparing={Boolean(isStartingSession)}
            onSelect={() => onSelectRitual(ritual.type)}
            positionCSS={position.css}
            baseTransform={position.baseTransform}
            revealed={revealed}
            switching={switching}
            contextPulse={contextPulse}
            staggerDelay={STAGGER_DELAYS[index] ?? 0.6}
          />
        );
      })}

      <div className="absolute inset-0 flex items-center justify-center">
        <MicCTA
          selectedRitual={selectedRitual}
          context={context}
          micState={micState}
          isOffline={isOffline}
          isConnecting={isConnecting}
          isStartingSession={isStartingSession}
          onCall={onCallSophia}
          onContinue={onContinueSession}
        />
      </div>
    </div>
  );
}