/**
 * Error Modal Component
 * Week 4 - Alpha Test Prep
 * 
 * Modal for displaying session errors with actionable options.
 * - Session timeout/expiration
 * - Network failures
 * - Multi-tab conflicts
 */

'use client';

import { useEffect } from 'react';
import { AlertTriangle, WifiOff, Clock, TabletSmartphone, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';

// =============================================================================
// TYPES
// =============================================================================

export type ErrorType = 
  | 'session_expired'
  | 'network_error'
  | 'multi_tab'
  | 'backend_error'
  | 'unknown';

export interface ErrorAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'destructive';
}

export interface ErrorModalProps {
  isOpen: boolean;
  errorType?: ErrorType;
  title?: string;
  message?: string;
  actions?: ErrorAction[];
  onClose?: () => void;
  dismissible?: boolean;
}

// =============================================================================
// ERROR CONFIGURATIONS
// =============================================================================

const ERROR_CONFIGS: Record<ErrorType, {
  icon: typeof AlertTriangle;
  iconColor: string;
  bgColor: string;
  defaultTitle: string;
  defaultMessage: string;
}> = {
  session_expired: {
    icon: Clock,
    iconColor: 'text-sophia-purple',
    bgColor: 'bg-sophia-purple/20',
    defaultTitle: 'Session Expired',
    defaultMessage: 'Your session has timed out. Would you like to start a fresh session or try reconnecting?',
  },
  network_error: {
    icon: WifiOff,
    iconColor: 'text-sophia-error',
    bgColor: 'bg-sophia-error/20',
    defaultTitle: 'Connection Lost',
    defaultMessage: 'We couldn\'t reach Sophia. Check your internet connection and try again.',
  },
  multi_tab: {
    icon: TabletSmartphone,
    iconColor: 'text-sophia-purple',
    bgColor: 'bg-sophia-purple/20',
    defaultTitle: 'Session Active Elsewhere',
    defaultMessage: 'Another session is active in a different tab. Only one active session is allowed at a time.',
  },
  backend_error: {
    icon: AlertTriangle,
    iconColor: 'text-sophia-error',
    bgColor: 'bg-sophia-error/20',
    defaultTitle: 'Something Went Wrong',
    defaultMessage: 'Sophia encountered an unexpected error. Our team has been notified.',
  },
  unknown: {
    icon: AlertTriangle,
    iconColor: 'text-sophia-error',
    bgColor: 'bg-sophia-error/20',
    defaultTitle: 'Error',
    defaultMessage: 'Something unexpected happened. Please try again.',
  },
};

// =============================================================================
// COMPONENT
// =============================================================================

export function ErrorModal({
  isOpen,
  errorType = 'unknown',
  title,
  message,
  actions,
  onClose,
  dismissible = true,
}: ErrorModalProps) {
  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      haptic('error');
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);
  
  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible && onClose) {
        onClose();
      }
    };
    
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, dismissible, onClose]);
  
  if (!isOpen) return null;
  
  const config = ERROR_CONFIGS[errorType];
  const Icon = config.icon;
  
  const displayTitle = title || config.defaultTitle;
  const displayMessage = message || config.defaultMessage;
  
  // Default actions if none provided
  const displayActions = actions || [
    { 
      label: 'Try Again', 
      onClick: onClose || (() => {}), 
      variant: 'primary' as const 
    },
  ];
  
  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby="error-modal-title"
    >
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-sophia-bg/70 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
      />
      
      {/* Modal */}
      <div className="relative bg-sophia-bg border border-sophia-surface-border rounded-2xl p-6 max-w-md w-full shadow-soft animate-in zoom-in-95 duration-200">
        {/* Close button */}
        {dismissible && onClose && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1 rounded-full hover:bg-sophia-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-sophia-text2" />
          </button>
        )}
        
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className={cn(
            'w-16 h-16 rounded-full flex items-center justify-center',
            config.bgColor
          )}>
            <Icon className={cn('w-8 h-8', config.iconColor)} />
          </div>
        </div>
        
        {/* Title */}
        <h2 
          id="error-modal-title"
          className="text-xl font-bold text-center text-sophia-text mb-2"
        >
          {displayTitle}
        </h2>
        
        {/* Message */}
        <p className="text-sophia-text2 text-center mb-6">
          {displayMessage}
        </p>
        
        {/* Actions */}
        <div className="flex gap-3 justify-center">
          {displayActions.map((action, index) => (
            <button
              key={index}
              onClick={() => {
                haptic('light');
                action.onClick();
              }}
              className={cn(
                'px-6 py-2.5 rounded-xl font-medium text-sm transition-all',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
                action.variant === 'secondary' 
                  ? 'bg-sophia-surface hover:bg-sophia-surface/80 text-sophia-text'
                  : action.variant === 'destructive'
                  ? 'bg-sophia-error hover:brightness-105 text-sophia-bg'
                  : 'bg-sophia-purple hover:bg-sophia-purple/90 text-sophia-bg'
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PRESET ERROR MODALS
// =============================================================================

interface PresetErrorModalProps {
  isOpen: boolean;
  onRetry?: () => void;
  onGoHome?: () => void;
  onClose?: () => void;
}

export function SessionExpiredModal({ isOpen, onRetry, onGoHome }: PresetErrorModalProps) {
  return (
    <ErrorModal
      isOpen={isOpen}
      errorType="session_expired"
      actions={[
        { label: 'Go Home', onClick: onGoHome || (() => {}), variant: 'secondary' },
        { label: 'Start Fresh', onClick: onRetry || (() => {}), variant: 'primary' },
      ]}
      dismissible={false}
    />
  );
}

export function NetworkErrorModal({ isOpen, onRetry, onClose }: PresetErrorModalProps) {
  return (
    <ErrorModal
      isOpen={isOpen}
      errorType="network_error"
      actions={[
        { label: 'Cancel', onClick: onClose || (() => {}), variant: 'secondary' },
        { label: 'Retry', onClick: onRetry || (() => {}), variant: 'primary' },
      ]}
      onClose={onClose}
    />
  );
}

export function MultiTabModal({ isOpen, onGoHome, onTakeOver }: PresetErrorModalProps & { onTakeOver?: () => void }) {
  return (
    <ErrorModal
      isOpen={isOpen}
      errorType="multi_tab"
      actions={[
        { label: 'Go Home', onClick: onGoHome || (() => {}), variant: 'secondary' },
        { label: 'Use This Tab', onClick: onTakeOver || (() => {}), variant: 'primary' },
      ]}
      dismissible={false}
    />
  );
}

export default ErrorModal;
