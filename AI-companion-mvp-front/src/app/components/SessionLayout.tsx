/**
 * Session Layout Component
 * Sprint 1 - Week 1
 * 
 * Wraps session pages with header (preset info) and footer (end session)
 * Enhanced with smooth animations and visual polish
 */

'use client';

import { ReactNode, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings, Clock, X, LogOut, WifiOff, Lock } from 'lucide-react';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useChromeFade } from '../hooks/useChromeFade';
import { ThemeToggle } from './ThemeToggle';
import { useConnectivityStore, selectStatus } from '../stores/connectivity-store';
import { useUiStore } from '../stores/ui-store';
import { debugLog } from '../lib/debug-logger';
import { PresenceField } from './presence-field';
import type { SessionClientStore, PresetType, ContextMode } from '../lib/session-types';

interface SessionLayoutProps {
  store: SessionClientStore;
  children: ReactNode;
  onEndSession?: () => void;
  isEnding?: boolean;
  /** Check if Sophia is currently responding - prevents accidental exit */
  isSophiaResponding?: boolean;
  /** Read-only mode for ended sessions */
  isReadOnly?: boolean;
}

const PRESET_LABELS: Record<PresetType, Record<ContextMode, string>> = {
  prepare: {
    gaming: 'Pre-game Prep',
    work: 'Pre-work Focus',
    life: 'Preparation',
  },
  debrief: {
    gaming: 'Post-game Debrief',
    work: 'Work Reflection',
    life: 'Life Debrief',
  },
  reset: {
    gaming: 'Tilt Reset',
    work: 'Stress Reset',
    life: 'Mental Reset',
  },
  vent: {
    gaming: 'Tilt Vent',
    work: 'Stress Vent',
    life: 'Vent Session',
  },
  open: {
    gaming: 'Open Chat',
    work: 'Open Chat',
    life: 'Open Chat',
  },
  chat: {
    gaming: 'Chat',
    work: 'Chat',
    life: 'Chat',
  },
};

const CONTEXT_EMOJIS: Record<ContextMode, string> = {
  gaming: '🎮',
  work: '💼',
  life: '🌟',
};

