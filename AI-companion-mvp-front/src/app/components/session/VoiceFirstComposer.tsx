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
        ? 'p-4 sm:pb-4 pb-2 border-t border-white/[0.03]'
        : 'fixed bottom-8 left-1/2 -translate-x-1/2 z-30'
    )}>
      <div className={cn(textOnly && 'max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto')}>
        
        {/* Sophia Presence Indicator — text mode only */}
        {textOnly && (
        <div className="flex justify-center mb-4">
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-white/40">
            <span className="relative flex h-2 w-2">
              <span className={cn(
                'absolute inline-flex h-full w-full rounded-full opacity-75',
                isTyping ? 'bg-white/20 animate-ping' : 'bg-green-400 animate-pulse'
              )} />
              <span className={cn(
                'relative inline-flex rounded-full h-2 w-2',
                isTyping ? 'bg-white/30' : 'bg-green-500'
              )} />
            </span>
            <span className="text-xs font-medium transition-all duration-300">
              {isTyping ? 'Sophia is typing...' : 'Sophia — Ready'}
            </span>
          </div>
        </div>
        )}
        
        {/* Main Controls */}
        <div className="flex flex-col items-center gap-3">
          
          {/* Mic Hero Button — hidden in text-only mode */}
          {!textOnly && (
          <div className="relative">
            {/* Outer glow ring - always present but varies */}
            <div className={cn(
              'absolute inset-[-12px] rounded-full transition-all duration-500',
              isActive && 'bg-white/[0.04] animate-pulse',
              isBusy && 'bg-white/[0.03]',
              !isActive && !isBusy && 'bg-transparent'
            )} />
            
            {/* Waveform visualization for listening */}
            {isActive && (
              <div className="absolute inset-[-20px] flex items-center justify-center">
                {[...Array(8)].map((_, i) => (
                  <span
                    key={i}
                    className="w-0.5 mx-0.5 bg-white/15 rounded-full animate-pulse"
                    style={{
                      height: `${12 + Math.sin(i * 0.8) * 8}px`,
                      animationDelay: `${i * 75}ms`,
                      animationDuration: '600ms',
                    }}
                  />
                ))}
              </div>
            )}
            
            {/* Shimmer effect for thinking/speaking */}
            {isBusy && (
              <div className="absolute inset-[-4px] rounded-full overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" 
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
                // Size
                'w-16 h-16',
                // States
                isActive && 'bg-white/[0.08] text-white scale-110 shadow-[0_0_20px_rgba(255,255,255,0.04)]',
                isBusy && 'bg-white/[0.03] text-white/30 opacity-70 cursor-not-allowed',
                !isActive && !isBusy && 'bg-white/[0.04] text-white/40 border border-white/[0.06] hover:bg-white/[0.06] hover:scale-105 active:scale-95',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
            >
              {/* Breathing aura when ready - softer */}
              {!isActive && !isBusy && (
                <span className="absolute inset-[-2px] rounded-full bg-white/[0.04] animate-pulse" />
              )}
              
              {/* Active listening inner glow */}
              {(isActive || isPTT) && (
                <span className="absolute inset-0 rounded-full bg-white/10 animate-ping" style={{ animationDuration: '1.5s' }} />
              )}
              
              <Mic className={cn(
                'w-7 h-7 relative z-10 transition-transform',
                (isActive || isPTT) && 'scale-110',
                isBusy && 'animate-pulse'
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
                      'p-2.5 rounded-xl transition-all duration-200 shrink-0',
                      'border border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.06]',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20'
                    )}
                  >
                    <X className="w-4 h-4 text-white/40" />
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
                      'flex-1 px-4 py-2.5 rounded-xl border transition-all duration-200 resize-none',
                      'text-sm text-white/70 placeholder-white/20',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/15',
                      'min-h-[40px] max-h-[100px]',
                      'border-white/[0.06] bg-white/[0.03]',
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
                      'p-2.5 rounded-xl transition-all duration-200 shrink-0',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20',
                      value.trim() && !disabled
                        ? 'bg-white/[0.08] text-white/70 hover:bg-white/[0.12] active:scale-95'
                        : 'bg-white/[0.03] text-white/20 cursor-not-allowed'
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
