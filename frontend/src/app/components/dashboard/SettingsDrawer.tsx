/**
 * SettingsDrawer Component
 * Bottom-sheet drawer behind the Sophia logo tap
 * Contains: settings link, history link, theme toggle
 */

'use client';

import { ArrowUpRight, Clock3, Settings, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';
import { ThemeToggle } from '../ThemeToggle';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onShowHistory?: () => void;
}

export function SettingsDrawer({ isOpen, onClose, onShowHistory }: SettingsDrawerProps) {
  const router = useRouter();
  const [isClosing, setIsClosing] = useState(false);
  const [isAnimatingIn, setIsAnimatingIn] = useState(true);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 220);
  }, [onClose]);

  const handleAction = useCallback((callback: () => void) => {
    haptic('light');
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
      callback();
    }, 220);
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      setIsClosing(false);
      setIsAnimatingIn(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsAnimatingIn(false);
        });
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen && !isClosing) return;

    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, isClosing]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (isOpen || isClosing)) {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isClosing, handleClose]);

  if (!isOpen && !isClosing) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className={cn(
          'cosmic-modal-backdrop absolute inset-0 transition-opacity duration-300',
          isClosing || isAnimatingIn ? 'opacity-0' : 'opacity-100'
        )}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={cn(
          'cosmic-surface-panel-strong absolute bottom-0 left-0 right-0 max-h-[68vh] overflow-hidden rounded-t-[2rem] border-t transition-transform duration-300 ease-out',
          'sm:bottom-auto sm:left-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-[380px] sm:rounded-none sm:rounded-l-[2rem] sm:border-l sm:border-t-0',
          isClosing || isAnimatingIn ? 'translate-y-full sm:translate-x-full sm:translate-y-0' : 'translate-y-0 sm:translate-x-0'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2 sm:hidden">
          <div className="h-1 w-10 rounded-full" style={{ background: 'var(--cosmic-text-faint)' }} />
        </div>

        {/* Header */}
        <div className="relative flex items-center justify-between border-b px-5 pb-4 pt-1 sm:pt-5" style={{ borderColor: 'var(--cosmic-border-soft)' }}>
          <div
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              background: 'linear-gradient(135deg, var(--sophia-purple) 0%, transparent 52%)',
              opacity: 0.05,
            }}
          />

          <div className="relative flex items-center gap-3">
            <div className="cosmic-surface-panel flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
              <Sparkles className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 id="settings-drawer-title" className="font-cormorant text-[1.5rem] leading-none" style={{ color: 'var(--cosmic-text-strong)' }}>Field controls</h3>
              <p className="mt-1 text-[11px] tracking-[0.04em]" style={{ color: 'var(--cosmic-text-muted)' }}>Preferences and utility surfaces</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="cosmic-chrome-button cosmic-focus-ring relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Menu items */}
        <div className="space-y-3 px-5 pb-6 pt-5 sm:pb-8">
          <button
            onClick={() => {
              handleAction(() => router.push('/settings'));
            }}
            className={cn(
              'cosmic-surface-panel cosmic-focus-ring w-full rounded-[1.4rem] p-4 text-left transition-all hover:-translate-y-0.5',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="cosmic-surface-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ color: 'var(--cosmic-text-muted)' }}>
                <Settings className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Settings</span>
                  <ArrowUpRight className="h-4 w-4" style={{ color: 'var(--cosmic-text-whisper)' }} />
                </div>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                  Voice, account, memory, and conversation preferences.
                </p>
              </div>
            </div>
          </button>

          <button
            onClick={() => {
              handleAction(() => onShowHistory?.());
            }}
            className={cn(
              'cosmic-surface-panel cosmic-focus-ring w-full rounded-[1.4rem] p-4 text-left transition-all hover:-translate-y-0.5',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="cosmic-surface-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ color: 'var(--cosmic-text-muted)' }}>
                <Clock3 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>History</span>
                  <ArrowUpRight className="h-4 w-4" style={{ color: 'var(--cosmic-text-whisper)' }} />
                </div>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                  Open the full session archive and revisit recap artifacts.
                </p>
              </div>
            </div>
          </button>

          <div className="cosmic-surface-panel rounded-[1.4rem] p-4">
            <div className="flex items-start gap-3">
              <div className="cosmic-surface-soft flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ color: 'var(--cosmic-text-muted)' }}>
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="block text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Theme</span>
                    <p className="mt-1 text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                      Cosmic Sophia is the default field. You can still switch to a brighter surface when needed.
                    </p>
                  </div>
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </div>

          <div className="px-1 pt-1 text-[11px] tracking-[0.04em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
            These controls stay close so the field feels like one continuous surface.
          </div>
        </div>
      </div>
    </div>
  );
}
