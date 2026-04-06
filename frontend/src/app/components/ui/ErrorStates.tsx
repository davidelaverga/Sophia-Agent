/**
 * Error States
 * Sprint 1+ - Humanized error messages
 * 
 * Sophia speaks even when things break.
 * No stack traces. No panic. Just empathy + action.
 */

'use client';

import { RefreshCw, Home, MessageCircle, Wifi, AlertCircle, Clock } from 'lucide-react';
import { useCallback, useState } from 'react';

import { errorCopy } from '../../lib/error-copy';
import { cn } from '../../lib/utils';

import { RetryAction } from './RetryAction';

// =============================================================================
// ERROR TYPES
// =============================================================================

export type ErrorKind = 
  | 'network'       // Network/fetch failures
  | 'timeout'       // Request took too long
  | 'auth'          // Authentication issues
  | 'server'        // 5xx errors
  | 'rate_limit'    // Too many requests
  | 'session'       // Session expired/invalid
  | 'unknown';      // Catch-all

interface ErrorConfig {
  icon: typeof AlertCircle;
  title: string;
  message: string;
  suggestion: string;
  retryable: boolean;
}

// Sophia's empathetic error messages
const ERROR_CONFIGS: Record<ErrorKind, ErrorConfig> = {
  network: {
    icon: Wifi,
    title: "Connection hiccup",
    message: "I can't reach my servers right now.",
    suggestion: "Check your internet connection and try again.",
    retryable: true,
  },
  timeout: {
    icon: Clock,
    title: "Taking longer than expected",
    message: "The request is still processing.",
    suggestion: "Give it a moment, or try again.",
    retryable: true,
  },
  auth: {
    icon: AlertCircle,
    title: "Session expired",
    message: "Your login has timed out.",
    suggestion: "Please sign in again to continue.",
    retryable: false,
  },
  server: {
    icon: AlertCircle,
    title: "Something went wrong",
    message: "There's an issue on my end.",
    suggestion: "Try again in a moment. If it persists, I'll look into it.",
    retryable: true,
  },
  rate_limit: {
    icon: Clock,
    title: "Slow down",
    message: "You're sending messages faster than I can keep up!",
    suggestion: "Wait a few seconds before trying again.",
    retryable: true,
  },
  session: {
    icon: MessageCircle,
    title: "Session ended",
    message: "This conversation has ended or expired.",
    suggestion: "Start a new session to continue chatting.",
    retryable: false,
  },
  unknown: {
    icon: AlertCircle,
    title: "Oops",
    message: "Something unexpected happened.",
    suggestion: "Try refreshing the page.",
    retryable: true,
  },
};

// =============================================================================
// HELPER: Detect error kind from error object
// =============================================================================

export function detectErrorKind(error: unknown): ErrorKind {
  if (!error) return 'unknown';
  
  // Network errors
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'network';
  }
  
  // Check for error response objects
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    
    // HTTP status codes
    const status = err.status || err.statusCode;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) return 'auth';
      if (status === 429) return 'rate_limit';
      if (status >= 500) return 'server';
    }
    
    // Error messages
    const message = String(err.message || '').toLowerCase();
    if (message.includes('timeout') || message.includes('aborted')) return 'timeout';
    if (message.includes('network') || message.includes('fetch')) return 'network';
    if (message.includes('session') || message.includes('expired')) return 'session';
  }
  
  return 'unknown';
}

// =============================================================================
// MAIN ERROR CARD COMPONENT
// =============================================================================

interface ErrorCardProps {
  /** The type of error */
  kind?: ErrorKind;
  /** Custom title (overrides default) */
  title?: string;
  /** Custom message (overrides default) */
  message?: string;
  /** Show retry button */
  showRetry?: boolean;
  /** Retry callback */
  onRetry?: () => void | Promise<void>;
  /** Show home button */
  showHome?: boolean;
  /** Home callback */
  onHome?: () => void;
  /** Variant */
  variant?: 'card' | 'inline' | 'fullscreen';
  /** Additional classes */
  className?: string;
}

