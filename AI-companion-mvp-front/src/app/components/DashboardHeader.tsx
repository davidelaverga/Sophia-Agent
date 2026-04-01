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

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Sun, Moon } from 'lucide-react';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { setSophiaTheme } from '../ThemeBootstrap';

export function DashboardHeader() {
  const router = useRouter();
  const [theme, setTheme] = useState<string | null>(null);
  
  // Initialize theme from localStorage
  useEffect(() => {
    const storedTheme = localStorage.getItem('sophia-theme');
    if (storedTheme) {
      setTheme(storedTheme);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'moonlit-embrace' : 'light');
    }
  }, []);
  
  const toggleTheme = () => {
    haptic('light');
    const newTheme = theme === 'light' ? 'moonlit-embrace' : 'light';
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
          'group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200',
          'border border-sophia-surface-border bg-sophia-button',
          'hover:border-sophia-purple/40 hover:scale-105 shadow-md',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
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
          'group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200',
          'border border-sophia-surface-border bg-sophia-button',
          'hover:border-sophia-purple/40 hover:scale-105 shadow-md',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
        )}
        aria-label="Settings"
      >
        <Settings className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
      </button>
    </header>
  );
}

export default DashboardHeader;