// Live timer component with connection indicator
function SessionTimer({
  startedAt,
  activeElapsedSeconds,
  activeSegmentStartedAt,
  isLive,
  isEnded,
  endedAt,
  lastActivityAt,
}: {
  startedAt: string
  activeElapsedSeconds?: number
  activeSegmentStartedAt?: string
  isLive: boolean
  isEnded: boolean
  endedAt?: string
  lastActivityAt?: string
}) {
  const [elapsed, setElapsed] = useState('0:00');
  const connectivityStatus = useConnectivityStore(selectStatus);
  
  // Determine dot colors based on connectivity
  const isOnline = connectivityStatus === 'online' || connectivityStatus === 'checking';
  const dotColors = isOnline 
    ? { outer: 'bg-green-400', inner: 'bg-green-500' }
    : { outer: 'bg-red-400', inner: 'bg-red-500' };
  
  useEffect(() => {
    const endSource = endedAt || lastActivityAt;
    const end = endSource ? new Date(endSource).getTime() : Date.now();
    const startMs = new Date(startedAt).getTime();
    const hasValidRange = Number.isFinite(startMs) && Number.isFinite(end) && end >= startMs;
    const fallbackElapsed = hasValidRange ? Math.floor((end - startMs) / 1000) : 0;
    const baseElapsed = (activeElapsedSeconds ?? 0) > 0 ? (activeElapsedSeconds ?? 0) : fallbackElapsed;

    const updateTimer = () => {
      const activeSegmentStartMs = new Date(activeSegmentStartedAt || startedAt).getTime();
      const currentMs = isLive ? Date.now() : end;
      const runningSegmentSeconds = isLive
        ? Math.max(0, Math.floor((currentMs - activeSegmentStartMs) / 1000))
        : 0;
      const totalSeconds = baseElapsed + runningSegmentSeconds;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      setElapsed(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateTimer();
    if (!isLive) return;
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [startedAt, activeElapsedSeconds, activeSegmentStartedAt, endedAt, lastActivityAt, isLive]);
  
  return (
    <div 
      className="flex items-center gap-1.5 text-sm text-white/40" 
      role="timer" 
      aria-live="off"
      title={isOnline ? 'Connected' : 'Offline mode'}
    >
      {/* Active session indicator - breathing dot (color based on connectivity) */}
      <span className="relative flex h-2 w-2">
        <span className={cn(
          'absolute inline-flex h-full w-full rounded-full opacity-75',
          isOnline && 'animate-ping',
          dotColors.outer
        )} />
        <span className={cn(
          'relative inline-flex rounded-full h-2 w-2',
          dotColors.inner
        )} />
      </span>
      <Clock className="w-3.5 h-3.5" />
      {isEnded && (
        <span className="flex items-center gap-1 text-[11px] text-white/25">
          Ended
          <span className="text-white/15">·</span>
        </span>
      )}
      <span className="tabular-nums">{elapsed}</span>
    </div>
  );
}

export function SessionLayout({
  store,
  children,
  onEndSession,
  isEnding,
  isSophiaResponding = false,
  isReadOnly = false,
}: SessionLayoutProps) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [showOfflineWarning, setShowOfflineWarning] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  
  // Chrome fade during active voice
  const { chromeFaded, chromeOpacity } = useChromeFade();
  
  // Focus traps for modal dialogs
  const { containerRef: backConfirmRef } = useFocusTrap(showBackConfirm);
  const { containerRef: offlineWarningRef } = useFocusTrap(showOfflineWarning);
  
  // Check connectivity status for offline protection
  const connectivityStatus = useConnectivityStore(selectStatus);
  const isOffline = connectivityStatus === 'offline' || connectivityStatus === 'degraded';
  
  // Entrance animation
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);
  
  const presetLabel = PRESET_LABELS[store.presetType]?.[store.contextMode] || store.presetType;
  const contextEmoji = CONTEXT_EMOJIS[store.contextMode] || '💬';
  
  const handleEndClick = () => {
    // Block end session while offline to prevent data loss
    if (isOffline) {
      haptic('error');
      setShowOfflineWarning(true);
      return;
    }
    haptic('light');
    setShowConfirm(true);
  };
  
  const handleConfirmEnd = () => {
    haptic('medium');
    setShowConfirm(false);
    onEndSession?.();
  };
  
  const handleCancelEnd = () => {
    haptic('light');
    setShowConfirm(false);
  };
  
  // Handle back button - show confirmation if Sophia is responding
  const handleBackClick = () => {
    debugLog('SessionLayout', 'Back clicked', { isSophiaResponding });
    if (isSophiaResponding) {
      haptic('light');
      setShowBackConfirm(true);
    } else {
      haptic('light');
      router.push('/');
    }
  };
  
  const handleConfirmBack = () => {
    haptic('medium');
    setShowBackConfirm(false);
    router.push('/');
  };
  
  const handleCancelBack = () => {
    haptic('light');
    setShowBackConfirm(false);
  };

  // Tap empty space to unfade chrome
  const handleRootPointerDown = (e: React.PointerEvent) => {
    if (!chromeFaded) return;
    const target = e.target as HTMLElement;
    // Only unfade on tap of non-interactive areas
    if (!target.closest('button, a, input, [role="button"]')) {
      useUiStore.getState().setChromeFaded(false);
    }
  };

  // Escape key dismisses open modals
  useEffect(() => {
    if (!showBackConfirm && !showOfflineWarning) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showBackConfirm) setShowBackConfirm(false);
        if (showOfflineWarning) setShowOfflineWarning(false);
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showBackConfirm, showOfflineWarning]);
  
  return (
    <div
      className={cn(
        'flex flex-col h-screen overflow-x-hidden bg-[#030308] text-white transition-opacity duration-300',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
      onPointerDown={handleRootPointerDown}
    >
      {/* Presence Field — WebGL nebula + ribbons + sparks behind all content */}
      <PresenceField />
      {/* Header */}
      <header
        className={cn(
          'bg-black/20 backdrop-blur-md border-b border-white/[0.03] px-4 py-3 transition-all duration-500',
          isVisible ? 'translate-y-0' : '-translate-y-full'
        )}
        style={{ opacity: chromeOpacity, transition: 'opacity 500ms ease' }}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          {/* Left: Back + Title */}
          <div className="flex items-center gap-3 flex-1">
            <button
              onClick={handleBackClick}
              aria-label="Back to home"
              className={cn(
                'group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200',
                'border border-white/[0.06] bg-white/[0.04]',
                'hover:bg-white/[0.08] hover:scale-105',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20'
              )}
            >
              <ArrowLeft className="w-5 h-5 text-white/40 group-hover/btn:text-white/60 transition-colors" />
            </button>
            <div>
              <h1 className="font-semibold flex items-center gap-2 text-white/60 text-sm sm:text-base [text-shadow:_0_1px_8px_rgba(0,0,0,0.3)]">
                <span className="text-base sm:text-lg" aria-hidden="true">{contextEmoji}</span>
                <span className="hidden xs:inline">{presetLabel}</span>
              </h1>
            </div>
          </div>
          
          {/* Center: Timer + Status */}
          <div className="flex-1 flex justify-center">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04]">
              <SessionTimer
                startedAt={store.startedAt}
                activeElapsedSeconds={store.activeElapsedSeconds}
                activeSegmentStartedAt={store.activeSegmentStartedAt}
                endedAt={store.endedAt}
                lastActivityAt={store.lastActivityAt}
                isLive={!isReadOnly && store.status === 'active'}
                isEnded={store.status === 'ended'}
              />
              {isReadOnly && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white/30">
                  <Lock className="w-3 h-3" />
                  Read-only
                </span>
              )}
            </div>
          </div>
          
          {/* Right: Actions */}
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* End Session button - in header for cleaner UX */}
            {!showConfirm && !isReadOnly ? (
              <button
                onClick={handleEndClick}
                disabled={isEnding}
                title={isOffline ? 'Cannot end session while offline' : 'End session'}
                className={cn(
                  'hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50',
                  isOffline 
                    ? 'text-white/20 cursor-not-allowed' 
                    : 'text-white/40 hover:text-red-400 hover:bg-red-500/10',
                  isEnding && 'opacity-50 cursor-not-allowed'
                )}
              >
                {isOffline ? <WifiOff className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
                <span className="hidden md:inline">{isOffline ? 'Offline' : 'End'}</span>
              </button>
            ) : (
              <div className="hidden sm:flex items-center gap-2 animate-fadeIn">
                <button
                  onClick={handleCancelEnd}
                  className="px-2 py-1 text-xs text-white/30 hover:text-white/60 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmEnd}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                >
                  <X className="w-3 h-3" />
                  End
                </button>
              </div>
            )}
            
            {/* Theme toggle - reusable component */}
            <ThemeToggle dataOnboardingId="header-theme-toggle" />
            
            <button
              onClick={() => {
                haptic('light');
                router.push('/settings');
              }}
              data-onboarding="header-settings"
              className={cn(
                'group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200',
                'border border-white/[0.06] bg-white/[0.04]',
                'hover:bg-white/[0.08] hover:scale-105',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20'
              )}
              aria-label="Open settings"
            >
              <Settings className="w-5 h-5 text-white/40 group-hover/btn:text-white/60 transition-colors" />
            </button>
          </div>
        </div>
      </header>
      
      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {children}
      </main>
      
      {/* Mobile-only Footer - End Session for small screens */}
      <footer
        className={cn(
          'sm:hidden bg-black/20 backdrop-blur-md border-t border-white/[0.03]',
          'pb-[env(safe-area-inset-bottom)] pt-1.5 px-2',
          'transition-all duration-500 z-40 relative shrink-0',
          isVisible ? 'translate-y-0' : 'translate-y-full'
        )}
        style={{ opacity: chromeOpacity, transition: 'opacity 500ms ease' }}
      >
        <div className="flex justify-center">
          {!showConfirm ? (
            <button
              onClick={handleEndClick}
              disabled={isEnding}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all duration-200',
                isOffline 
                  ? 'text-white/20' 
                  : 'text-white/40 hover:text-red-400 hover:bg-red-500/10',
                isEnding && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isOffline ? <WifiOff className="w-3.5 h-3.5" /> : <LogOut className="w-3.5 h-3.5" />}
              {isEnding ? 'Ending...' : isOffline ? 'Offline' : 'End Session'}
            </button>
          ) : (
            <div className="flex items-center gap-3 animate-fadeIn">
              <button
                onClick={handleCancelEnd}
                className="px-2.5 py-1 text-[11px] text-white/30 hover:text-white/60 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmEnd}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                <X className="w-3 h-3" />
                End
              </button>
            </div>
          )}
        </div>
      </footer>
      
      {/* Back Confirmation Modal - when Sophia is responding */}
      {showBackConfirm && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fadeIn"
          onClick={handleCancelBack}
        >
          <div 
            ref={backConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="back-confirm-title"
            className="w-[90%] max-w-sm bg-[rgba(8,8,18,0.78)] backdrop-blur-[28px] rounded-2xl p-6 border border-white/[0.06] animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              {/* Thinking indicator */}
              <div className="w-12 h-12 rounded-full bg-white/[0.06] flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white/10 border-t-white/40 rounded-full animate-spin" />
              </div>
              
              <div className="space-y-2">
                <h3 id="back-confirm-title" className="text-lg font-semibold text-white/80">
                  Sophia is still responding
                </h3>
                <p className="text-sm text-white/40">
                  If you leave now, her response will be saved but may be incomplete.
                </p>
              </div>
              
              <div className="flex gap-3 w-full mt-2">
                <button
                  onClick={handleCancelBack}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-white/[0.06] border border-white/[0.08] text-white/60 font-medium transition-colors hover:bg-white/[0.10] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                >
                  Stay
                </button>
                <button
                  onClick={handleConfirmBack}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-white/[0.12] text-white/80 font-medium transition-colors hover:bg-white/[0.16] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                >
                  Leave anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Offline Warning Modal - prevents ending session while offline */}
      {showOfflineWarning && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fadeIn"
          onClick={() => setShowOfflineWarning(false)}
        >
          <div 
            ref={offlineWarningRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-warning-title"
            className="w-[90%] max-w-sm bg-[rgba(8,8,18,0.78)] backdrop-blur-[28px] rounded-2xl p-6 border border-white/[0.06] animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              {/* Offline indicator */}
              <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
                <WifiOff className="w-6 h-6 text-amber-500" />
              </div>
              
              <div className="space-y-2">
                <h3 id="offline-warning-title" className="text-lg font-semibold text-white/80">
                  You&apos;re offline
                </h3>
                <p className="text-sm text-white/40">
                  Please wait until your connection is restored before ending the session. 
                  This ensures your conversation is saved properly.
                </p>
              </div>
              
              <button
                onClick={() => setShowOfflineWarning(false)}
                className="w-full py-2.5 px-4 rounded-xl bg-white/[0.12] text-white/80 font-medium transition-colors hover:bg-white/[0.16] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SessionLayout;
