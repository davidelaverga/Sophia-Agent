/**
 * MobileDrawer Component
 * Sprint 1 - Week 2
 * 
 * Mobile-only drawer for artifacts panel with peek mode.
 * Shows status badge when collapsed, full panel when expanded.
 * Extracted from session/page.tsx for better maintainability.
 */

'use client';

import { ChevronUp, Sparkles } from 'lucide-react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

export type ArtifactStatusType = 'waiting' | 'capturing' | 'ready';

interface MobileDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Hide the built-in peek tab (caller renders its own toggle) */
  showPeek?: boolean;
  artifactStatus?: {
    takeaway: ArtifactStatusType;
    reflection: ArtifactStatusType;
    memories: ArtifactStatusType;
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function MobileDrawer({ 
  isOpen, 
  onToggle, 
  children,
  showPeek = true,
  artifactStatus 
}: MobileDrawerProps) {
  // Calculate status counts for peek display
  const statuses = artifactStatus 
    ? [artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories]
    : ['waiting', 'waiting', 'waiting'];
  const pendingCount = statuses.filter(s => s === 'waiting').length;
  const capturingCount = statuses.filter(s => s === 'capturing').length;
  const readyCount = statuses.filter(s => s === 'ready').length;
  
  // Build status text for peek
  const statusText = readyCount > 0 
    ? `${readyCount} captured`
    : capturingCount > 0 
      ? `${capturingCount} detecting...`
      : `${pendingCount} pending`;

  const sparkleCount = Math.min(3, Math.max(1, readyCount || (capturingCount > 0 ? 1 : 1)));
  const shouldPulse = capturingCount > 0;
  
  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div 
          className="cosmic-modal-backdrop fixed inset-0 z-20 lg:hidden animate-fadeIn"
          onClick={() => {
            haptic('light');
            onToggle();
          }}
        />
      )}
      
      {/* Peek Tab - Always visible when closed (shows status) */}
      {!isOpen && showPeek && (
        <button
          onClick={() => {
            haptic('light');
            onToggle();
          }}
          className={cn(
            'fixed left-1/2 -translate-x-1/2 z-30 lg:hidden',
            // Position above composer
            'bottom-[calc(12rem+env(safe-area-inset-bottom))]',
            'sm:bottom-48',
            'cosmic-surface-panel cosmic-focus-ring rounded-full px-4 py-2.5 transition-all duration-300',
            'flex items-center gap-2',
            'active:scale-95'
          )}
        >
          <div className="relative w-4 h-4 flex items-center justify-center">
            <Sparkles className={cn('w-4 h-4 text-sophia-purple', shouldPulse && 'animate-pulse')} />
            {Array.from({ length: sparkleCount }).map((_, idx) => (
              <span
                key={idx}
                className={cn(
                  'absolute text-[9px] leading-none select-none',
                  shouldPulse && 'animate-pulse'
                )}
                style={{
                  color: 'var(--sophia-purple)',
                  opacity: readyCount > 0 ? 0.9 : 0.55,
                  transform:
                    idx === 0
                      ? 'translate(7px, -7px)'
                      : idx === 1
                        ? 'translate(-7px, -1px)'
                        : 'translate(5px, 7px)',
                }}
                aria-hidden="true"
              >
                ✦
              </span>
            ))}
          </div>
          <span className="text-xs font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Artifacts</span>
          <span className="text-[10px]" style={{ color: 'var(--cosmic-text-muted)' }}>• {statusText}</span>
          <ChevronUp className="ml-1 h-3.5 w-3.5" style={{ color: 'var(--cosmic-text-muted)' }} />
        </button>
      )}
      
      {/* Drawer */}
      <div 
        className={cn(
          'fixed inset-x-0 z-30 lg:hidden',
          isOpen
            ? 'cosmic-surface-panel-strong rounded-t-2xl'
            : 'bg-transparent shadow-none pointer-events-none',
          'transition-transform duration-300 ease-out',
          isOpen 
            ? 'bottom-[calc(12rem+env(safe-area-inset-bottom))] sm:bottom-48' 
            : 'bottom-0 translate-y-full'
        )}
        role={isOpen ? 'dialog' : undefined}
        aria-modal={isOpen ? 'true' : undefined}
        aria-label="Session artifacts"
      >
        {/* Handle + close hint */}
        <div 
          className="flex flex-col items-center pt-2 pb-1 cursor-pointer"
          onClick={() => {
            haptic('light');
            onToggle();
          }}
        >
          <div className="w-10 h-1 rounded-full bg-sophia-surface-border" />
          <span className="mt-1 text-[10px]" style={{ color: 'var(--cosmic-text-faint)' }}>Tap to close</span>
        </div>
        
        {/* Content */}
        <div className={cn(
          'max-h-[50vh] overflow-y-auto transition-opacity duration-300',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}>
          {children}
        </div>
      </div>
    </>
  );
}
