/**
 * Session Layout Component
 * Sprint 1 - Week 1
 * 
 * Wraps session pages with header (preset info) and footer (end session)
 * Enhanced with smooth animations and visual polish
 */

'use client';

import { ReactNode, useState, useEffect, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Settings, X, WifiOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useChromeFade } from '../hooks/useChromeFade';
import { useConnectivityStore, selectStatus } from '../stores/connectivity-store';
import { useUiStore } from '../stores/ui-store';
import { debugLog } from '../lib/debug-logger';
import { PresenceField, type PresenceFieldHandle } from './presence-field';
import type { SessionClientStore } from '../lib/session-types';

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
  store,
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
        'flex flex-col h-screen overflow-x-hidden bg-[#030308] text-white transition-opacity duration-300',
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
          className="pointer-events-auto text-[10px] tracking-[0.14em] lowercase text-white/20 hover:text-white/40 transition-colors duration-300 px-3 py-1.5 rounded-full hover:bg-white/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
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
                'text-[10px] tracking-[0.14em] lowercase transition-colors duration-300 px-3 py-1.5 rounded-full',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
                isOffline
                  ? 'text-white/15 cursor-not-allowed'
                  : 'text-white/20 hover:text-white/40 hover:bg-white/[0.04]',
                isEnding && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isOffline ? 'offline' : 'end'}
            </button>
          ) : showConfirm ? (
            <div className="flex items-center gap-1 animate-fadeIn">
              <button
                onClick={handleCancelEnd}
                className="text-[10px] tracking-[0.14em] lowercase text-white/20 hover:text-white/40 transition-colors duration-300 px-2.5 py-1.5 rounded-full focus:outline-none"
              >
                cancel
              </button>
              <button
                onClick={handleConfirmEnd}
                className="text-[10px] tracking-[0.14em] lowercase text-red-400/60 hover:text-red-400 transition-colors duration-300 px-2.5 py-1.5 rounded-full hover:bg-red-500/[0.06] focus:outline-none"
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
            className="text-[10px] tracking-[0.14em] lowercase text-white/20 hover:text-white/40 transition-colors duration-300 px-3 py-1.5 rounded-full hover:bg-white/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
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
