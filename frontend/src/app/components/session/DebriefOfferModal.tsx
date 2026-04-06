/**
 * Debrief Offer Modal
 * Sprint 1+ Phase 3
 * 
 * Shows when session ends with offer_debrief: true
 * Allows user to start a debrief session or skip to recap
 */

'use client';

import { MessageCircle } from 'lucide-react';
import { useCallback } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';

// ============================================================================
// TYPES
// ============================================================================

export interface DebriefOfferModalProps {
  isOpen: boolean;
  debriefPrompt: string;
  durationMinutes: number;
  takeaway?: string;
  onStartDebrief: () => void;
  onSkipToRecap: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function DebriefOfferModal({
  isOpen,
  debriefPrompt,
  durationMinutes,
  takeaway,
  onStartDebrief,
  onSkipToRecap,
}: DebriefOfferModalProps) {
  
  const handleStartDebrief = useCallback(() => {
    haptic('medium');
    onStartDebrief();
  }, [onStartDebrief]);
  
  const handleSkip = useCallback(() => {
    haptic('light');
    onSkipToRecap();
  }, [onSkipToRecap]);
  
  if (!isOpen) return null;
  
  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-sophia-bg/70 backdrop-blur-sm animate-fade-in"
      aria-modal="true"
      role="dialog"
      aria-labelledby="debrief-modal-title"
    >
      {/* Modal Card */}
      <div className={cn(
        "bg-sophia-surface border border-sophia-surface-border rounded-2xl shadow-soft max-w-sm w-full mx-4",
        "transform transition-all duration-300",
        "animate-slide-up"
      )}>
        {/* Header with icon */}
        <div className="pt-6 pb-4 px-6 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-sophia-purple/20 flex items-center justify-center">
            <MessageCircle className="w-6 h-6 text-sophia-purple" />
          </div>
          
          <h2 
            id="debrief-modal-title"
            className="text-lg font-semibold text-sophia-text mb-2"
          >
            Nice session! 🎉
          </h2>
          
          <p className="text-sm text-sophia-text2 mb-1">
            {durationMinutes} min • Session complete
          </p>
        </div>
        
        {/* Debrief prompt */}
        <div className="px-6 pb-4">
          <p className="text-sophia-text text-center">
            {debriefPrompt}
          </p>
          
          {/* Takeaway preview if available */}
          {takeaway && (
            <div className="mt-4 p-3 bg-sophia-purple/10 rounded-lg border border-sophia-purple/20">
              <p className="text-xs text-sophia-text2 mb-1">Session takeaway</p>
              <p className="text-sm text-sophia-text">
                {takeaway}
              </p>
            </div>
          )}
        </div>
        
        {/* Actions */}
        <div className="px-6 pb-6 space-y-3">
          <button
            onClick={handleStartDebrief}
            className={cn(
              "w-full py-3 px-4 rounded-xl font-medium",
              "bg-sophia-purple text-sophia-bg",
              "hover:bg-sophia-glow active:scale-[0.98]",
              "transition-all duration-200"
            )}
          >
            Let&apos;s debrief
          </button>
          
          <button
            onClick={handleSkip}
            className={cn(
              "w-full py-3 px-4 rounded-xl font-medium",
              "bg-sophia-surface text-sophia-text2",
              "hover:bg-sophia-surface/80 active:scale-[0.98]",
              "border border-sophia-surface-border",
              "transition-all duration-200"
            )}
          >
            Skip to recap
          </button>
        </div>
      </div>
    </div>
  );
}

export default DebriefOfferModal;
