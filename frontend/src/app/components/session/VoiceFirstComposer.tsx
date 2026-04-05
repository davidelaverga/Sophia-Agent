/**
 * VoiceFirstComposer Component
 * Sprint 1 - Week 2
 * 
 * Voice-first input with mic as primary action.
 * Text input available as secondary option.
 * Extracted from session/page.tsx for better maintainability.
 */

'use client';

import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { Mic, Send, X, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { useLongPress } from '../../hooks/useLongPress';

// ============================================================================
// TYPES
// ============================================================================

export type VoiceStatus = 'ready' | 'listening' | 'thinking' | 'speaking';

interface VoiceFirstComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onMicClick: () => void;
  placeholder: string;
  disabled?: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  justSent?: boolean;
  voiceStatus?: VoiceStatus;
  isTyping?: boolean; // Sophia is responding
  /** Custom status text - overrides default */
  statusText?: string;
  /** Backend connectivity status */
  isOffline?: boolean;
  isConnecting?: boolean;
  /** External request to open and focus the text composer */
  focusRequestToken?: number;
  containerOnboardingId?: string;
  micOnboardingId?: string;
  /** Text-only mode: hides mic, auto-expands text area, auto-focuses input */
  textOnly?: boolean;
}

const VOICE_STATUS_LABELS: Record<VoiceStatus, string> = {
  ready: 'Tap to speak',
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
};

// ============================================================================
// COMPONENT
// ============================================================================

