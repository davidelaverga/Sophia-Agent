/**
 * Granular Error Boundaries for Critical Components
 * P0 - Prevents full app crash from component-level errors
 * 
 * Each boundary has contextual fallback UI and recovery options.
 */

'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../lib/error-logger';

// =============================================================================
// BUTTON COMPONENT (inline to avoid external dependency)
// =============================================================================

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

function Button({ variant = 'primary', size = 'md', className = '', children, ...props }: ButtonProps) {
  const baseStyles = 'inline-flex items-center justify-center rounded-xl font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/40';
  
  const variants = {
    primary: 'bg-sophia-purple text-white hover:bg-sophia-purple/90',
    outline: 'border border-sophia-surface-border bg-sophia-surface text-sophia-text hover:bg-sophia-button-hover',
    ghost: 'text-sophia-text2 hover:bg-sophia-surface hover:text-sophia-text',
  };
  
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };
  
  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

// =============================================================================
// BASE BOUNDARY CLASS
// =============================================================================

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface BaseErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
}

abstract class BaseErrorBoundary<P extends BaseErrorBoundaryProps> extends Component<P, ErrorBoundaryState> {
  abstract componentName: string;
  
  constructor(props: P) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }
  
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    
    logger.error(error, { 
      component: this.componentName,
      metadata: {
        componentStack: errorInfo.componentStack,
      },
    });
    
    this.props.onError?.(error, errorInfo);
  }
  
  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };
  
  abstract renderFallback(): ReactNode;
  
  render(): ReactNode {
    if (this.state.hasError) {
      return this.renderFallback();
    }
    return this.props.children;
  }
}

// =============================================================================
// CONVERSATION VIEW BOUNDARY
// =============================================================================

interface ConversationBoundaryProps extends BaseErrorBoundaryProps {
  onRetrySession?: () => void;
}

export class ConversationErrorBoundary extends BaseErrorBoundary<ConversationBoundaryProps> {
  componentName = 'ConversationView';
  
  renderFallback(): ReactNode {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <div className="mb-4 text-4xl">💬</div>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          Chat Temporarily Unavailable
        </h2>
        <p className="text-muted-foreground mb-4 max-w-md">
          Something went wrong loading the conversation. Your messages are safe.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={this.handleReset}>
            Try Again
          </Button>
          {this.props.onRetrySession && (
            <Button onClick={this.props.onRetrySession}>
              Restart Session
            </Button>
          )}
        </div>
        {process.env.NODE_ENV === 'development' && this.state.error && (
          <pre className="mt-4 p-2 bg-destructive/10 rounded text-xs text-left max-w-md overflow-auto">
            {this.state.error.message}
          </pre>
        )}
      </div>
    );
  }
}

// =============================================================================
// MESSAGE LIST BOUNDARY
// =============================================================================

interface MessageListBoundaryProps extends BaseErrorBoundaryProps {
  messageCount?: number;
}

export class MessageListErrorBoundary extends BaseErrorBoundary<MessageListBoundaryProps> {
  componentName = 'MessageList';
  
  renderFallback(): ReactNode {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <div className="mb-3 text-3xl opacity-60">📋</div>
        <p className="text-sm text-muted-foreground mb-3">
          Unable to display messages
        </p>
        <Button variant="ghost" size="sm" onClick={this.handleReset}>
          Refresh Messages
        </Button>
      </div>
    );
  }
}

// =============================================================================
// VOICE COMPOSER BOUNDARY
// =============================================================================

export class VoiceComposerErrorBoundary extends BaseErrorBoundary<BaseErrorBoundaryProps> {
  componentName = 'VoiceComposer';
  
  renderFallback(): ReactNode {
    return (
      <div className="flex items-center justify-center p-4 bg-muted/50 rounded-lg">
        <div className="text-center">
          <div className="mb-2 text-2xl">🎤</div>
          <p className="text-sm text-muted-foreground mb-2">
            Voice input unavailable
          </p>
          <Button variant="ghost" size="sm" onClick={this.handleReset}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
}

// =============================================================================
// ARTIFACTS PANEL BOUNDARY
// =============================================================================

export class ArtifactsPanelErrorBoundary extends BaseErrorBoundary<BaseErrorBoundaryProps> {
  componentName = 'ArtifactsPanel';
  
  renderFallback(): ReactNode {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <div className="mb-3 text-3xl">📊</div>
        <h3 className="font-medium text-foreground mb-1">
          Panel Error
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Artifacts couldn&apos;t be loaded
        </p>
        <Button variant="outline" size="sm" onClick={this.handleReset}>
          Reload Panel
        </Button>
      </div>
    );
  }
}

// =============================================================================
// INTERRUPT CARD BOUNDARY
// =============================================================================

interface InterruptBoundaryProps extends BaseErrorBoundaryProps {
  onDismiss?: () => void;
}

export class InterruptCardErrorBoundary extends BaseErrorBoundary<InterruptBoundaryProps> {
  componentName = 'InterruptCard';
  
  renderFallback(): ReactNode {
    return (
      <div className="fixed inset-x-4 top-20 z-50 mx-auto max-w-md">
        <div className="bg-background border border-border rounded-lg p-4 shadow-lg">
          <p className="text-sm text-muted-foreground mb-2">
            Notification error
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={this.handleReset}>
              Retry
            </Button>
            {this.props.onDismiss && (
              <Button variant="ghost" size="sm" onClick={this.props.onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

// =============================================================================
// SESSION PAGE BOUNDARY
// =============================================================================

interface SessionPageBoundaryProps extends BaseErrorBoundaryProps {
  onNavigateHome?: () => void;
}

export class SessionPageErrorBoundary extends BaseErrorBoundary<SessionPageBoundaryProps> {
  componentName = 'SessionPage';
  
  renderFallback(): ReactNode {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-background">
        <div className="mb-6 text-6xl">🔄</div>
        <h1 className="text-2xl font-bold text-foreground mb-3">
          Session Error
        </h1>
        <p className="text-muted-foreground mb-6 max-w-md">
          Something unexpected happened. Don&apos;t worry, your data is saved.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={this.handleReset}>
            Try Again
          </Button>
          {this.props.onNavigateHome && (
            <Button onClick={this.props.onNavigateHome}>
              Return Home
            </Button>
          )}
        </div>
        {process.env.NODE_ENV === 'development' && this.state.error && (
          <details className="mt-6 text-left max-w-lg">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Error Details
            </summary>
            <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-auto">
              {this.state.error.stack}
            </pre>
          </details>
        )}
      </div>
    );
  }
}

// =============================================================================
// GENERIC BOUNDARY WITH CUSTOM FALLBACK
// =============================================================================

interface GenericBoundaryProps extends BaseErrorBoundaryProps {
  fallback?: ReactNode | ((error: Error | null, reset: () => void) => ReactNode);
  componentLabel?: string;
}

export class GenericErrorBoundary extends BaseErrorBoundary<GenericBoundaryProps> {
  get componentName(): string {
    return this.props.componentLabel || 'GenericComponent';
  }
  
  renderFallback(): ReactNode {
    const { fallback } = this.props;
    
    if (typeof fallback === 'function') {
      return fallback(this.state.error, this.handleReset);
    }
    
    if (fallback) {
      return fallback;
    }
    
    // Default minimal fallback
    return (
      <div className="p-4 text-center text-muted-foreground">
        <p className="mb-2">Something went wrong</p>
        <Button variant="ghost" size="sm" onClick={this.handleReset}>
          Retry
        </Button>
      </div>
    );
  }
}
