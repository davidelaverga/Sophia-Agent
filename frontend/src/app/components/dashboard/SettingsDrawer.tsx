/**
 * SettingsDrawer Component
 * Bottom-sheet drawer behind the Sophia logo tap
 * Contains: settings link, history link, theme toggle
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Clock3, Settings, Sparkles, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
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
          'absolute inset-0 bg-black/35 backdrop-blur-md transition-opacity duration-300',
          isClosing || isAnimatingIn ? 'opacity-0' : 'opacity-100'
        )}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 max-h-[68vh] overflow-hidden rounded-t-[2rem] border-t border-black/8 bg-white/86 shadow-[0_24px_80px_rgba(0,0,0,0.16)] backdrop-blur-2xl transition-transform duration-300 ease-out dark:border-white/[0.08] dark:bg-black/42 dark:shadow-[0_28px_90px_rgba(0,0,0,0.45)]',
          'sm:bottom-auto sm:left-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-[380px] sm:rounded-none sm:rounded-l-[2rem] sm:border-l sm:border-t-0',
          isClosing || isAnimatingIn ? 'translate-y-full sm:translate-x-full sm:translate-y-0' : 'translate-y-0 sm:translate-x-0'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-black/12 dark:bg-white/18" />
        </div>

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-black/8 px-5 pb-4 pt-1 dark:border-white/[0.08] sm:pt-5">
          <div
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              background: 'linear-gradient(135deg, var(--sophia-purple) 0%, transparent 52%)',
              opacity: 0.05,
            }}
          />

          <div className="relative flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-black/8 bg-white/80 text-[var(--sophia-purple)] shadow-[0_10px_24px_rgba(0,0,0,0.08)] dark:border-white/[0.08] dark:bg-white/[0.06] dark:shadow-[0_14px_36px_rgba(0,0,0,0.35)]">
              <Sparkles className="h-4.5 w-4.5" />
            </div>
            <div>
              <h3 id="settings-drawer-title" className="font-cormorant text-[1.5rem] leading-none text-black/80 dark:text-white/82">Field controls</h3>
              <p className="mt-1 text-[11px] tracking-[0.04em] text-black/42 dark:text-white/42">Preferences and utility surfaces</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-black/8 bg-white/74 text-black/48 transition-all hover:bg-white/90 hover:text-black/68 focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white/52 dark:hover:bg-white/[0.08] dark:hover:text-white/74"
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
              'w-full rounded-[1.4rem] border border-black/8 bg-white/78 p-4 text-left shadow-[0_14px_34px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:border-sophia-purple/24 hover:bg-white/90 hover:shadow-[0_18px_40px_rgba(0,0,0,0.11)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_18px_40px_rgba(0,0,0,0.35)] dark:hover:border-sophia-purple/28 dark:hover:bg-white/[0.07]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-black/[0.03] text-black/52 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/58">
                <Settings className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-black/72 dark:text-white/78">Settings</span>
                  <ArrowUpRight className="h-4 w-4 text-black/34 dark:text-white/38" />
                </div>
                <p className="mt-1 text-[12px] text-black/52 dark:text-white/52">
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
              'w-full rounded-[1.4rem] border border-black/8 bg-white/78 p-4 text-left shadow-[0_14px_34px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:border-sophia-purple/24 hover:bg-white/90 hover:shadow-[0_18px_40px_rgba(0,0,0,0.11)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_18px_40px_rgba(0,0,0,0.35)] dark:hover:border-sophia-purple/28 dark:hover:bg-white/[0.07]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-black/[0.03] text-black/52 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/58">
                <Clock3 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-black/72 dark:text-white/78">History</span>
                  <ArrowUpRight className="h-4 w-4 text-black/34 dark:text-white/38" />
                </div>
                <p className="mt-1 text-[12px] text-black/52 dark:text-white/52">
                  Open the full session archive and revisit recap artifacts.
                </p>
              </div>
            </div>
          </button>

          <div className="rounded-[1.4rem] border border-black/8 bg-white/78 p-4 shadow-[0_14px_34px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_18px_40px_rgba(0,0,0,0.35)]">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-black/[0.03] text-black/52 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white/58">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="block text-sm font-medium text-black/72 dark:text-white/78">Theme</span>
                    <p className="mt-1 text-[12px] text-black/52 dark:text-white/52">
                      Switch between the bright field and moonlit atmosphere.
                    </p>
                  </div>
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </div>

          <div className="px-1 pt-1 text-[11px] tracking-[0.04em] text-black/38 dark:text-white/38">
            These controls stay close so the field feels like one continuous surface.
          </div>
        </div>
      </div>
    </div>
  );
}
