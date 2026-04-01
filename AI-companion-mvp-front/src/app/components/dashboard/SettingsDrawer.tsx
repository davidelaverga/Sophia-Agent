/**
 * SettingsDrawer Component
 * Bottom-sheet drawer behind the Sophia logo tap
 * Contains: settings link, history link, theme toggle
 */

'use client';

import { useRouter } from 'next/navigation';
import { Settings, Clock, X } from 'lucide-react';
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0',
          'bg-sophia-surface rounded-t-3xl',
          'border-t border-sophia-surface-border',
          'max-h-[50vh] overflow-hidden',
          'animate-in slide-in-from-bottom duration-300',
        )}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-sophia-text2/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-sophia-purple text-white flex items-center justify-center text-sm font-bold">
              S
            </div>
            <h3 className="text-lg font-semibold text-sophia-text">Sophia</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-sophia-button transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-sophia-text2" />
          </button>
        </div>

        {/* Menu items */}
        <div className="px-5 pb-8 space-y-1">
          <button
            onClick={() => {
              haptic('light');
              onClose();
              router.push('/settings');
            }}
            className={cn(
              'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors',
              'hover:bg-sophia-button',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            )}
          >
            <Settings className="w-5 h-5 text-sophia-text2" />
            <span className="text-sm font-medium text-sophia-text">Settings</span>
          </button>

          <button
            onClick={() => {
              haptic('light');
              onClose();
              onShowHistory?.();
            }}
            className={cn(
              'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors',
              'hover:bg-sophia-button',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            )}
          >
            <Clock className="w-5 h-5 text-sophia-text2" />
            <span className="text-sm font-medium text-sophia-text">History</span>
          </button>

          <div className="flex items-center gap-3 px-4 py-3">
            <span className="text-sm font-medium text-sophia-text">Theme</span>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
}