export function ErrorCard({
  kind = 'unknown',
  title,
  message,
  showRetry = true,
  onRetry,
  showHome = false,
  onHome,
  variant = 'card',
  className,
}: ErrorCardProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const config = ERROR_CONFIGS[kind];
  const Icon = config.icon;
  
  const handleRetry = useCallback(async () => {
    if (!onRetry || isRetrying) return;
    
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry, isRetrying]);
  
  // Fullscreen variant
  if (variant === 'fullscreen') {
    return (
      <div className={cn(
        'min-h-screen bg-sophia-bg flex items-center justify-center p-6',
        className
      )}>
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-500/10 flex items-center justify-center">
            <Icon className="w-8 h-8 text-red-500" />
          </div>
          
          <div>
            <h1 className="text-xl font-semibold text-sophia-text mb-2">
              {title || config.title}
            </h1>
            <p className="text-sophia-text2">
              {message || config.message}
            </p>
            <p className="text-sm text-sophia-text2/60 mt-2">
              {config.suggestion}
            </p>
          </div>
          
          <div className="flex gap-3 justify-center">
            {showRetry && config.retryable && onRetry && (
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                className={cn(
                  'px-6 py-3 rounded-xl font-medium transition-all',
                  'bg-sophia-purple text-white',
                  'hover:bg-sophia-purple/90 active:scale-[0.98]',
                  'disabled:opacity-50',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
                )}
              >
                {isRetrying ? (
                  <RefreshCw className="w-5 h-5 animate-spin" />
                ) : (
                  'Try Again'
                )}
              </button>
            )}
            
            {showHome && onHome && (
              <button
                onClick={onHome}
                className={cn(
                  'px-6 py-3 rounded-xl font-medium transition-all',
                  'border border-sophia-surface-border',
                  'hover:bg-sophia-surface active:scale-[0.98]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
                )}
              >
                <Home className="w-5 h-5 inline-block mr-2" />
                Go Home
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  
  // Inline variant
  if (variant === 'inline') {
    return (
      <div className={cn(
        'flex items-center gap-3 p-3 rounded-lg',
        'bg-red-500/5 border border-red-500/20',
        className
      )}>
        <Icon className="w-5 h-5 text-red-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-sophia-text">{title || config.title}</p>
          <p className="text-xs text-sophia-text2 truncate">{message || config.message}</p>
        </div>
        {showRetry && config.retryable && onRetry && (
          <button
            onClick={handleRetry}
            disabled={isRetrying}
            className="shrink-0 p-2 rounded-lg hover:bg-sophia-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
          >
            <RefreshCw className={cn('w-4 h-4 text-sophia-text2', isRetrying && 'animate-spin')} />
          </button>
        )}
      </div>
    );
  }
  
  // Default card variant
  return (
    <div className={cn(
      'p-6 rounded-2xl text-center',
      'bg-sophia-surface border border-sophia-surface-border',
      className
    )}>
      <div className="w-12 h-12 mx-auto rounded-full bg-red-500/10 flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-red-500" />
      </div>
      
      <h3 className="font-semibold text-sophia-text mb-1">
        {title || config.title}
      </h3>
      <p className="text-sm text-sophia-text2 mb-1">
        {message || config.message}
      </p>
      <p className="text-xs text-sophia-text2/60 mb-4">
        {config.suggestion}
      </p>
      
      {showRetry && config.retryable && onRetry && (
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-all',
            'bg-sophia-purple text-white',
            'hover:bg-sophia-purple/90 active:scale-[0.98]',
            'disabled:opacity-50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
          )}
        >
          {isRetrying ? (
            <span className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Retrying...
            </span>
          ) : (
            'Try Again'
          )}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// STREAMING ERROR (for chat)
// =============================================================================

interface StreamErrorProps {
  error: unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function StreamError({ error, onRetry, onDismiss }: StreamErrorProps) {
  const kind = detectErrorKind(error);
  const config = ERROR_CONFIGS[kind];
  const message = kind === 'network' ? errorCopy.couldntReachSophia : errorCopy.connectionInterrupted;
  
  return (
    <div className={cn(
      'flex items-start gap-3 p-4 rounded-xl mx-4 my-2',
      'bg-red-500/5 border border-red-500/20',
      'animate-fadeIn'
    )}>
      <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
        <config.icon className="w-4 h-4 text-red-500" />
      </div>
      
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-sophia-text">{config.title}</p>
        <div className="mt-3">
          {onRetry && config.retryable && (
            <RetryAction
              message={message}
              onRetry={onRetry}
              onDismiss={onDismiss}
            />
          )}
          {!onRetry && onDismiss && (
            <button
              onClick={onDismiss}
              className="px-3 py-1.5 rounded-lg text-xs text-sophia-text2 hover:bg-sophia-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
