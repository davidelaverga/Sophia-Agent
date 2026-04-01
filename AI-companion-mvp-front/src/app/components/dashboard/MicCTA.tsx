/**
 * MicCTA Component
 * The breathing mic organism - Sophia's voice interface
 */

'use client';

import { Mic } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { PresenceIndicator } from './PresenceIndicator';
import { RITUALS, EMBRACE_DIRECTIONS, type MicState, type ContextConfig } from './types';
import type { PresetType, ContextMode } from '../../types/session';

const WORK_EMBRACE_ROTATION_OVERRIDES: Partial<Record<PresetType, string>> = {
  prepare: '-128deg',
  debrief: '-52deg',
  reset: '-142deg',
  vent: '-38deg',
};

interface MicCTAProps {
  selectedRitual: PresetType | null;
  context: ContextMode;
  contextConfig: ContextConfig;
  micState: MicState;
  isOffline?: boolean;
  isConnecting?: boolean;
  isStartingSession?: boolean;
  onCall: () => void;
  onContinue: () => void;
}

export function MicCTA({ 
  selectedRitual, 
  context, 
  contextConfig, 
  micState, 
  isOffline, 
  isConnecting,
  isStartingSession = false,
  onCall, 
  onContinue: _onContinue 
}: MicCTAProps) {
  const ritualLabel = selectedRitual 
    ? RITUALS.find(r => r.type === selectedRitual)?.labels[context].title 
    : null;
  
  const isActive = micState !== 'idle' || isStartingSession;
  const embraceDir = selectedRitual ? EMBRACE_DIRECTIONS[selectedRitual] : null;
  const embraceRotation = selectedRitual
    ? (context === 'work'
      ? WORK_EMBRACE_ROTATION_OVERRIDES[selectedRitual] ?? EMBRACE_DIRECTIONS[selectedRitual].rotation
      : EMBRACE_DIRECTIONS[selectedRitual].rotation)
    : null;
  
  return (
    <div className="flex flex-col items-center">
      {/* PresenceIndicator - z-20 to stay above cards */}
      <div className="relative z-20">
        <PresenceIndicator 
          state={micState} 
          modeLabel={ritualLabel} 
          isOffline={isOffline} 
          isConnecting={isConnecting}
          isStartingSession={isStartingSession}
        />
      </div>
      
      {/* Mic Button with breathing aura */}
      <div className="relative">
        {/* Embrace beam toward selected card */}
        {embraceDir && (
          <div 
            className="absolute inset-0 pointer-events-none"
            style={{ transform: `rotate(${embraceRotation})` }}
          >
            <div 
              className="absolute animate-embrace-extend"
              style={{
                left: '100%',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '80px',
                height: '40px',
                background: 'radial-gradient(ellipse 100% 80% at 0% 50%, rgba(139,92,246,0.1) 0%, rgba(139,92,246,0.05) 50%, transparent 90%)',
                filter: 'blur(6px)',
                transformOrigin: 'left center',
              }}
            />
            <div 
              className="absolute animate-embrace-extend-delayed"
              style={{
                left: '100%',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '100px',
                height: '55px',
                background: 'radial-gradient(ellipse 100% 70% at 0% 50%, rgba(139,92,246,0.06) 0%, rgba(139,92,246,0.02) 60%, transparent 95%)',
                filter: 'blur(10px)',
                transformOrigin: 'left center',
              }}
            />
          </div>
        )}
        
        {/* Outer breathing aura - no z-index, paints below z-10 cards */}
        <div 
          className={cn(
            'absolute rounded-full pointer-events-none',
            'animate-breathe',
            '-inset-5',
            selectedRitual && 'animate-resonance'
          )}
          style={{ 
            animationDuration: contextConfig.breatheSpeed,
            background: `radial-gradient(circle at center, transparent 45%, rgba(139,92,246,0.10) 60%, rgba(139,92,246,0.05) 80%, transparent 100%)`,
            filter: 'blur(6px)',
          }}
        />
        
        {/* Ripple rings - no z-index, paints below z-10 cards */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Ready-state subtle pulse ring */}
          {micState === 'idle' && !isStartingSession && (
            <span
              className="absolute -inset-1 rounded-full border border-white/20 animate-pulse-gentle"
              style={{ animationDuration: '4s' }}
            />
          )}
          
          {/* Waveform ripples when listening */}
          {micState === 'listening' && (
            <>
              <span className="absolute -inset-3 rounded-full border border-white/30 animate-ping" style={{ animationDuration: '1.8s' }} />
              <span className="absolute -inset-6 rounded-full border border-white/20 animate-ping" style={{ animationDuration: '2.4s' }} />
              <span className="absolute -inset-10 rounded-full border border-white/10 animate-ping" style={{ animationDuration: '3s' }} />
            </>
          )}
          
          {/* Sophia awakening ripples */}
          {isStartingSession && micState === 'idle' && (
            <>
              <span className="absolute -inset-3 rounded-full border border-sophia-purple/30 animate-ping" style={{ animationDuration: '2s' }} />
              <span className="absolute -inset-7 rounded-full border border-sophia-purple/20 animate-ping" style={{ animationDuration: '2.6s' }} />
            </>
          )}
          
          {/* Resonance ripple when ritual selected */}
          {selectedRitual && micState === 'idle' && !isStartingSession && (
            <span className="absolute -inset-4 rounded-full border border-sophia-purple/15 animate-ping" style={{ animationDuration: '3.5s' }} />
          )}
        </div>
        
        {/* Button - z-20 to stay above cards */}
        <button
          data-onboarding="mic-cta"
          onClick={() => {
            if (isStartingSession) return;
            haptic('medium');
            onCall();
          }}
          disabled={isStartingSession}
          aria-label={
            isStartingSession ? 'Connecting to Sophia' :
            micState === 'listening' ? 'Stop listening' :
            micState === 'thinking' ? 'Sophia is processing' :
            micState === 'speaking' ? 'Interrupt Sophia' :
            selectedRitual ? 'Start session with Sophia' :
            'Talk to Sophia'
          }
          className={cn(
            'relative z-20 w-32 h-32 rounded-full transition-all duration-300',
            'bg-gradient-to-br from-sophia-purple to-sophia-purple/80',
            'hover:scale-105 active:scale-95',
            'focus:outline-none focus-visible:ring-4 focus-visible:ring-sophia-purple/50',
            'shadow-[0_0_25px_rgba(139,92,246,0.24)]',
            selectedRitual && 'shadow-[0_0_32px_rgba(139,92,246,0.32)]',
            isStartingSession && 'cursor-wait opacity-90'
          )}
        >
          {/* Shimmer when thinking */}
          {micState === 'thinking' && (
            <span className="absolute inset-0 rounded-full bg-white/20 animate-pulse" style={{ animationDuration: '1.5s' }} />
          )}
          
          {/* Inner glow when starting session */}
          {isStartingSession && micState === 'idle' && (
            <span className="absolute inset-0 rounded-full bg-white/10 animate-pulse" style={{ animationDuration: '0.8s' }} />
          )}
          
          {/* Inner border */}
          <span className="absolute inset-3 rounded-full border-2 border-white/30" />
          
          {/* Mic Icon */}
          <Mic className={cn(
            'absolute inset-0 m-auto w-12 h-12 text-white drop-shadow-lg transition-transform',
            isActive && 'scale-110'
          )} />
        </button>
      </div>
      
      {/* Primary CTA text - z-20 to stay above cards */}
      <p className="relative z-20 mt-5 text-sm font-medium text-sophia-text2" role="status" aria-live="polite">
        {isStartingSession && (
          <span className="text-sophia-purple motion-safe:animate-pulse">Connecting to Sophia...</span>
        )}
        {!isStartingSession && micState === 'listening' && 'Tap to stop'}
        {!isStartingSession && micState === 'thinking' && 'Processing...'}
        {!isStartingSession && micState === 'speaking' && 'Tap to interrupt'}
        {!isStartingSession && micState === 'idle' && selectedRitual && (
          <span className="text-sophia-purple">Tap to start session</span>
        )}
        {!isStartingSession && micState === 'idle' && !selectedRitual && 'Tap to talk'}
      </p>
    </div>
  );
}
