/**
 * Session Layout Component
 * Sprint 1 - Week 1
 * 
 * Wraps session pages with header (preset info) and footer (end session)
 * Enhanced with smooth animations and visual polish
 */

'use client';

import { ArrowLeft, FileText, LogOut, Settings, WifiOff } from 'lucide-react';
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
  onToggleSessionFiles?: () => void;
  isSessionFilesOpen?: boolean;
  sessionFilesCount?: number;
}

function SessionHeaderTooltip({
  label,
  align = 'center',
}: {
  label: string;
  align?: 'left' | 'center' | 'right';
}) {
  const positionClass = align === 'left'
    ? 'left-0'
    : align === 'right'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <div
      className={cn(
        'pointer-events-none absolute top-full mt-2 whitespace-nowrap rounded-lg px-2.5 py-1.5',
        'text-[11px] font-medium tracking-wide',
        'opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100',
        positionClass,
      )}
      style={{
        background: 'var(--cosmic-panel-strong)',
        color: 'var(--cosmic-text-strong)',
        border: '1px solid var(--cosmic-border-soft)',
        boxShadow: 'var(--cosmic-shadow-md)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      {label}
    </div>
  );
}

export function SessionLayout({
  store: _store,
  children,
  onEndSession,
  isEnding,
  isSophiaResponding = false,
  isReadOnly = false,
  presenceRef,
  onToggleSessionFiles,
  isSessionFilesOpen = false,
  sessionFilesCount = 0,
}: SessionLayoutProps) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [showOfflineWarning, setShowOfflineWarning] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  
  // Chrome fade during active voice
  const { chromeFaded, chromeOpacity } = useChromeFade();
  const navChromeOpacity = Math.max(chromeOpacity, chromeFaded ? 0.58 : 0.92);

  const sessionIconButtonClass = cn(
    'cosmic-chrome-button cosmic-focus-ring pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full',
    'text-[color:var(--cosmic-text-strong)] shadow-[var(--cosmic-shadow-sm)] transition-all duration-300 hover:scale-[1.03] hover:text-[var(--cosmic-text-strong)]',
  );

  const sessionEndIconButtonClass = cn(
    sessionIconButtonClass,
    'border-[color:color-mix(in_srgb,var(--sophia-error)_28%,var(--cosmic-border-soft))] text-[color:color-mix(in_srgb,var(--sophia-error)_68%,white_12%)] hover:border-[color:color-mix(in_srgb,var(--sophia-error)_40%,var(--cosmic-border))] hover:bg-[color:color-mix(in_srgb,var(--sophia-error)_9%,var(--cosmic-panel))] hover:text-[color:color-mix(in_srgb,var(--sophia-error)_78%,white_12%)]',
  );
  const showSessionFilesButton = sessionFilesCount > 0 && typeof onToggleSessionFiles === 'function';
  const sessionModalPanelClass = cn(
    'cosmic-surface-panel-strong relative w-full max-w-sm overflow-hidden rounded-[18px] border p-5 animate-scaleIn sm:p-6',
    'border-[color:var(--cosmic-border-soft)] shadow-[var(--cosmic-shadow-lg)]',
  );
  const sessionModalSecondaryButtonClass = cn(
    'cosmic-ghost-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300',
    'hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.985]',
  );
  const sessionModalAccentButtonClass = cn(
    'cosmic-accent-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300',
    'hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.985]',
  );
  const sessionModalDangerButtonClass = cn(
    'cosmic-focus-ring flex-1 rounded-full border px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300',
    'hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.985]',
    'border-[color:color-mix(in_srgb,var(--sophia-error)_28%,var(--cosmic-border-soft))]',
    'bg-[color:color-mix(in_srgb,var(--sophia-error)_8%,var(--cosmic-panel-strong))]',
    'text-[color:color-mix(in_srgb,var(--sophia-error)_78%,white_12%)]',
    'shadow-[0_14px_32px_color-mix(in_srgb,var(--sophia-error)_10%,transparent)]',
    'hover:border-[color:color-mix(in_srgb,var(--sophia-error)_44%,var(--cosmic-border))]',
    'hover:bg-[color:color-mix(in_srgb,var(--sophia-error)_14%,var(--cosmic-panel-strong))]',
    'hover:text-[color:color-mix(in_srgb,var(--sophia-error)_92%,white_8%)]',
    'hover:shadow-[0_18px_38px_color-mix(in_srgb,var(--sophia-error)_14%,transparent)]',
  );
  const sessionModalTitleClass = 'font-cormorant text-[1.35rem] font-light leading-snug';
  const sessionModalBodyClass = 'mt-1.5 text-[13px] font-light leading-6';
  const modalBackdropStyle = {
    background: 'radial-gradient(circle at top, color-mix(in srgb, var(--sophia-purple) 5%, transparent) 0%, transparent 34%), color-mix(in srgb, var(--bg) 76%, black 24%)',
  };
  
  // Focus traps for modal dialogs
  const { containerRef: endConfirmRef } = useFocusTrap(showConfirm);
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
    if (!showConfirm && !showBackConfirm && !showOfflineWarning) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showConfirm) setShowConfirm(false);
        if (showBackConfirm) setShowBackConfirm(false);
        if (showOfflineWarning) setShowOfflineWarning(false);
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showConfirm, showBackConfirm, showOfflineWarning]);
  
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
        style={{ opacity: navChromeOpacity, transition: 'opacity 500ms ease' }}
      >
        {/* Left: Back */}
        <div className="group pointer-events-auto relative flex">
          <button
            onClick={handleBackClick}
            aria-label="Back to home"
            className={sessionIconButtonClass}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <SessionHeaderTooltip label="Back" align="left" />
        </div>

        {/* Right: End + Settings */}
        <div className="flex items-center gap-1 pointer-events-auto">
          {showSessionFilesButton ? (
            <div className="group relative flex">
              <button
                onClick={() => {
                  haptic('light');
                  onToggleSessionFiles?.();
                }}
                aria-label={isSessionFilesOpen ? 'Hide session files' : 'Show session files'}
                aria-pressed={isSessionFilesOpen}
                className={cn(
                  sessionIconButtonClass,
                  'relative',
                  isSessionFilesOpen && 'border-[color:var(--cosmic-border)] text-[color:var(--cosmic-text-strong)]'
                )}
              >
                <span className="relative inline-flex">
                  <FileText className="h-4 w-4" />
                  <span
                    className="absolute -right-1 -top-1 inline-flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[8px] font-medium"
                    style={{
                      background: 'color-mix(in srgb, var(--cosmic-panel-strong) 92%, transparent)',
                      color: isSessionFilesOpen ? 'var(--cosmic-text)' : 'var(--cosmic-text-muted)',
                      border: '1px solid color-mix(in srgb, var(--cosmic-border-soft) 82%, transparent)',
                    }}
                  >
                    {sessionFilesCount}
                  </span>
                </span>
              </button>
              <SessionHeaderTooltip label="Files" />
            </div>
          ) : null}

          {!isReadOnly ? (
            <div className="group relative flex">
              <button
                onClick={handleEndClick}
                disabled={isEnding}
                aria-label={isOffline ? 'Session end unavailable while offline' : 'End session'}
                className={cn(
                  sessionEndIconButtonClass,
                  isOffline
                    ? 'cursor-not-allowed border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-soft)] text-[color:var(--cosmic-text-muted)] opacity-75'
                    : undefined,
                  isEnding && 'cursor-not-allowed opacity-50'
                )}
              >
                {isOffline ? <WifiOff className="h-4 w-4" /> : <LogOut className="h-4 w-4" />}
              </button>
              <SessionHeaderTooltip label={isOffline ? 'Offline' : 'End'} />
            </div>
          ) : null}

          <div className="group relative flex">
            <button
              onClick={() => {
                haptic('light');
                router.push('/settings');
              }}
              data-onboarding="header-settings"
              aria-label="Open settings"
              className={sessionIconButtonClass}
            >
              <Settings className="w-4 h-4" />
            </button>
            <SessionHeaderTooltip label="Settings" align="right" />
          </div>
        </div>
      </nav>
      
      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {children}
      </main>

      {/* End Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="cosmic-modal-backdrop absolute inset-0 animate-fadeIn"
            style={modalBackdropStyle}
            onClick={handleCancelEnd}
          />
          <div
            ref={endConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-confirm-title"
            className={sessionModalPanelClass}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background: 'linear-gradient(135deg, color-mix(in srgb, var(--sophia-error) 18%, transparent) 0%, transparent 58%)',
              }}
            />

            <div className="relative">
              <div className="flex items-start gap-3">
                <div
                  className="cosmic-surface-panel flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
                  style={{ color: 'color-mix(in srgb, var(--sophia-error) 74%, white 14%)' }}
                >
                  <LogOut className="h-4.5 w-4.5" />
                </div>

                <div className="min-w-0 flex-1 text-left">
                  <p className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                    Session close-out
                  </p>
                  <h3 id="end-confirm-title" className={sessionModalTitleClass} style={{ color: 'var(--cosmic-text-strong)' }}>
                    End and review?
                  </h3>
                  <p className={sessionModalBodyClass} style={{ color: 'var(--cosmic-text-muted)' }}>
                    We&apos;ll close this conversation and take you straight into recap. Once you review it, the session will live in your history.
                  </p>
                </div>
              </div>

              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCancelEnd}
                  className={sessionModalSecondaryButtonClass}
                >
                  Keep talking
                </button>
                <button
                  type="button"
                  onClick={handleConfirmEnd}
                  className={sessionModalDangerButtonClass}
                >
                  End and review
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Back Confirmation Modal - when Sophia is responding */}
      {showBackConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="cosmic-modal-backdrop absolute inset-0 animate-fadeIn"
            style={modalBackdropStyle}
            onClick={handleCancelBack}
          />
          <div 
            ref={backConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="back-confirm-title"
            className={sessionModalPanelClass}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background: 'linear-gradient(135deg, color-mix(in srgb, var(--sophia-purple) 16%, transparent) 0%, transparent 58%)',
              }}
            />

            <div className="relative">
              <div className="flex items-start gap-3">
                <div className="cosmic-surface-panel flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[var(--cosmic-text-whisper)]">
                  <div className="h-4.5 w-4.5 animate-spin rounded-full border-2" style={{ borderColor: 'var(--cosmic-border-soft)', borderTopColor: 'var(--cosmic-text)' }} />
                </div>

                <div className="min-w-0 flex-1 text-left">
                  <p className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                    Response in progress
                  </p>
                  <h3 id="back-confirm-title" className={sessionModalTitleClass} style={{ color: 'var(--cosmic-text-strong)' }}>
                    Sophia is still responding
                  </h3>
                  <p className={sessionModalBodyClass} style={{ color: 'var(--cosmic-text-muted)' }}>
                    If you leave now, her response will be saved, but it may be incomplete.
                  </p>
                </div>
              </div>

              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCancelBack}
                  className={sessionModalSecondaryButtonClass}
                >
                  Stay here
                </button>
                <button
                  type="button"
                  onClick={handleConfirmBack}
                  className={sessionModalAccentButtonClass}
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="cosmic-modal-backdrop absolute inset-0 animate-fadeIn"
            style={modalBackdropStyle}
            onClick={() => setShowOfflineWarning(false)}
          />
          <div 
            ref={offlineWarningRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-warning-title"
            className={sessionModalPanelClass}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-30"
              style={{
                background: 'linear-gradient(135deg, color-mix(in srgb, var(--cosmic-amber) 18%, transparent) 0%, transparent 58%)',
              }}
            />

            <div className="relative">
              <div className="flex items-start gap-3">
                <div className="cosmic-surface-panel flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[var(--cosmic-amber)]">
                  <WifiOff className="h-4.5 w-4.5" />
                </div>

                <div className="min-w-0 flex-1 text-left">
                  <p className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                    Connection required
                  </p>
                  <h3 id="offline-warning-title" className={sessionModalTitleClass} style={{ color: 'var(--cosmic-text-strong)' }}>
                    You&apos;re offline
                  </h3>
                  <p className={sessionModalBodyClass} style={{ color: 'var(--cosmic-text-muted)' }}>
                    Wait until your connection returns before ending the session so the conversation and recap can be saved cleanly.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowOfflineWarning(false)}
                className={cn(sessionModalAccentButtonClass, 'mt-5 w-full flex-none')}
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
