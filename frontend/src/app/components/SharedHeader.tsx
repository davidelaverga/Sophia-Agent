/**
 * SharedHeader Component
 * 
 * Unified header for V1 and V2 experiences
 * "Una app, dos experiencias" - consistent branding across all routes
 * 
 * Variants:
 * - dashboard: Logo + Chat button + Theme + Settings
 * - session: Back + Preset label + Timer + Theme + Settings  
 * - chat: Logo + History + Home + Theme + Settings
 * - recap: Logo + Chat button + Theme + Settings
 */

'use client';

import { useState, lazy, Suspense } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Settings, History, Home, MessageCircle, ArrowLeft, Clock } from 'lucide-react';
import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { ThemeToggle } from './ThemeToggle';

// Lazy load HistoryDrawer for /chat route
const HistoryDrawer = lazy(() => import('./HistoryDrawer').then(mod => ({ default: mod.HistoryDrawer })));

// ============================================================================
// TYPES
// ============================================================================

type HeaderVariant = 'dashboard' | 'session' | 'chat' | 'recap';

interface SharedHeaderProps {
  /** Override auto-detected variant */
  variant?: HeaderVariant;
  /** For session variant: preset label to display */
  presetLabel?: string;
  /** For session variant: context emoji */
  contextEmoji?: string;
  /** For session variant: session start time */
  sessionStartedAt?: string;
}

// ============================================================================
// HEADER BUTTON COMPONENT
// ============================================================================

interface HeaderButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
  showLabel?: boolean;
}

function HeaderButton({ onClick, icon, label, tooltip, showLabel = false }: HeaderButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={cn(
        'group/btn relative flex items-center justify-center rounded-xl transition-all duration-200',
        'border border-sophia-surface-border bg-sophia-button',
        'hover:border-sophia-purple/40 hover:scale-105 shadow-md',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
        showLabel ? 'h-10 px-4 gap-2' : 'h-10 w-10'
      )}
      aria-label={label}
    >
      <span className="group/icon relative flex items-center justify-center">
        {icon}
        
        {/* Tooltip */}
        {tooltip && !showLabel && (
          <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 px-3 py-2 text-xs rounded-lg opacity-0 group-hover/icon:opacity-100 transition-opacity duration-300 delay-200 pointer-events-none whitespace-nowrap z-50 bg-sophia-surface text-sophia-text shadow-lg border border-sophia-surface-border">
            <div className="text-center">{tooltip}</div>
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-sophia-surface border-l border-t border-sophia-surface-border" />
          </div>
        )}
      </span>
      
      {showLabel && (
        <span className="text-sm font-medium text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors">
          {label}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// SESSION TIMER COMPONENT
// ============================================================================

function SessionTimer({ startedAt }: { startedAt?: string }) {
  const [elapsed, setElapsed] = useState('0:00');
  
  // Update timer every second
  useState(() => {
    if (!startedAt) return;
    
    const updateTimer = () => {
      const start = new Date(startedAt).getTime();
      const now = Date.now();
      const diff = Math.floor((now - start) / 1000);
      const mins = Math.floor(diff / 60);
      const secs = diff % 60;
      setElapsed(`${mins}:${secs.toString().padStart(2, '0')}`);
    };
    
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  });
  
  return (
    <div className="flex items-center gap-1.5 text-sm text-sophia-text2">
      <Clock className="w-4 h-4" />
      <span className="tabular-nums">{elapsed}</span>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SharedHeader({
  variant: variantOverride,
  presetLabel,
  contextEmoji,
  sessionStartedAt,
}: SharedHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [showHistory, setShowHistory] = useState(false);
  
  // Auto-detect variant based on pathname
  const variant: HeaderVariant = variantOverride ?? (
    pathname === '/session' ? 'session' :
    pathname === '/chat' ? 'chat' :
    pathname === '/recap' ? 'recap' :
    'dashboard'
  );
  
  const handleLogoClick = () => {
    haptic('light');
    router.push('/');
  };
  
  const handleSettingsClick = () => {
    haptic('light');
    router.push('/settings');
  };
  
  // ============================================================================
  // RENDER: SESSION VARIANT (different layout)
  // ============================================================================
  
  if (variant === 'session') {
    return (
      <header className="bg-sophia-surface/80 backdrop-blur-sm border-b border-sophia-surface-border px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          {/* Left: Back + Preset info */}
          <div className="flex items-center gap-3">
            <HeaderButton
              onClick={() => router.push('/')}
              icon={<ArrowLeft className="w-4 h-4 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
              label="Back to home"
              tooltip="Back"
            />
            <div>
              <h1 className="font-semibold flex items-center gap-2 text-sophia-text">
                {contextEmoji && <span className="text-lg">{contextEmoji}</span>}
                {presetLabel || 'Session'}
              </h1>
              <SessionTimer startedAt={sessionStartedAt} />
            </div>
          </div>
          
          {/* Right: Actions */}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <HeaderButton
              onClick={handleSettingsClick}
              icon={<Settings className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
              label="Settings"
              tooltip="Settings"
            />
          </div>
        </div>
      </header>
    );
  }
  
  // ============================================================================
  // RENDER: STANDARD VARIANTS (dashboard, chat, recap)
  // ============================================================================
  
  return (
    <>
      <header className="safe-px flex h-14 items-center justify-between gap-2 bg-sophia-bg/80 backdrop-blur-sm sticky top-0 z-10">
        {/* Left: Logo + Name */}
        <button
          type="button"
          onClick={handleLogoClick}
          className="flex items-center gap-2.5 min-w-0 group"
          aria-label="Go to home"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-sophia-purple text-lg font-semibold text-white transition-transform group-hover:scale-105 group-active:scale-95">
            S
          </div>
          <div className="min-w-0 hidden sm:block text-left">
            <p className="text-base font-semibold text-sophia-text truncate">
              Sophia
            </p>
            <p className="text-xs text-sophia-text2 truncate">
              {variant === 'chat' ? 'Free Chat' : variant === 'recap' ? 'Session Complete' : 'Your companion'}
            </p>
          </div>
        </button>
        
        {/* Right: Contextual Actions */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          
          {/* Chat-specific: History button */}
          {variant === 'chat' && (
            <HeaderButton
              onClick={() => setShowHistory(true)}
              icon={<History className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
              label="History"
              tooltip="Chat History"
            />
          )}
          
          {/* Dashboard & Recap: Chat button */}
          {(variant === 'dashboard' || variant === 'recap') && (
            <HeaderButton
              onClick={() => router.push('/chat')}
              icon={<MessageCircle className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
              label="Free Chat"
              tooltip="Free Chat"
            />
          )}
          
          {/* Chat-specific: Home button */}
          {variant === 'chat' && (
            <HeaderButton
              onClick={() => router.push('/')}
              icon={<Home className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
              label="Dashboard"
              tooltip="Dashboard"
            />
          )}
          
          <ThemeToggle />
          
          <HeaderButton
            onClick={handleSettingsClick}
            icon={<Settings className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />}
            label="Settings"
            tooltip="Settings"
          />
        </div>
      </header>
      
      {/* History Drawer for chat variant */}
      {variant === 'chat' && showHistory && (
        <Suspense fallback={null}>
          <HistoryDrawer
            isOpen={showHistory}
            onClose={() => setShowHistory(false)}
            onConversationLoaded={() => setShowHistory(false)}
          />
        </Suspense>
      )}
      
    </>
  );
}

export default SharedHeader;
