/**
 * Session Layout Component
 * Sprint 1 - Week 1
 * 
 * Wraps session pages with header (preset info) and footer (end session)
 * Enhanced with smooth animations and visual polish
 */

'use client';

import { ArrowLeft, Settings, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useEffect, type RefObject } from 'react';

import { useChromeFade } from '../hooks/useChromeFade';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { haptic } from '../hooks/useHaptics';
import { debugLog } from '../lib/debug-logger';
import type { SessionClientStore } from '../lib/session-types';
import { cn } from '../lib/utils';
import { useConnectivityStore, selectStatus } from '../stores/connectivity-store';
import { useUiStore } from '../stores/ui-store';

import { PresenceField, type PresenceFieldHandle } from './presence-field';

interface SessionLayoutProps {
  store: SessionClientStore;
  children: ReactNode;
  onEndSession?: () => void;
  isEnding?: boolean;
  /** Check if Sophia is currently responding - prevents accidental exit */
  isSophiaResponding?: boolean;
  /** Read-only mode for ended sessions */
  isReadOnly?: boolean;
  presenceRef?: RefObject<PresenceFieldHandle | null>;
}

export function SessionLayout({
  store: _store,
  children,
  onEndSession,
  isEnding,
  isSophiaResponding = false,
  isReadOnly = false,
  presenceRef,
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
        'flex h-screen flex-col overflow-x-hidden bg-[var(--bg)] text-white transition-opacity duration-300',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
      onPointerDown={handleRootPointerDown}
    >
      {/* Presence Field — WebGL nebula + ribbons + sparks behind all content */}
      <PresenceField ref={presenceRef} />

      {/* Floating whisper nav — always visible in both voice and text modes */}
      <nav
        className={cn(
          'fixed top-4 left-4 right-4 z-50 flex items-center justify-between pointer-events-none',
          'transition-all duration-500',
          isVisible ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'
        )}
        style={{ opacity: chromeOpacity, transition: 'opacity 500ms ease' }}
      >
        {/* Left: Back */}
        <button
          onClick={handleBackClick}
          aria-label="Back to home"
          className="cosmic-whisper-button cosmic-focus-ring pointer-events-auto rounded-full px-3 py-1.5 text-[10px] tracking-[0.14em] lowercase transition-colors duration-300"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Right: End + Settings */}
        <div className="flex items-center gap-1 pointer-events-auto">
          {!showConfirm && !isReadOnly ? (
            <button
              onClick={handleEndClick}
              disabled={isEnding}
              title={isOffline ? 'Cannot end session while offline' : 'End session'}
              className={cn(
                'cosmic-focus-ring rounded-full px-3 py-1.5 text-[10px] tracking-[0.14em] lowercase transition-colors duration-300',
                isOffline
                  ? 'cursor-not-allowed text-[var(--cosmic-text-faint)]'
                  : 'cosmic-whisper-button',
                isEnding && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isOffline ? 'offline' : 'end'}
            </button>
          ) : showConfirm ? (
            <div className="flex items-center gap-1 animate-fadeIn">
              <button
                onClick={handleCancelEnd}
                className="cosmic-whisper-button cosmic-focus-ring rounded-full px-2.5 py-1.5 text-[10px] tracking-[0.14em] lowercase transition-colors duration-300"
              >
                cancel
              </button>
              <button
                onClick={handleConfirmEnd}
                className="cosmic-focus-ring rounded-full px-2.5 py-1.5 text-[10px] tracking-[0.14em] lowercase transition-colors duration-300 hover:bg-[color-mix(in_srgb,var(--sophia-error)_10%,transparent)]"
                style={{ color: 'color-mix(in srgb, var(--sophia-error) 70%, white 10%)' }}
              >
                end session
              </button>
            </div>
          ) : null}

          <button
            onClick={() => {
              haptic('light');
              router.push('/settings');
            }}
            data-onboarding="header-settings"
            aria-label="Open settings"
            className="cosmic-whisper-button cosmic-focus-ring rounded-full px-3 py-1.5 text-[10px] tracking-[0.14em] lowercase transition-colors duration-300"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </nav>
      
      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {children}
      </main>
      
      {/* Back Confirmation Modal - when Sophia is responding */}
      {showBackConfirm && (
        <div 
          className="cosmic-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center animate-fadeIn"
          onClick={handleCancelBack}
        >
          <div 
            ref={backConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="back-confirm-title"
            className="cosmic-surface-panel-strong w-[90%] max-w-sm rounded-2xl p-6 animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              {/* Thinking indicator */}
              <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'var(--cosmic-panel-soft)' }}>
                <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: 'var(--cosmic-border-soft)', borderTopColor: 'var(--cosmic-text-whisper)' }} />
              </div>
              
              <div className="space-y-2">
                <h3 id="back-confirm-title" className="text-lg font-semibold" style={{ color: 'var(--cosmic-text-strong)' }}>
                  Sophia is still responding
                </h3>
                <p className="text-sm" style={{ color: 'var(--cosmic-text-muted)' }}>
                  If you leave now, her response will be saved but may be incomplete.
                </p>
              </div>
              
              <div className="flex gap-3 w-full mt-2">
                <button
                  onClick={handleCancelBack}
                  className="cosmic-ghost-pill cosmic-focus-ring flex-1 rounded-xl px-4 py-2.5 font-medium transition-colors"
                >
                  Stay
                </button>
                <button
                  onClick={handleConfirmBack}
                  className="cosmic-accent-pill cosmic-focus-ring flex-1 rounded-xl px-4 py-2.5 font-medium transition-colors"
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
          className="cosmic-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center animate-fadeIn"
          onClick={() => setShowOfflineWarning(false)}
        >
          <div 
            ref={offlineWarningRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-warning-title"
            className="cosmic-surface-panel-strong w-[90%] max-w-sm rounded-2xl p-6 animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center gap-4">
              {/* Offline indicator */}
              <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: 'color-mix(in srgb, var(--cosmic-amber) 12%, transparent)' }}>
                <WifiOff className="h-6 w-6" style={{ color: 'var(--cosmic-amber)' }} />
              </div>
              
              <div className="space-y-2">
                <h3 id="offline-warning-title" className="text-lg font-semibold" style={{ color: 'var(--cosmic-text-strong)' }}>
                  You&apos;re offline
                </h3>
                <p className="text-sm" style={{ color: 'var(--cosmic-text-muted)' }}>
                  Please wait until your connection is restored before ending the session. 
                  This ensures your conversation is saved properly.
                </p>
              </div>
              
              <button
                onClick={() => setShowOfflineWarning(false)}
                className="cosmic-accent-pill cosmic-focus-ring w-full rounded-xl px-4 py-2.5 font-medium transition-colors"
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
