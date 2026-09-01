/**
 * ProtectedRoute Component
 * 
 * Wraps pages that require authentication and consent.
 * Flow: Discord Auth → Consent Gate → Protected Content
 * 
 * Use this component to protect any route that requires user authentication.
 */

'use client';

import { useCallback, useState } from 'react';

import { AuthGate } from './AuthGate';
import { ConsentGate } from './ConsentGate';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Skip consent gate (for pages that don't need it) */
  skipConsent?: boolean;
}

export function ProtectedRoute({ children, skipConsent = false }: ProtectedRouteProps) {
  const [isConsentReady, setIsConsentReady] = useState(skipConsent);

  const handleConsentReady = useCallback(() => {
    setIsConsentReady(true);
  }, []);

  // AuthGate is already the authoritative authentication boundary: it renders
  // none of these children until its session is authenticated. Keeping a
  // second effect-driven auth flag here can strand the protected route as an
  // empty shell even after AuthGate has released it. Once this subtree exists,
  // only consent remains to be resolved.
  const showConsentGate = !isConsentReady && !skipConsent;

  return (
    <AuthGate>
      {showConsentGate && (
        <ConsentGate onReady={handleConsentReady} />
      )}
      {isConsentReady && (
        <>
          {children}
        </>
      )}
    </AuthGate>
  );
}
