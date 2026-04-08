/**
 * Dashboard Header Component
 * Sprint 1 - Week 1
 * 
 * Minimal header with:
 * - Sophia logo with presence indicator
 * - Theme toggle (light/dark)
 * - Settings link
 */

'use client';

import { Settings, Sun, Moon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

import { haptic } from '../hooks/useHaptics';
import { cn } from '../lib/utils';
import {
  COSMIC_THEME_ID,
  SOPHIA_THEME_STORAGE_KEY,
  getThemeToggleTarget,
  normalizeSophiaTheme,
} from '../theme';
import { setSophiaTheme } from '../ThemeBootstrap';

export function DashboardHeader() {
  const router = useRouter();
  const [theme, setTheme] = useState<string | null>(null);
  
  // Initialize theme from localStorage
  useEffect(() => {
    const storedTheme = localStorage.getItem(SOPHIA_THEME_STORAGE_KEY);
    setTheme(normalizeSophiaTheme(storedTheme));
  }, []);
  
  const toggleTheme = () => {
    haptic('light');
    const newTheme = getThemeToggleTarget(theme ?? COSMIC_THEME_ID);
    setTheme(newTheme);
    setSophiaTheme(newTheme); // Use centralized function
  };
  
  const isLight = theme === 'light';
  
  // Don't render until theme is loaded (avoid hydration mismatch)
  if (!theme) {
    return (
      <header className="flex items-center justify-between px-6 mb-6 h-14">
        <div className="w-14 h-14" /> {/* Placeholder */}
      </header>
    );
  }
  
  return (
    <header className="flex items-center justify-between px-6 mb-6">
      {/* Left: Theme Toggle */}
      <button
        onClick={toggleTheme}
        className={cn(
          'cosmic-chrome-button group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 hover:scale-105'
        )}
        aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        {isLight ? (
          <Sun className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
        ) : (
          <Moon className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
        )}
      </button>
      
      {/* Center: Sophia Logo - minimal, doesn't distract */}
      <div className="flex items-center justify-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sophia-purple text-lg font-semibold text-white shadow-md">
          S
        </div>
      </div>
      
      {/* Right: Settings */}
      <button
        onClick={() => {
          haptic('light');
          router.push('/settings');
        }}
        className={cn(
          'cosmic-chrome-button group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 hover:scale-105'
        )}
        aria-label="Settings"
      >
        <Settings className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
      </button>
    </header>
  );
}

export default DashboardHeader;