export function VoiceFirstComposer({
  value,
  onChange,
  onSubmit,
  onMicClick,
  placeholder,
  disabled,
  inputRef,
  justSent = false,
  voiceStatus = 'ready',
  isTyping = false,
  statusText,
  isOffline = false,
  isConnecting = false,
  focusRequestToken,
  containerOnboardingId,
  micOnboardingId,
  textOnly = false,
}: VoiceFirstComposerProps) {
  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const [isPTT, setIsPTT] = useState(false);
  const touchStartYRef = useRef<number | null>(null);

  // Long-press-to-talk on the mic button
  const { longPressHandlers } = useLongPress({
    threshold: 300,
    onLongPressStart: () => {
      if (disabled || voiceStatus === 'thinking') return
      setIsPTT(true)
      haptic('medium')
      onMicClick() // start recording
    },
    onLongPressEnd: () => {
      if (!isPTT) return
      setIsPTT(false)
      haptic('light')
      onMicClick() // stop recording
    },
    onShortPress: () => {
      handleMicClickInternal()
    },
  })

  // In textOnly mode, the text area is always expanded
  const effectiveTextExpanded = textOnly || isTextExpanded;

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const startY = touchStartYRef.current;
    touchStartYRef.current = null;
    if (startY == null) return;
    const endY = e.changedTouches[0]?.clientY;
    if (typeof endY !== 'number') return;
    const delta = endY - startY;
    if (delta > 60) {
      setIsTextExpanded(false);
      haptic('light');
    }
  };
  
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.repeat || e.nativeEvent.isComposing) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSubmit();
        if (!textOnly) setIsTextExpanded(false);
      }
    }
    // Escape to collapse (not in text-only mode)
    if (e.key === 'Escape' && !textOnly) {
      setIsTextExpanded(false);
      inputRef.current?.blur();
    }
  };
  
  const handleMicClickInternal = () => {
    if (disabled) return;
    onMicClick();
  };
  
  const handleTextToggle = () => {
    if (disabled) return;
    haptic('light');
    setIsTextExpanded(!isTextExpanded);
    if (!isTextExpanded) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };
  
  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current && effectiveTextExpanded) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 100)}px`;
    }
  }, [value, inputRef, effectiveTextExpanded]);

  useEffect(() => {
    if (focusRequestToken === undefined || disabled) return;
    setIsTextExpanded(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [focusRequestToken, disabled, inputRef]);

  // Text-only mode: force expand and auto-focus on mount
  useEffect(() => {
    if (!textOnly) return;
    setIsTextExpanded(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [textOnly, inputRef]);

  // Determine mic visual state
  const isActive = voiceStatus === 'listening';
  const isBusy = voiceStatus === 'thinking' || voiceStatus === 'speaking' || isTyping;
  
  // Determine dot color (connectivity > active state > busy state > ready)
  const getDotColors = () => {
    if (isOffline) return { outer: 'bg-red-400', inner: 'bg-red-500', animate: '' };
    if (isConnecting) return { outer: 'bg-amber-400', inner: 'bg-amber-500', animate: 'animate-pulse' };
    if (isActive) return { outer: 'bg-white/20 animate-ping', inner: 'bg-white/30', animate: '' };
    if (isBusy) return { outer: 'bg-amber-400', inner: 'bg-amber-400', animate: '' };
    return { outer: 'bg-green-400 animate-pulse', inner: 'bg-green-500', animate: '' };
  };
  const dotColors = getDotColors();
  
  return (
    <div data-onboarding={containerOnboardingId} className={cn(
      textOnly
        ? 'p-4 sm:pb-4 pb-2'
        : 'fixed bottom-8 left-1/2 -translate-x-1/2 z-30'
    )}>
      <div className={cn(textOnly && 'max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto')}>
        
        {/* Sophia Presence Indicator — text mode only, atmospheric */}
        {textOnly && (
        <div className="flex justify-center mb-3">
          <div role="status" aria-live="polite" className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.14em] lowercase text-white/20 transition-all duration-500">
              {isTyping ? 'sophia is typing…' : ''}
            </span>
          </div>
        </div>
        )}
        
        {/* Main Controls */}
        <div className="flex flex-col items-center gap-3">
          
          {/* Mic Hero Button — hidden in text-only mode */}
          {!textOnly && (
          <div className="relative">
            {/* Outer glow ring — distinct per state */}
            <div className={cn(
              'absolute inset-[-12px] rounded-full transition-all duration-500',
              isActive && 'bg-white/[0.06] shadow-[0_0_30px_rgba(255,255,255,0.08)]',
              isBusy && 'bg-amber-500/[0.04]',
              !isActive && !isBusy && 'bg-transparent'
            )} />
            
            {/* Waveform visualization for listening — taller, more visible */}
            {isActive && (
              <div className="absolute inset-[-24px] flex items-center justify-center">
                {[...Array(10)].map((_, i) => (
                  <span
                    key={i}
                    className="w-[3px] mx-[2px] bg-white/25 rounded-full"
                    style={{
                      height: `${14 + Math.sin(i * 0.7) * 10}px`,
                      animation: `waveform 500ms ease-in-out ${i * 60}ms infinite alternate`,
                    }}
                  />
                ))}
              </div>
            )}
            
            {/* Shimmer effect for thinking/speaking */}
            {isBusy && (
              <div className="absolute inset-[-4px] rounded-full overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-amber-400/15 to-transparent animate-shimmer" 
                  style={{ 
                    backgroundSize: '200% 100%',
                    animation: 'shimmer 1.5s infinite linear'
                  }} 
                />
              </div>
            )}
            
            <button
              type="button"
              data-onboarding={micOnboardingId}
              {...longPressHandlers}
              disabled={disabled || voiceStatus === 'thinking'}
              aria-label={isPTT ? 'Recording... release to send' : VOICE_STATUS_LABELS[voiceStatus]}
              aria-pressed={isActive || isPTT}
              className={cn(
                'relative flex items-center justify-center rounded-full transition-all duration-300',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#030308]',
                // Size — grows when listening
                isActive ? 'w-[72px] h-[72px]' : 'w-16 h-16',
                // States — clearly differentiated
                isActive && 'bg-white/[0.12] text-white shadow-[0_0_24px_rgba(255,255,255,0.06)] border border-white/[0.15]',
                isBusy && 'bg-amber-500/[0.06] text-amber-300/40 border border-amber-400/[0.08] cursor-not-allowed',
                !isActive && !isBusy && 'bg-white/[0.04] text-white/40 border border-white/[0.06] hover:bg-white/[0.06] hover:scale-105 active:scale-95',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
            >
              {/* Active listening inner pulse — larger, slower */}
              {(isActive || isPTT) && (
                <span className="absolute inset-[-6px] rounded-full bg-white/[0.05] animate-ping" style={{ animationDuration: '2s' }} />
              )}
              
              <Mic className={cn(
                'relative z-10 transition-all duration-300',
                (isActive || isPTT) && 'w-8 h-8 text-white',
                isBusy && 'w-7 h-7 animate-pulse text-amber-300/40',
                !isActive && !isBusy && 'w-7 h-7 text-white/40',
              )} />
            </button>
            {isPTT && (
              <p aria-live="assertive" className="mt-2 text-center text-xs font-medium text-white/30 animate-pulse">
                Recording… release to send
              </p>
            )}
          </div>
          )}
          
          {/* Text Input Toggle & Collapsible Area — text mode only in voice, always in text-only */}
          {textOnly && (
          <div className="w-full">
            {!effectiveTextExpanded ? (
              // Collapsed state - just a hint button
              <button
                type="button"
                onClick={handleTextToggle}
                disabled={disabled}
                aria-label="Switch to text input"
                className={cn(
                  'w-full py-2 text-center text-sm transition-colors',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20 rounded',
                  disabled
                    ? 'text-white/20 cursor-not-allowed'
                    : 'text-white/30 hover:text-white/40'
                )}
              >
                or type instead...
              </button>
            ) : (
              // Expanded text input
              <div className="animate-fadeIn space-y-2" onTouchStart={textOnly ? undefined : handleTouchStart} onTouchEnd={textOnly ? undefined : handleTouchEnd}>
                <div className="flex gap-2">
                  {/* Close button — hidden in text-only mode */}
                  {!textOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light');
                      setIsTextExpanded(false);
                    }}
                    aria-label="Close typing"
                    className={cn(
                      'p-2.5 rounded-2xl transition-all duration-200 shrink-0',
                      'bg-transparent hover:bg-white/[0.04]',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20'
                    )}
                  >
                    <X className="w-4 h-4 text-white/25" />
                  </button>
                  )}
                  <textarea
                    ref={inputRef}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    aria-label="Message input"
                    rows={1}
                    disabled={disabled}
                    style={{ backgroundColor: 'var(--input-bg)' }}
                    className={cn(
                      'flex-1 px-4 py-2.5 rounded-2xl border transition-all duration-200 resize-none',
                      'text-sm text-white/60 placeholder-white/15',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/10',
                      'min-h-[40px] max-h-[100px]',
                      'border-white/[0.04] bg-white/[0.02]',
                      disabled && 'opacity-50 cursor-not-allowed'
                    )}
                  />
                  
                  {/* Send button - only visible when there's text */}
                  <button
                    type="button"
                    onClick={() => {
                      onSubmit();
                      if (!textOnly) setIsTextExpanded(false);
                    }}
                    disabled={!value.trim() || disabled}
                    aria-label="Send message"
                    className={cn(
                      'p-2.5 rounded-2xl transition-all duration-200 shrink-0',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20',
                      value.trim() && !disabled
                        ? 'bg-white/[0.05] text-white/50 hover:bg-white/[0.08] active:scale-95'
                        : 'bg-transparent text-white/15 cursor-not-allowed'
                    )}
                  >
                    {justSent ? (
                      <Check className="w-4 h-4 animate-scaleIn" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </button>
                </div>
                
                {/* Collapse hint — hidden in text-only mode */}
                {!textOnly && (
                <p className="text-center text-[10px] text-white/20">
                  Swipe down or tap X to close · Enter to send
                </p>
                )}
              </div>
            )}
          </div>
          )}
        </div>
        
      </div>
    </div>
  );
}
