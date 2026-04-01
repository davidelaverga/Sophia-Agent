/**
 * PresenceIndicator Component
 * Shows Sophia's current state (Ready, Listening, Thinking, Speaking)
 */

'use client';

import { cn } from '../../lib/utils';
import { PRESENCE_STATES, type MicState } from './types';

interface PresenceIndicatorProps {
  state: MicState;
  modeLabel?: string | null;
  isOffline?: boolean;
  isConnecting?: boolean;
  isStartingSession?: boolean;
}

export function PresenceIndicator({ state, modeLabel, isOffline, isConnecting, isStartingSession }: PresenceIndicatorProps) {
  const presence = isOffline 
    ? PRESENCE_STATES.offline 
    : isStartingSession
      ? PRESENCE_STATES.starting
      : isConnecting 
        ? PRESENCE_STATES.connecting 
        : PRESENCE_STATES[state];
  
  return (
    <div className="flex flex-col items-center gap-1 mb-2" role="status" aria-live="polite">
      {/* Status */}
      <div className="flex items-center gap-2">
        <span className={cn(
          'w-2 h-2 rounded-full transition-all duration-300',
          presence.dotClass,
          state === 'idle' && 'animate-pulse-gentle'
        )} />
        <span className="text-xs text-sophia-text2 font-medium tracking-wide">
          {presence.label}
        </span>
      </div>
      {/* Mode label */}
      {modeLabel && state === 'idle' && (
        <span className="text-[11px]">
          <span className="text-sophia-text2/60">Mode:</span>
          <span className="text-sophia-purple font-medium"> {modeLabel}</span>
        </span>
      )}
    </div>
  );
}
