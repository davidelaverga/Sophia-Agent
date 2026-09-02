/**
 * ProtectedRoute Component
 * 
 * Wraps pages that require authentication and consent.
 * Flow: Discord Auth → Consent Gate → Protected Content
 * 
 * Use this component to protect any route that requires user authentication.
 */

'use client';

import { useCallback, useLayoutEffect, useState } from 'react';

import { authBypassEnabled } from '../lib/auth/dev-bypass';

import { AuthGate } from './AuthGate';
import { ConsentGate } from './ConsentGate';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Skip consent gate (for pages that don't need it) */
  skipConsent?: boolean;
}

const CONSENT_CACHE_KEY = 'sophia_consent_accepted';

function hasCachedConsent(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(CONSENT_CACHE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function ProtectedRoute({ children, skipConsent = false }: ProtectedRouteProps) {
  const [isConsentReady, setIsConsentReady] = useState(skipConsent);

  // ConsentGate deliberately renders nothing when the durable consent cache is
  // already satisfied, then announces readiness from a passive effect. A
  // client-route recovery can otherwise commit an authenticated but empty
  // protected shell when another passive effect aborts that handoff. Resolve
  // the same durable signal in a layout effect so protected content is released
  // before paint without making the server and hydration renders disagree.
  useLayoutEffect(() => {
    if (!isConsentReady && (skipConsent || authBypassEnabled || hasCachedConsent())) {
      setIsConsentReady(true);
    }
  }, [isConsentReady, skipConsent]);

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
