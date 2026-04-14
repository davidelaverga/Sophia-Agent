/**
 * VoiceFirstComposer Component
 * Sprint 1 - Week 2
 * 
 * Voice-first input with mic as primary action.
 * Text input available as secondary option.
 * Extracted from session/page.tsx for better maintainability.
 */

'use client';

import { Mic, Send, X, Check } from 'lucide-react';
import { useState, useEffect, useRef, type KeyboardEvent } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { useLongPress } from '../../hooks/useLongPress';
import { cn } from '../../lib/utils';

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
  /** Slot rendered between mic button and text area — used for ModeToggle in voice mode */
  slotBeforeText?: React.ReactNode;
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
  statusText: _statusText,
  isOffline: _isOffline = false,
  isConnecting: _isConnecting = false,
  focusRequestToken,
  containerOnboardingId,
  micOnboardingId,
  textOnly = false,
  slotBeforeText,
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
  const statusText = _statusText || (isTyping ? 'Sophia is thinking...' : 'Sophia — Ready');

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
  
  return (
    <div data-onboarding={containerOnboardingId} className={cn(
      textOnly
        ? 'p-4 sm:pb-4 pb-2'
        : 'fixed bottom-8 left-1/2 -translate-x-1/2 z-30'
    )}
    style={textOnly ? {
      background: 'color-mix(in srgb, var(--cosmic-panel) 80%, transparent)',
      borderTop: '1px solid var(--cosmic-border-soft)',
      backdropFilter: 'blur(16px) saturate(1.1)',
      WebkitBackdropFilter: 'blur(16px) saturate(1.1)',
    } : undefined}
    >
      <div className={cn(textOnly && 'max-w-3xl lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl mx-auto')}>
        
        {/* Sophia Presence Indicator — text mode only, atmospheric */}
        {textOnly && (
        <div className="flex justify-center mb-3">
          <div role="status" aria-live="polite" className="flex items-center gap-2">
            {isTyping && (
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: 'var(--sophia-purple)', boxShadow: '0 0 6px var(--sophia-glow)' }}
              />
            )}
            <span className="text-[10px] tracking-[0.14em] lowercase transition-all duration-500" style={{ color: 'var(--cosmic-text-muted)' }}>
              {isTyping ? 'sophia is typing…' : ''}
            </span>
          </div>
        </div>
        )}
        
        {/* Main Controls */}
        <div className="flex flex-col items-center gap-3">
          {/* Status text — text mode only */}
          {textOnly && (
          <p
            className="text-center text-[11px] tracking-[0.12em] uppercase transition-all duration-500"
            style={{ color: 'var(--cosmic-text-muted)' }}
          >
            {statusText}
          </p>
          )}
          
          {/* Mic Hero Button — hidden in text-only mode */}
          {!textOnly && (
          <div className="relative">
            {/* Outer glow ring — distinct per state */}
            <div
              className="absolute inset-[-12px] rounded-full transition-all duration-500"
              style={isActive
                ? {
                    background: 'color-mix(in srgb, var(--cosmic-teal) 10%, transparent)',
                    boxShadow: '0 0 30px color-mix(in srgb, var(--cosmic-teal) 16%, transparent)',
                  }
                : isBusy
                  ? { background: 'color-mix(in srgb, var(--cosmic-amber) 10%, transparent)' }
                  : undefined}
            />
            
            {/* Waveform visualization for listening — taller, more visible */}
            {isActive && (
              <div className="absolute inset-[-24px] flex items-center justify-center">
                {[...Array(10)].map((_, i) => (
                  <span
                    key={i}
                    className="mx-[2px] w-[3px] rounded-full"
                    style={{
                      background: 'var(--cosmic-text-whisper)',
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
                'cosmic-focus-ring focus:outline-none',
                // Size — grows when listening
                isActive ? 'w-[72px] h-[72px]' : 'w-16 h-16',
                !isActive && !isBusy && 'hover:scale-105 active:scale-95',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
              style={isActive
                ? {
                    background: 'color-mix(in srgb, var(--cosmic-panel-strong) 80%, var(--cosmic-teal) 20%)',
                    color: 'var(--cosmic-text-strong)',
                    border: '1px solid var(--cosmic-border-strong)',
                    boxShadow: '0 0 24px color-mix(in srgb, var(--cosmic-teal) 12%, transparent)',
                  }
                : isBusy
                  ? {
                      background: 'color-mix(in srgb, var(--cosmic-panel-soft) 85%, var(--cosmic-amber) 15%)',
                      color: 'color-mix(in srgb, var(--cosmic-amber) 70%, var(--cosmic-text))',
                      border: '1px solid color-mix(in srgb, var(--cosmic-amber) 20%, transparent)',
                    }
                  : {
                      background: 'var(--cosmic-panel-soft)',
                      color: 'var(--cosmic-text-muted)',
                      border: '1px solid var(--cosmic-border-soft)',
                    }}
            >
              {/* Active listening inner pulse — larger, slower */}
              {(isActive || isPTT) && (
                <span className="absolute inset-[-6px] rounded-full animate-ping" style={{ animationDuration: '2s', background: 'color-mix(in srgb, var(--cosmic-teal) 12%, transparent)' }} />
              )}
              
              <Mic className={cn(
                'relative z-10 transition-all duration-300',
                (isActive || isPTT) && 'w-8 h-8',
                isBusy && 'w-7 h-7 animate-pulse',
                !isActive && !isBusy && 'w-7 h-7',
              )}
              style={{ color: isActive || isPTT ? 'var(--cosmic-text-strong)' : isBusy ? 'var(--cosmic-amber)' : 'var(--cosmic-text-muted)' }} />
            </button>
            {isPTT && (
              <p aria-live="assertive" className="mt-2 text-center text-xs font-medium animate-pulse" style={{ color: 'var(--cosmic-text-whisper)' }}>
                Recording… release to send
              </p>
            )}
          </div>
          )}
          
          {/* Slot: ModeToggle or other controls between mic and text area */}
          {slotBeforeText}

          {/* Text Input Toggle & Collapsible Area — text mode only */}
          {textOnly && (
          <div className="w-full">
            {!effectiveTextExpanded ? (
              // Collapsed state - just a hint button
              <div className="space-y-2 text-center">
                <button
                  type="button"
                  onClick={handleTextToggle}
                  disabled={disabled}
                  aria-label="Switch to text input"
                  className={cn(
                    'cosmic-focus-ring w-full rounded py-2 text-center text-sm transition-colors',
                    disabled
                      ? 'cursor-not-allowed'
                      : 'hover:opacity-100'
                  )}
                  style={{ color: disabled ? 'var(--cosmic-text-faint)' : 'var(--cosmic-text-whisper)', opacity: disabled ? 1 : 0.88 }}
                >
                  or type instead...
                </button>
              </div>
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
                      'cosmic-whisper-button cosmic-focus-ring shrink-0 rounded-2xl p-2.5 transition-all duration-200'
                    )}
                  >
                    <X className="h-4 w-4" style={{ color: 'var(--cosmic-text-whisper)' }} />
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
                    className={cn(
                      'flex-1 px-4 py-2.5 rounded-2xl border transition-all duration-200 resize-none',
                      'text-sm placeholder:text-[color:var(--cosmic-text-muted)]',
                      'focus-visible:outline-none',
                      'min-h-[40px] max-h-[100px]',
                      disabled && 'opacity-50 cursor-not-allowed'
                    )}
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--input-bg) 90%, var(--sophia-purple) 10%)',
                      color: 'var(--cosmic-text-strong)',
                      borderColor: 'var(--cosmic-border)',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--sophia-purple) 50%, var(--cosmic-border))';
                      e.currentTarget.style.boxShadow = '0 0 0 1px color-mix(in srgb, var(--sophia-purple) 25%, transparent), 0 0 16px color-mix(in srgb, var(--sophia-purple) 10%, transparent)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--cosmic-border)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
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
                      'cosmic-focus-ring shrink-0 rounded-2xl p-2.5 transition-all duration-200',
                      value.trim() && !disabled
                        ? 'cosmic-accent-pill active:scale-95'
                        : 'cursor-not-allowed'
                    )}
                    style={!value.trim() || disabled
                      ? { color: 'var(--cosmic-text-faint)' }
                      : { boxShadow: '0 0 12px color-mix(in srgb, var(--sophia-glow) 20%, transparent)' }
                    }
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
                <p className="text-center text-[10px]" style={{ color: 'var(--cosmic-text-faint)' }}>
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
