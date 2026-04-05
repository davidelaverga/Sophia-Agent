/**
 * ProtectedRoute Component
 * 
 * Wraps pages that require authentication and consent.
 * Flow: Discord Auth → Consent Gate → Protected Content
 * 
 * Use this component to protect any route that requires user authentication.
 */

'use client';

import { useState, useCallback } from 'react';
import { AuthGate } from './AuthGate';
import { ConsentGate } from './ConsentGate';
import { ErrorBoundary } from './ErrorBoundary';
import { OnboardingOrchestrator } from './onboarding/OnboardingOrchestrator';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Skip consent gate (for pages that don't need it) */
  skipConsent?: boolean;
}

export function ProtectedRoute({ children, skipConsent = false }: ProtectedRouteProps) {
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isConsentReady, setIsConsentReady] = useState(skipConsent);

  const handleAuthReady = useCallback(() => {
    setIsAuthReady(true);
  }, []);

  const handleConsentReady = useCallback(() => {
    setIsConsentReady(true);
  }, []);

  // Flow: Auth → Consent → Content
  // ConsentGate only shows after auth is complete (unless skipped)
  const showConsentGate = isAuthReady && !isConsentReady && !skipConsent;
  const showContent = isAuthReady && isConsentReady;

  return (
    <AuthGate onAuthenticated={handleAuthReady}>
      {showConsentGate && (
        <ConsentGate onReady={handleConsentReady} />
      )}
      {showContent && (
        <>
          {children}
          <ErrorBoundary componentName="OnboardingOrchestrator">
            <OnboardingOrchestrator />
          </ErrorBoundary>
        </>
      )}
    </AuthGate>
  );
}
